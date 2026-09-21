import {
  type Note,
  noteDecisionSchema,
  noteHistoryActionSchema,
  type ProvenanceSpan,
  saveNoteSchema,
} from '@walden/contracts';
import { applyAgentProvenance, soleInsertion } from '@walden/domain';
import { Hono } from 'hono';
import { z } from 'zod';
import { all, first, parseJson } from '../db/client';
import { HttpError, jsonBody, newId, nowIso } from '../http';
import type { Bindings, Variables } from '../types';
import { assertValidProvenance } from './domain';
import { applySuggestionPatch, loadNoteState } from './history';
import { loadNoteAdditionQueue, SELECT_SUGGESTION, type SuggestionRow } from './suggestions';

type NoteRow = {
  id: string;
  title: string;
  markdown: string;
  revision: number;
  provenance_json: string;
  created_at: string;
  updated_at: string;
};
type SuggestionChange = {
  id: string;
  beforeStatus: string;
  afterStatus: string;
};
const toNote = (row: NoteRow): Note => ({
  id: row.id,
  title: row.title,
  markdown: row.markdown,
  revision: row.revision,
  provenance: parseJson<ProvenanceSpan[]>(row.provenance_json, []),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const selectNote = (db: D1Database, ownerId: string, id: string) =>
  first<NoteRow>(
    db
      .prepare(
        // The note's own title is the source of truth. This used to read the
        // owning conversation's title instead, so a rename written to
        // notes.title was invisible here while /state showed it — two endpoints
        // disagreeing about the same field. The conversation title remains the
        // fallback for notes that predate having one of their own.
        `SELECT n.id,COALESCE(NULLIF(TRIM(n.title),''),(SELECT c.title FROM conversations c WHERE c.note_id=n.id AND c.owner_id=n.owner_id ORDER BY c.last_user_activity_at DESC LIMIT 1),'Untitled note') AS title,n.markdown,n.revision,n.provenance_json,n.created_at,n.updated_at FROM notes n WHERE n.id=? AND n.owner_id=?`,
      )
      .bind(id, ownerId),
  );
const createNoteSchema = z.object({ markdown: z.string().max(200_000).optional() }).strict();
const renameNoteSchema = z.object({ title: z.string().min(1).max(120) }).strict();
const exportFilename = (title: string) => {
  const base = title.trim() || 'note';
  const ascii =
    base
      .normalize('NFKD')
      .replace(/[^\x20-\x7E]/g, '')
      .replace(/["\\/;=]/g, '_')
      .trim()
      .slice(0, 120) || 'note';
  const encoded = encodeURIComponent(base.slice(0, 120)).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}.md"; filename*=UTF-8''${encoded}.md`;
};

export const notesRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

notesRoutes.get('/', async (c) =>
  c.json(
    (
      await all<NoteRow>(
        c.env.DB.prepare(
          `SELECT n.id,COALESCE(NULLIF(TRIM(n.title),''),(SELECT c.title FROM conversations c WHERE c.note_id=n.id AND c.owner_id=n.owner_id ORDER BY c.last_user_activity_at DESC LIMIT 1),'Untitled note') AS title,n.markdown,n.revision,n.provenance_json,n.created_at,n.updated_at FROM notes n WHERE n.owner_id=? ORDER BY n.updated_at DESC`,
        ).bind(c.get('userId')),
      )
    ).map(toNote),
  ),
);

notesRoutes.post('/', async (c) => {
  const parsed = createNoteSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new HttpError(400, 'Invalid note', parsed.error.flatten());
  const body = parsed.data;
  const now = nowIso();
  const note: Note = {
    id: newId(),
    title: 'Untitled note',
    markdown: body.markdown ?? '',
    revision: 0,
    provenance: [],
    createdAt: now,
    updatedAt: now,
  };
  await c.env.DB.prepare(
    'INSERT INTO notes (id,owner_id,markdown,revision,provenance_json,created_at,updated_at,title) VALUES (?,?,?,?,?,?,?,?)',
  )
    .bind(note.id, c.get('userId'), note.markdown, 0, '[]', now, now, note.title)
    .run();
  return c.json(note, 201);
});

/**
 * Rename a note. The note owns its name, so this is a plain metadata update: it
 * does not touch the markdown, bump the content revision, or enter the undo
 * chain, which exists to make text edits reversible.
 */
notesRoutes.patch('/:id/title', async (c) => {
  const parsed = renameNoteSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new HttpError(400, 'Invalid note title', parsed.error.flatten());
  const title = parsed.data.title.replace(/\s+/gu, ' ').trim();
  const result = await c.env.DB.prepare(
    'UPDATE notes SET title=?,updated_at=? WHERE id=? AND owner_id=?',
  )
    .bind(title, nowIso(), c.req.param('id'), c.get('userId'))
    .run();
  if (result.meta.changes !== 1) throw new HttpError(404, 'Note not found');
  return c.json({ title });
});

notesRoutes.get('/:id', async (c) => {
  const row = await selectNote(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!row) throw new HttpError(404, 'Note not found');
  return c.json(toNote(row));
});

notesRoutes.get('/:id/export', async (c) => {
  const row = await selectNote(c.env.DB, c.get('userId'), c.req.param('id'));
  if (!row) throw new HttpError(404, 'Note not found');
  return new Response(row.markdown, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': exportFilename(row.title),
    },
  });
});

notesRoutes.patch('/:id', async (c) => {
  const parsed = saveNoteSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new HttpError(400, 'Invalid note save', parsed.error.flatten());
  const ownerId = c.get('userId');
  const noteId = c.req.param('id');
  const existingOperation = await first<{ result_revision: number }>(
    c.env.DB.prepare(
      'SELECT result_revision FROM note_edits WHERE owner_id=? AND note_id=? AND operation_id=?',
    ).bind(ownerId, noteId, parsed.data.operationId),
  );
  if (existingOperation) {
    const replay = await selectNote(c.env.DB, ownerId, noteId);
    if (!replay) throw new HttpError(404, 'Note not found');
    return c.json(toNote(replay));
  }
  const current = await selectNote(c.env.DB, ownerId, noteId);
  if (!current) throw new HttpError(404, 'Note not found');
  if (current.revision !== parsed.data.baseRevision)
    throw new HttpError(409, 'Note revision conflict', { currentRevision: current.revision });
  const dismissedSuggestionIds = [
    ...new Set([
      ...(parsed.data.dismissSuggestionIds ?? []),
      ...(parsed.data.dismissSuggestionId ? [parsed.data.dismissSuggestionId] : []),
    ]),
  ];
  if (dismissedSuggestionIds.length > 20)
    throw new HttpError(400, 'Too many suggestions to dismiss');
  const dismissedSuggestions = await Promise.all(
    dismissedSuggestionIds.map((id) =>
      first<{ id: string; status: string }>(
        c.env.DB.prepare(
          'SELECT id,status FROM note_suggestions WHERE id=? AND note_id=? AND owner_id=?',
        ).bind(id, noteId, ownerId),
      ),
    ),
  );
  if (dismissedSuggestions.some((suggestion) => suggestion?.status !== 'pending'))
    throw new HttpError(409, 'Suggestion is no longer pending');
  const suggestionChanges = dismissedSuggestionIds.map((id) => ({
    id,
    beforeStatus: 'pending',
    afterStatus: 'dismissed',
  }));
  assertValidProvenance(parsed.data.markdown, parsed.data.provenance);
  const now = nowIso();
  const title = current.title;
  const provenanceJson = JSON.stringify(parsed.data.provenance);
  const resultRevision = current.revision + 1;
  let results: D1Result[];
  try {
    results = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO note_edits (id,note_id,owner_id,operation_id,base_revision,result_revision,before_title,before_markdown,before_provenance_json,after_title,after_markdown,after_provenance_json,kind,suggestion_id,before_suggestion_status,after_suggestion_status,created_at,suggestion_changes_json) SELECT ?,id,owner_id,?,revision,revision+1,?,markdown,provenance_json,?,?,?,'user_edit',? ,?,?,?,? FROM notes WHERE id=? AND owner_id=? AND revision=?${dismissedSuggestionIds.length ? ` AND (SELECT COUNT(*) FROM note_suggestions WHERE note_id=notes.id AND owner_id=notes.owner_id AND status='pending' AND id IN (${dismissedSuggestionIds.map(() => '?').join(',')}))=?` : ''}`,
      ).bind(
        newId(),
        parsed.data.operationId,
        title,
        title,
        parsed.data.markdown,
        provenanceJson,
        dismissedSuggestionIds.length === 1 ? dismissedSuggestionIds[0] : null,
        dismissedSuggestionIds.length === 1 ? 'pending' : null,
        dismissedSuggestionIds.length === 1 ? 'dismissed' : null,
        now,
        suggestionChanges.length ? JSON.stringify(suggestionChanges) : null,
        noteId,
        ownerId,
        current.revision,
        ...dismissedSuggestionIds,
        ...(dismissedSuggestionIds.length ? [dismissedSuggestionIds.length] : []),
      ),
      c.env.DB.prepare(
        'UPDATE notes SET markdown=?,provenance_json=?,revision=?,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND EXISTS (SELECT 1 FROM note_edits WHERE owner_id=? AND note_id=? AND operation_id=?)',
      ).bind(
        parsed.data.markdown,
        provenanceJson,
        resultRevision,
        now,
        noteId,
        ownerId,
        current.revision,
        ownerId,
        noteId,
        parsed.data.operationId,
      ),
      ...dismissedSuggestionIds.map((suggestionId) =>
        c.env.DB.prepare(
          "UPDATE note_suggestions SET status='dismissed',decided_at=?,updated_at=? WHERE id=? AND note_id=? AND owner_id=? AND status='pending' AND EXISTS (SELECT 1 FROM note_edits WHERE owner_id=? AND note_id=? AND operation_id=?)",
        ).bind(now, now, suggestionId, noteId, ownerId, ownerId, noteId, parsed.data.operationId),
      ),
      c.env.DB.prepare(
        'UPDATE note_edits SET discarded=1 WHERE note_id=? AND owner_id=? AND undone=1 AND discarded=0 AND operation_id<>? AND EXISTS (SELECT 1 FROM note_edits WHERE owner_id=? AND note_id=? AND operation_id=?)',
      ).bind(noteId, ownerId, parsed.data.operationId, ownerId, noteId, parsed.data.operationId),
    ]);
  } catch {
    const replayed = await first<{ result_revision: number }>(
      c.env.DB.prepare(
        'SELECT result_revision FROM note_edits WHERE owner_id=? AND note_id=? AND operation_id=?',
      ).bind(ownerId, noteId, parsed.data.operationId),
    );
    if (replayed) {
      const replay = await selectNote(c.env.DB, ownerId, noteId);
      if (replay) return c.json(toNote(replay));
    }
    throw new HttpError(409, 'Note revision conflict');
  }
  if (
    results[0]?.meta.changes !== 1 ||
    results[1]?.meta.changes !== 1 ||
    results.slice(2, 2 + dismissedSuggestionIds.length).some((result) => result.meta.changes !== 1)
  ) {
    const latest = await selectNote(c.env.DB, ownerId, noteId);
    throw new HttpError(
      409,
      'Note revision conflict',
      latest ? { currentRevision: latest.revision } : undefined,
    );
  }
  return c.json(
    toNote({
      ...current,
      title,
      markdown: parsed.data.markdown,
      provenance_json: provenanceJson,
      revision: resultRevision,
      updated_at: now,
    }),
  );
});

notesRoutes.get('/:id/state', async (c) =>
  c.json(await loadNoteState(c.env.DB, c.get('userId'), c.req.param('id'))),
);

notesRoutes.post('/:id/suggestions/:suggestionId/decision', async (c) => {
  const parsed = noteDecisionSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new HttpError(400, 'Invalid suggestion decision');
  const ownerId = c.get('userId');
  const noteId = c.req.param('id');
  const replay = await first<{ action: string; base_revision: number }>(
    c.env.DB.prepare(
      'SELECT action,base_revision FROM note_history_requests WHERE owner_id=? AND note_id=? AND operation_id=?',
    ).bind(ownerId, noteId, parsed.data.operationId),
  );
  if (replay) {
    if (
      replay.action !== `${parsed.data.decision}:${c.req.param('suggestionId')}` ||
      replay.base_revision !== parsed.data.baseRevision
    )
      throw new HttpError(409, 'Operation ID was already used');
    return c.json(await loadNoteState(c.env.DB, ownerId, noteId));
  }
  const state = await loadNoteState(c.env.DB, ownerId, noteId);
  if (parsed.data.decision !== 'accept' && state.note.revision !== parsed.data.baseRevision)
    throw new HttpError(409, 'Note revision conflict', { currentRevision: state.note.revision });
  const suggestion = await first<SuggestionRow & { base_markdown: string }>(
    c.env.DB.prepare(`${SELECT_SUGGESTION} WHERE id=? AND note_id=? AND owner_id=?`).bind(
      c.req.param('suggestionId'),
      noteId,
      ownerId,
    ),
  );
  if (!suggestion) throw new HttpError(404, 'Suggestion not found');
  if (suggestion.status !== 'pending') throw new HttpError(409, 'Suggestion is no longer pending');
  // The reviewed markdown is authoritative for an addition's position. If it
  // no longer describes exactly this suggestion, require a refreshed preview.
  const offered =
    parsed.data.decision === 'accept' &&
    suggestion.old_text === '' &&
    parsed.data.markdown !== undefined
      ? soleInsertion(state.note.markdown, parsed.data.markdown)
      : null;
  const submitted =
    offered && offered.insert.trim() === suggestion.new_text.trim() ? offered : null;
  if (
    parsed.data.decision === 'accept' &&
    parsed.data.markdown !== undefined &&
    suggestion.old_text === '' &&
    !submitted
  )
    throw new HttpError(409, 'Suggestion preview changed. Refresh the note and review it again.');
  const after =
    parsed.data.decision === 'accept'
      ? submitted
        ? {
            markdown: parsed.data.markdown as string,
            provenance: applyAgentProvenance(state.note.provenance, submitted, suggestion.id),
          }
        : applySuggestionPatch(
            state.note,
            {
              id: suggestion.id,
              oldText: suggestion.old_text,
              newText: suggestion.new_text,
              reason: suggestion.reason,
            },
            await loadNoteAdditionQueue(c.env.DB, ownerId, noteId),
          )
      : { markdown: state.note.markdown, provenance: state.note.provenance };
  if (
    parsed.data.decision === 'accept' &&
    parsed.data.markdown !== undefined &&
    after.markdown !== parsed.data.markdown
  )
    throw new HttpError(409, 'Suggestion preview changed. Refresh the note and review it again.');
  const now = nowIso();
  const editId = newId();
  const afterProvenance = JSON.stringify(after.provenance);
  let results: D1Result[];
  try {
    results = await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO note_history_requests (owner_id,note_id,operation_id,action,base_revision,edit_id,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM notes n JOIN note_suggestions s ON s.note_id=n.id AND s.owner_id=n.owner_id WHERE n.id=? AND n.owner_id=? AND n.revision=? AND n.markdown=? AND s.id=? AND s.status='pending')",
      ).bind(
        ownerId,
        noteId,
        parsed.data.operationId,
        `${parsed.data.decision}:${suggestion.id}`,
        parsed.data.baseRevision,
        editId,
        now,
        noteId,
        ownerId,
        state.note.revision,
        state.note.markdown,
        suggestion.id,
      ),
      c.env.DB.prepare(
        `INSERT INTO note_edits (id,note_id,owner_id,operation_id,base_revision,result_revision,before_title,before_markdown,before_provenance_json,after_title,after_markdown,after_provenance_json,kind,suggestion_id,before_suggestion_status,after_suggestion_status,created_at)
       SELECT ?,n.id,n.owner_id,?,n.revision,n.revision+1,?,n.markdown,n.provenance_json,?,?,?,?,?,'pending',?,? FROM notes n JOIN note_suggestions s ON s.note_id=n.id AND s.owner_id=n.owner_id
       WHERE n.id=? AND n.owner_id=? AND n.revision=? AND n.markdown=? AND s.id=? AND s.status='pending'
       AND EXISTS (SELECT 1 FROM note_history_requests WHERE owner_id=n.owner_id AND note_id=n.id AND operation_id=? AND edit_id=?)`,
      ).bind(
        editId,
        parsed.data.operationId,
        state.note.title,
        state.note.title,
        after.markdown,
        afterProvenance,
        `suggestion_${parsed.data.decision}`,
        suggestion.id,
        parsed.data.decision === 'accept' ? 'accepted' : 'dismissed',
        now,
        noteId,
        ownerId,
        state.note.revision,
        state.note.markdown,
        suggestion.id,
        parsed.data.operationId,
        editId,
      ),
      c.env.DB.prepare(
        'UPDATE notes SET markdown=?,provenance_json=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND EXISTS (SELECT 1 FROM note_edits WHERE id=? AND owner_id=?)',
      ).bind(
        after.markdown,
        afterProvenance,
        now,
        noteId,
        ownerId,
        state.note.revision,
        editId,
        ownerId,
      ),
      c.env.DB.prepare(
        "UPDATE note_suggestions SET status=?,decision_edit_id=?,decided_at=?,updated_at=? WHERE id=? AND note_id=? AND owner_id=? AND status='pending' AND EXISTS (SELECT 1 FROM note_edits WHERE id=? AND owner_id=?)",
      ).bind(
        parsed.data.decision === 'accept' ? 'accepted' : 'dismissed',
        editId,
        now,
        now,
        suggestion.id,
        noteId,
        ownerId,
        editId,
        ownerId,
      ),
      c.env.DB.prepare(
        'UPDATE note_edits SET discarded=1 WHERE note_id=? AND owner_id=? AND undone=1 AND discarded=0 AND id<>? AND EXISTS (SELECT 1 FROM note_edits WHERE id=? AND owner_id=?)',
      ).bind(noteId, ownerId, editId, editId, ownerId),
    ]);
  } catch {
    const raced = await first<{ action: string; base_revision: number }>(
      c.env.DB.prepare(
        'SELECT action,base_revision FROM note_history_requests WHERE owner_id=? AND note_id=? AND operation_id=?',
      ).bind(ownerId, noteId, parsed.data.operationId),
    );
    if (
      raced?.action === `${parsed.data.decision}:${suggestion.id}` &&
      raced.base_revision === parsed.data.baseRevision
    )
      return c.json(await loadNoteState(c.env.DB, ownerId, noteId));
    throw new HttpError(409, 'Note or suggestion changed');
  }
  if (results.slice(0, 4).some((result) => result.meta.changes !== 1))
    throw new HttpError(409, 'Note or suggestion changed');
  return c.json(await loadNoteState(c.env.DB, ownerId, noteId));
});

async function moveHistory(
  db: D1Database,
  ownerId: string,
  noteId: string,
  direction: 'undo' | 'redo',
  body: unknown,
) {
  const parsed = noteHistoryActionSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, `Invalid ${direction} request`);
  const replay = await first<{ action: string; base_revision: number }>(
    db
      .prepare(
        'SELECT action,base_revision FROM note_history_requests WHERE owner_id=? AND note_id=? AND operation_id=?',
      )
      .bind(ownerId, noteId, parsed.data.operationId),
  );
  if (replay) {
    if (replay.action !== direction || replay.base_revision !== parsed.data.baseRevision)
      throw new HttpError(409, 'Operation ID was already used');
    return loadNoteState(db, ownerId, noteId);
  }
  const state = await loadNoteState(db, ownerId, noteId);
  if (state.note.revision !== parsed.data.baseRevision)
    throw new HttpError(409, 'Note revision conflict', { currentRevision: state.note.revision });
  const undo = direction === 'undo';
  const edit = await first<{
    id: string;
    suggestion_id: string | null;
    before_markdown: string;
    before_provenance_json: string;
    after_markdown: string;
    after_provenance_json: string;
    before_suggestion_status: string | null;
    after_suggestion_status: string | null;
    suggestion_changes_json: string | null;
  }>(
    db
      .prepare(
        `SELECT id,suggestion_id,before_markdown,before_provenance_json,after_markdown,after_provenance_json,before_suggestion_status,after_suggestion_status,suggestion_changes_json
       FROM note_edits WHERE note_id=? AND owner_id=? AND undone=? AND discarded=0 ORDER BY result_revision ${undo ? 'DESC' : 'ASC'} LIMIT 1`,
      )
      .bind(noteId, ownerId, undo ? 0 : 1),
  );
  if (!edit) throw new HttpError(409, `Nothing to ${direction}`);
  const expectedMarkdown = undo ? edit.after_markdown : edit.before_markdown;
  const markdown = undo ? edit.before_markdown : edit.after_markdown;
  const provenance = undo ? edit.before_provenance_json : edit.after_provenance_json;
  if (state.note.markdown !== expectedMarkdown) throw new HttpError(409, 'Note history diverged');
  const now = nowIso();
  const legacySuggestionChanges =
    edit.suggestion_id && edit.before_suggestion_status && edit.after_suggestion_status
      ? [
          {
            id: edit.suggestion_id,
            beforeStatus: edit.before_suggestion_status,
            afterStatus: edit.after_suggestion_status,
          },
        ]
      : [];
  const suggestionChanges = parseJson<SuggestionChange[]>(
    edit.suggestion_changes_json ?? '',
    legacySuggestionChanges,
  );
  const currentSuggestionStatuses = await Promise.all(
    suggestionChanges.map((change) =>
      first<{ status: string }>(
        db
          .prepare('SELECT status FROM note_suggestions WHERE id=? AND note_id=? AND owner_id=?')
          .bind(change.id, noteId, ownerId),
      ),
    ),
  );
  if (
    currentSuggestionStatuses.some(
      (suggestion, index) =>
        suggestion?.status !==
        (undo ? suggestionChanges[index]?.afterStatus : suggestionChanges[index]?.beforeStatus),
    )
  )
    throw new HttpError(409, 'Note history changed');
  if (undo) {
    for (const change of suggestionChanges) {
      if (change.beforeStatus !== 'pending') continue;
      const newerPending = await first<{ id: string }>(
        db
          .prepare(
            `SELECT newer.id FROM note_suggestions target
           JOIN note_suggestions newer ON newer.owner_id=target.owner_id
             AND newer.conversation_id=target.conversation_id
             AND newer.source_message_id=target.source_message_id
           WHERE target.id=? AND target.note_id=? AND target.owner_id=?
             AND newer.id<>target.id AND newer.status='pending'
             AND (newer.created_at>target.created_at OR (newer.created_at=target.created_at AND newer.id>target.id))
           LIMIT 1`,
          )
          .bind(change.id, noteId, ownerId),
      );
      if (newerPending)
        throw new HttpError(409, 'Resolve the newer note suggestion before undoing this decision.');
    }
  }
  const statements = [
    db
      .prepare(
        'INSERT INTO note_history_requests (owner_id,note_id,operation_id,action,base_revision,edit_id,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM notes WHERE id=? AND owner_id=? AND revision=? AND markdown=?) AND EXISTS (SELECT 1 FROM note_edits WHERE id=? AND owner_id=? AND undone=? AND discarded=0)',
      )
      .bind(
        ownerId,
        noteId,
        parsed.data.operationId,
        direction,
        state.note.revision,
        edit.id,
        now,
        noteId,
        ownerId,
        state.note.revision,
        expectedMarkdown,
        edit.id,
        ownerId,
        undo ? 0 : 1,
      ),
    db
      .prepare(
        `UPDATE note_edits SET undone=?,undone_at=? WHERE id=? AND owner_id=? AND undone=? AND discarded=0 AND EXISTS (SELECT 1 FROM notes WHERE id=? AND owner_id=? AND revision=? AND markdown=?) AND EXISTS (SELECT 1 FROM note_history_requests WHERE owner_id=? AND note_id=? AND operation_id=? AND edit_id=?)`,
      )
      .bind(
        undo ? 1 : 0,
        undo ? now : null,
        edit.id,
        ownerId,
        undo ? 0 : 1,
        noteId,
        ownerId,
        state.note.revision,
        expectedMarkdown,
        ownerId,
        noteId,
        parsed.data.operationId,
        edit.id,
      ),
    db
      .prepare(
        'UPDATE notes SET markdown=?,provenance_json=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND EXISTS (SELECT 1 FROM note_edits WHERE id=? AND owner_id=? AND undone=?) AND EXISTS (SELECT 1 FROM note_history_requests WHERE owner_id=? AND note_id=? AND operation_id=? AND edit_id=?)',
      )
      .bind(
        markdown,
        provenance,
        now,
        noteId,
        ownerId,
        state.note.revision,
        edit.id,
        ownerId,
        undo ? 1 : 0,
        ownerId,
        noteId,
        parsed.data.operationId,
        edit.id,
      ),
    ...suggestionChanges.map((change) => {
      const status = undo ? change.beforeStatus : change.afterStatus;
      const expectedStatus = undo ? change.afterStatus : change.beforeStatus;
      return db
        .prepare(
          'UPDATE note_suggestions SET status=?,updated_at=?,decided_at=? WHERE id=? AND note_id=? AND owner_id=? AND status=? AND EXISTS (SELECT 1 FROM note_edits WHERE id=? AND owner_id=? AND undone=?) AND EXISTS (SELECT 1 FROM note_history_requests WHERE owner_id=? AND note_id=? AND operation_id=? AND edit_id=?)',
        )
        .bind(
          status,
          now,
          status === 'pending' ? null : now,
          change.id,
          noteId,
          ownerId,
          expectedStatus,
          edit.id,
          ownerId,
          undo ? 1 : 0,
          ownerId,
          noteId,
          parsed.data.operationId,
          edit.id,
        );
    }),
  ];
  let results: D1Result[];
  try {
    results = await db.batch(statements);
  } catch {
    const raced = await first<{ action: string; base_revision: number }>(
      db
        .prepare(
          'SELECT action,base_revision FROM note_history_requests WHERE owner_id=? AND note_id=? AND operation_id=?',
        )
        .bind(ownerId, noteId, parsed.data.operationId),
    );
    if (raced?.action === direction && raced.base_revision === parsed.data.baseRevision)
      return loadNoteState(db, ownerId, noteId);
    throw new HttpError(409, 'Note history changed');
  }
  if (results.some((result) => result.meta.changes !== 1))
    throw new HttpError(409, 'Note history changed');
  return loadNoteState(db, ownerId, noteId);
}

notesRoutes.post('/:id/undo', async (c) =>
  c.json(
    await moveHistory(c.env.DB, c.get('userId'), c.req.param('id'), 'undo', await jsonBody(c)),
  ),
);
notesRoutes.post('/:id/redo', async (c) =>
  c.json(
    await moveHistory(c.env.DB, c.get('userId'), c.req.param('id'), 'redo', await jsonBody(c)),
  ),
);

notesRoutes.delete('/:id', async (c) => {
  const result = await c.env.DB.prepare('DELETE FROM notes WHERE id=? AND owner_id=?')
    .bind(c.req.param('id'), c.get('userId'))
    .run();
  if (result.meta.changes !== 1) throw new HttpError(404, 'Note not found');
  return c.body(null, 204);
});

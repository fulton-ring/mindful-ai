import {
  type Note,
  noteDecisionSchema,
  noteHistoryActionSchema,
  saveNoteSchema,
} from '@walden/contracts';
import { Hono } from 'hono';
import { z } from 'zod';
import { all } from '../db/client';
import { HttpError, newId, nowIso, parseBody } from '../http';
import type { Bindings, Variables } from '../types';
import { loadNoteState } from './history/history';
import { moveNoteHistory } from './history/history-actions';
import {
  DEFAULT_NOTE_TITLE,
  insertNoteStatement,
  NOTE_PROJECTION,
  type NoteRow,
  selectNote,
  toNote,
} from './repository';
import { saveNote } from './save-note';
import { decideSuggestion } from './suggestions/suggestion-decisions';

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
          `SELECT ${NOTE_PROJECTION} FROM notes n WHERE n.owner_id=? ORDER BY n.updated_at DESC`,
        ).bind(c.get('userId')),
      )
    ).map(toNote),
  ),
);

notesRoutes.post('/', async (c) => {
  const input = await parseBody(c, createNoteSchema, 'Invalid note');
  const now = nowIso();
  const note: Note = {
    id: newId(),
    title: DEFAULT_NOTE_TITLE,
    markdown: input.markdown ?? '',
    revision: 0,
    provenance: [],
    createdAt: now,
    updatedAt: now,
  };
  await insertNoteStatement(c.env.DB, {
    id: note.id,
    ownerId: c.get('userId'),
    now,
    title: note.title,
    markdown: note.markdown,
  }).run();
  return c.json(note, 201);
});

/** Rename metadata without changing the content revision or undo chain. */
notesRoutes.patch('/:id/title', async (c) => {
  const input = await parseBody(c, renameNoteSchema, 'Invalid note title');
  const title = input.title.replace(/\s+/gu, ' ').trim();
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
  const input = await parseBody(c, saveNoteSchema, 'Invalid note save');
  return c.json(await saveNote(c.env.DB, c.get('userId'), c.req.param('id'), input));
});

notesRoutes.get('/:id/state', async (c) =>
  c.json(await loadNoteState(c.env.DB, c.get('userId'), c.req.param('id'))),
);

notesRoutes.post('/:id/suggestions/:suggestionId/decision', async (c) => {
  const input = await parseBody(c, noteDecisionSchema, 'Invalid suggestion decision');
  return c.json(
    await decideSuggestion(
      c.env.DB,
      c.get('userId'),
      c.req.param('id'),
      c.req.param('suggestionId'),
      input,
    ),
  );
});

notesRoutes.post('/:id/undo', async (c) => {
  const input = await parseBody(c, noteHistoryActionSchema, 'Invalid undo request');
  return c.json(await moveNoteHistory(c.env.DB, c.get('userId'), c.req.param('id'), 'undo', input));
});

notesRoutes.post('/:id/redo', async (c) => {
  const input = await parseBody(c, noteHistoryActionSchema, 'Invalid redo request');
  return c.json(await moveNoteHistory(c.env.DB, c.get('userId'), c.req.param('id'), 'redo', input));
});

notesRoutes.delete('/:id', async (c) => {
  const result = await c.env.DB.prepare('DELETE FROM notes WHERE id=? AND owner_id=?')
    .bind(c.req.param('id'), c.get('userId'))
    .run();
  // D1 includes cascaded note history and link changes in this count.
  if (!result.meta.changes) throw new HttpError(404, 'Note not found');
  return c.body(null, 204);
});

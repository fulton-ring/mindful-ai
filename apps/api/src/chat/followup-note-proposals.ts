import type {
  Conversation,
  EditProposal,
  Message,
  Note,
  NoteProposalEvent,
} from '@walden/contracts';
import { resolveEdit } from '@walden/domain';
import { first, parseJson } from '../db/client';
import { HttpError, newId, nowIso } from '../http';
import { persistNoteSuggestion } from '../notes/suggestions';
import type { AgentService, AgentTurnInput } from '../services/types';
import { loadConversation } from './conversations';

type NoteProposalGeneration = {
  db: D1Database;
  ownerId: string;
  conversation: Conversation;
  assistantMessage: Message;
  note: Note | null;
  input: AgentTurnInput;
  agent: AgentService;
  generationKey: string;
  noteProposalRequested?: boolean;
  requestSignal: AbortSignal;
  waitUntil(task: Promise<void>): void;
};

type PendingSuggestion = {
  id: string;
  ownerId: string;
  conversationId: string;
  sourceMessageId: string;
};

type EmitProposal = (event: NoteProposalEvent) => boolean;

export async function loadNote(
  db: D1Database,
  ownerId: string,
  id: string | null,
  title: string,
): Promise<Note | null> {
  if (!id) return null;
  const row = await first<{
    id: string;
    markdown: string;
    revision: number;
    provenance_json: string;
    created_at: string;
    updated_at: string;
  }>(
    db
      .prepare(
        'SELECT id,markdown,revision,provenance_json,created_at,updated_at FROM notes WHERE id=? AND owner_id=?',
      )
      .bind(id, ownerId),
  );
  if (!row) throw new HttpError(404, 'Note not found');
  return {
    id: row.id,
    title,
    markdown: row.markdown,
    revision: row.revision,
    provenance: parseJson(row.provenance_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function removeCancelledPendingSuggestion(db: D1Database, input: PendingSuggestion) {
  await db
    .prepare(
      `DELETE FROM note_suggestions
       WHERE id=? AND owner_id=? AND conversation_id=? AND source_message_id=? AND status='pending'`,
    )
    .bind(input.id, input.ownerId, input.conversationId, input.sourceMessageId)
    .run();
}

function createAttemptIds(proposalAttemptId: string, generationKey: string) {
  const attempts = new Map<string, { id: string; slot: number }>();
  const attemptIdFor = (proposal: { id: string }, operationIndex?: number) => {
    const existing = attempts.get(proposal.id);
    if (existing) return existing.id;
    const assigned = [...attempts.values()].find((attempt) => attempt.id === proposal.id);
    if (assigned) return assigned.id;
    let slot = operationIndex ?? 0;
    while ([...attempts.values()].some((attempt) => attempt.slot === slot)) slot += 1;
    const id = slot === 0 ? proposalAttemptId : `${proposalAttemptId}:${slot}`;
    attempts.set(proposal.id, { id, slot });
    return id;
  };
  const generationKeyFor = (proposal: { id: string }) => {
    const id = attemptIdFor(proposal);
    const slot = [...attempts.values()].find((attempt) => attempt.id === id)?.slot;
    return slot === 0 || slot === undefined ? generationKey : `${generationKey}:operation:${slot}`;
  };
  return { attemptIdFor, generationKeyFor };
}

type AttemptIds = ReturnType<typeof createAttemptIds>;

function withAttemptIds(event: NoteProposalEvent, ids: AttemptIds): NoteProposalEvent {
  if (event.type === 'preview')
    return {
      ...event,
      proposal: { ...event.proposal, id: ids.attemptIdFor(event.proposal, event.operationIndex) },
    };
  if (event.type !== 'done') return event;
  const proposals = event.proposals?.map((proposal, index) => ({
    ...proposal,
    id: ids.attemptIdFor(proposal, index),
  }));
  return {
    ...event,
    proposal: event.proposal ? { ...event.proposal, id: ids.attemptIdFor(event.proposal) } : null,
    ...(proposals ? { proposals } : {}),
  };
}

async function latestProposalNote(
  generation: NoteProposalGeneration,
  signal: AbortSignal,
  emit: EmitProposal,
): Promise<{ currentNote: Note | null } | null> {
  const { db, ownerId, conversation, assistantMessage } = generation;
  const latest = await loadConversation(db, ownerId, conversation.id, {
    branchId: conversation.branchId,
  });
  const currentNote = await loadNote(db, ownerId, latest.noteId, latest.title);
  if (signal.aborted) return null;
  const sourceStillExists = latest.messages.some(
    (message) =>
      message.id === assistantMessage.id && message.role === 'assistant' && !message.incomplete,
  );
  if (!sourceStillExists || latest.expiresAt <= nowIso() || latest.noteId !== conversation.noteId) {
    emit({ type: 'done', proposal: null });
    return null;
  }
  return { currentNote };
}

function proposalsFrom(event: Extract<NoteProposalEvent, { type: 'done' }>) {
  return event.proposals ?? (event.proposal ? [event.proposal] : []);
}

function validateProposalEdits(proposals: EditProposal[], currentNote: Note | null) {
  for (const proposal of proposals)
    if (proposal.oldText !== '')
      resolveEdit(currentNote?.markdown ?? '', proposal.oldText, proposal.newText);
}

async function persistProposals(
  generation: NoteProposalGeneration,
  proposals: EditProposal[],
  currentNote: Note | null,
  ids: AttemptIds,
  proposalAttemptId: string,
  undelivered: PendingSuggestion[],
) {
  const { db, ownerId, conversation, assistantMessage } = generation;
  const persistedProposals: EditProposal[] = [];
  let expectedNoteId = generation.note?.id ?? null;
  let expectedRevision = currentNote?.revision ?? null;
  for (const proposal of proposals) {
    const persisted = await persistNoteSuggestion(db, {
      ownerId,
      conversationId: conversation.id,
      branchId: conversation.branchId,
      sourceMessageId: assistantMessage.id,
      generationKey: ids.generationKeyFor(proposal),
      attemptId: proposalAttemptId,
      expectedNoteId,
      expectedRevision,
      allowAfterDecision: generation.noteProposalRequested === true,
      proposal: {
        ...proposal,
        noteId: expectedNoteId ?? proposal.noteId,
        baseRevision: currentNote?.revision ?? 0,
      },
    });
    expectedNoteId = persisted.noteId;
    expectedRevision ??= persisted.suggestion.baseRevision;
    persistedProposals.push(persisted.suggestion);
    if (persisted.created)
      undelivered.push({
        id: persisted.suggestion.id,
        ownerId,
        conversationId: conversation.id,
        sourceMessageId: assistantMessage.id,
      });
  }
  return persistedProposals;
}

function emitEditConflict(emit: EmitProposal) {
  emit({
    type: 'error',
    message:
      'That part of the note changed while the suggestion was being prepared. Retry to use your latest text.',
  });
}

function emitPersistenceConflict(emit: EmitProposal) {
  emit({
    type: 'error',
    message: 'The note changed before the suggestion was saved. Retry to use your latest text.',
  });
}

async function processFinalProposal(
  generation: NoteProposalGeneration,
  event: Extract<NoteProposalEvent, { type: 'done' }>,
  controller: AbortController,
  emit: EmitProposal,
  ids: AttemptIds,
  proposalAttemptId: string,
  undelivered: PendingSuggestion[],
) {
  const state = await latestProposalNote(generation, controller.signal, emit);
  if (!state) return;
  const proposals = proposalsFrom(event);
  try {
    validateProposalEdits(proposals, state.currentNote);
  } catch {
    emitEditConflict(emit);
    return;
  }
  try {
    const persisted = await persistProposals(
      generation,
      proposals,
      state.currentNote,
      ids,
      proposalAttemptId,
      undelivered,
    );
    if (controller.signal.aborted) return;
    const delivered = emit({
      type: 'done',
      proposal: persisted.at(-1) ?? null,
      ...(event.proposals ? { proposals: persisted } : {}),
    });
    if (delivered) undelivered.length = 0;
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 409) throw error;
    emitPersistenceConflict(emit);
  }
}

async function runProposalStream(
  generation: NoteProposalGeneration,
  controller: AbortController,
  emit: EmitProposal,
  proposalAttemptId: string,
  undelivered: PendingSuggestion[],
) {
  const ids = createAttemptIds(proposalAttemptId, generation.generationKey);
  const events = await generation.agent.streamNoteProposal(
    generation.input,
    generation.assistantMessage,
    controller.signal,
  );
  for await (const event of events) {
    if (controller.signal.aborted) return;
    const attemptEvent = withAttemptIds(event, ids);
    if (
      attemptEvent.type !== 'done' ||
      (!attemptEvent.proposals?.length && !attemptEvent.proposal)
    ) {
      emit(attemptEvent);
      continue;
    }
    await processFinalProposal(
      generation,
      attemptEvent,
      controller,
      emit,
      ids,
      proposalAttemptId,
      undelivered,
    );
    return;
  }
}

async function cleanupProposalStream(
  generation: NoteProposalGeneration,
  undelivered: PendingSuggestion[],
) {
  for (const suggestion of undelivered)
    await removeCancelledPendingSuggestion(generation.db, suggestion);
}

function closeStream(output: ReadableStreamDefaultController<Uint8Array>) {
  try {
    output.close();
  } catch {
    /* Reader already left. */
  }
}

export function createNoteProposalStream(
  generation: NoteProposalGeneration,
): ReadableStream<Uint8Array> {
  const controller = new AbortController();
  const proposalAttemptId = newId();
  const abort = () => controller.abort('client disconnected');
  generation.requestSignal.addEventListener('abort', abort, { once: true });
  if (generation.requestSignal.aborted) abort();
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(output) {
      const emit: EmitProposal = (event) => {
        try {
          output.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          return true;
        } catch {
          controller.abort('response stream closed');
          return false;
        }
      };
      const undelivered: PendingSuggestion[] = [];
      const run = async () => {
        try {
          await runProposalStream(generation, controller, emit, proposalAttemptId, undelivered);
        } catch {
          if (!controller.signal.aborted)
            emit({ type: 'error', message: 'Could not prepare a note suggestion.' });
        } finally {
          await cleanupProposalStream(generation, undelivered);
          generation.requestSignal.removeEventListener('abort', abort);
          closeStream(output);
        }
      };
      generation.waitUntil(run());
    },
    cancel: abort,
  });
}

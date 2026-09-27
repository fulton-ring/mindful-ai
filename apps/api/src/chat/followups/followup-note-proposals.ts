import type {
  Conversation,
  EditProposal,
  Note,
  NoteProposalEvent,
  WaldenUIMessage,
} from '@walden/contracts';
import { resolveEdit } from '@walden/domain';
import { HttpError, newId, nowIso } from '../../http';
import { selectNote, toNote } from '../../notes/repository';
import { persistNoteSuggestion } from '../../notes/suggestions/suggestions';
import type { AgentService, AgentTurnInput } from '../../services/types';
import { loadConversation } from '../conversations/repository';
import { isInterrupted } from '../messages';
import { createBackgroundSseStream } from '../sse';

type NoteProposalGeneration = {
  db: D1Database;
  ownerId: string;
  conversation: Conversation;
  assistantMessage: WaldenUIMessage;
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
): Promise<Note | null> {
  if (!id) return null;
  const row = await selectNote(db, ownerId, id);
  if (!row) throw new HttpError(404, 'Note not found');
  return toNote(row);
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
  const currentNote = await loadNote(db, ownerId, latest.noteId);
  if (signal.aborted) return null;
  const sourceStillExists = latest.messages.some(
    (message) =>
      message.id === assistantMessage.id && message.role === 'assistant' && !isInterrupted(message),
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
  signal: AbortSignal,
  emit: EmitProposal,
  ids: AttemptIds,
  proposalAttemptId: string,
  undelivered: PendingSuggestion[],
) {
  const state = await latestProposalNote(generation, signal, emit);
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
    if (signal.aborted) return;
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
  signal: AbortSignal,
  emit: EmitProposal,
  proposalAttemptId: string,
  undelivered: PendingSuggestion[],
) {
  const ids = createAttemptIds(proposalAttemptId, generation.generationKey);
  const events = await generation.agent.streamNoteProposal(
    generation.input,
    generation.assistantMessage,
    signal,
  );
  for await (const event of events) {
    if (signal.aborted) return;
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
      signal,
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

export function createNoteProposalStream(
  generation: NoteProposalGeneration,
): ReadableStream<Uint8Array> {
  const proposalAttemptId = newId();
  const undelivered: PendingSuggestion[] = [];
  return createBackgroundSseStream<NoteProposalEvent>({
    requestSignal: generation.requestSignal,
    waitUntil: generation.waitUntil,
    errorEvent: { type: 'error', message: 'Could not prepare a note suggestion.' },
    run: (signal, emit) =>
      runProposalStream(generation, signal, emit, proposalAttemptId, undelivered),
    cleanup: () => cleanupProposalStream(generation, undelivered),
  });
}

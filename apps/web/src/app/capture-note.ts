import type { Conversation, Note, NoteState, ProvenanceSpan } from '@walden/contracts';
import type { CapturePlacementResult } from './workspace-helpers';

export type CaptureAttempt = {
  conversationId: string;
  text: string;
  verbatim: boolean;
  operationId: string;
};

export function captureSpan(text: string, verbatim: boolean, from: number, captureId: string) {
  return {
    from,
    to: from + text.length,
    origin: verbatim ? 'agent' : 'user',
    verbatim,
    captureId: verbatim ? captureId : undefined,
  } satisfies ProvenanceSpan;
}

type FirstNoteCapture = {
  activeConversationId: string | null;
  capture: (
    conversationId: string,
    text: string,
    verbatim: boolean,
    operationId: string,
  ) => Promise<{
    conversation: Conversation;
    note: Note;
  }>;
  conversation: Conversation | null;
  deletedThreadIds: ReadonlySet<string>;
  ensureConversation(): Promise<Conversation>;
  getAttempt(): CaptureAttempt | null;
  loadConversation(id: string): Promise<Conversation>;
  newOperationId(): string;
  onError(message: string): void;
  onSaved(target: Conversation, linked: Conversation, note: Note): Promise<void>;
  setAttempt(attempt: CaptureAttempt | null): void;
  text: string;
  verbatim: boolean;
};

export async function captureFirstNote(params: FirstNoteCapture): Promise<boolean> {
  let conversationId: string | null = null;
  try {
    const target =
      params.conversation ??
      (params.activeConversationId
        ? await params.loadConversation(params.activeConversationId)
        : await params.ensureConversation());
    conversationId = target.id;
    const previous = params.getAttempt();
    const operationId =
      previous?.conversationId === target.id &&
      previous.text === params.text &&
      previous.verbatim === params.verbatim
        ? previous.operationId
        : params.newOperationId();
    params.setAttempt({
      conversationId: target.id,
      text: params.text,
      verbatim: params.verbatim,
      operationId,
    });
    const saved = await params.capture(target.id, params.text, params.verbatim, operationId);
    if (params.deletedThreadIds.has(target.id)) return false;
    params.setAttempt(null);
    await params.onSaved(target, saved.conversation, saved.note);
    return true;
  } catch (error) {
    if (conversationId && params.deletedThreadIds.has(conversationId)) return false;
    params.onError(error instanceof Error ? error.message : 'The capture could not be saved.');
    return false;
  }
}

type VerbatimCapture = {
  deletedNoteIds: ReadonlySet<string>;
  deletedThreadIds: ReadonlySet<string>;
  isCurrent(): boolean;
  note: Note;
  onAlreadyPresent(): void;
  onApplied(result: Extract<CapturePlacementResult, { kind: 'applied' }>): void;
  onError(message: string): void;
  resolve(): Promise<CapturePlacementResult>;
  targetConversationId: string;
};

export async function captureVerbatim(params: VerbatimCapture): Promise<boolean> {
  try {
    const result = await params.resolve();
    if (
      !params.isCurrent() ||
      params.deletedNoteIds.has(params.note.id) ||
      params.deletedThreadIds.has(params.targetConversationId)
    )
      return false;
    if (result.kind === 'already-present') {
      params.onAlreadyPresent();
      return true;
    }
    if (result.kind === 'conflict') {
      params.onError('Your writing changed this location. Retry to find a new place.');
      return false;
    }
    if (result.kind !== 'applied') return false;
    params.onApplied(result);
    return true;
  } catch (error) {
    if (params.deletedNoteIds.has(params.note.id)) return false;
    params.onError(error instanceof Error ? error.message : 'The capture could not be placed.');
    return false;
  }
}

export function firstNoteState(note: Note): NoteState {
  return { note, suggestions: [], canUndo: false, canRedo: false };
}

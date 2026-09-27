import type { Conversation, Note, NoteState, ProvenanceSpan } from '@walden/contracts';
import { api } from '../../lib/api';
import { id } from '../../lib/ids';
import { track } from '../../lib/telemetry';
import type { ConversationContext } from '../data/conversation-context';
import {
  mergeConversationAggregate,
  resolveCapturePlacement,
} from '../lifecycle/workspace-helpers';
import {
  type CaptureAttempt,
  captureFirstNote,
  captureSpan,
  captureVerbatim,
  firstNoteState,
} from './capture-note';

type CaptureContext = ConversationContext & {
  setConversation: (value: Conversation) => Promise<void>;
  captureError: (message: string) => void;
};

export type CaptureDependencies = {
  ensureConversation: () => Promise<Conversation>;
  updateDraft: (markdown: string, provenance: ProvenanceSpan[]) => void;
  flushNoteDraft: () => Promise<number | null | false>;
};

async function captureNewNote(
  context: CaptureContext,
  dependencies: CaptureDependencies,
  text: string,
  verbatim: boolean,
) {
  return captureFirstNote({
    activeConversationId: context.activeConversationId,
    capture: api.captureFirstNote,
    conversation: context.conversation,
    deletedThreadIds: context.deletedThreadIds.current,
    ensureConversation: dependencies.ensureConversation,
    getAttempt: () => context.captureAttempt.current,
    loadConversation: (conversationId) =>
      context.queryClient.fetchQuery({
        queryKey: ['conversation', conversationId, context.activeBranchId],
        queryFn: () => api.conversation(conversationId, context.activeBranchId),
        staleTime: 20_000,
      }),
    newOperationId: () => id('capture-save'),
    onError: context.captureError,
    onSaved: async (target, linked, saved) => {
      context.queryClient.setQueryData<NoteState>(['note-state', saved.id], firstNoteState(saved));
      await context.setConversation(mergeConversationAggregate(target, linked));
      context.setDraft(saved);
      context.draftRef.current = saved;
      context.setSaveState('saved');
    },
    setAttempt: (attempt: CaptureAttempt) => {
      context.captureAttempt.current = attempt;
    },
    text,
    verbatim,
  });
}

function captureExistingNote(
  context: CaptureContext,
  dependencies: CaptureDependencies,
  current: Note,
  text: string,
  _verbatim: boolean,
) {
  const targetConversationId = context.conversation?.id ?? context.activeConversationId;
  if (!targetConversationId) return Promise.resolve(false);
  return captureVerbatim({
    deletedNoteIds: context.deletedNoteIds.current,
    deletedThreadIds: context.deletedThreadIds.current,
    isCurrent: () =>
      !context.activeConversationId || context.activeConversationId === targetConversationId,
    note: current,
    onAlreadyPresent: () => context.setNotice('Already in note.'),
    onApplied: (result) => {
      dependencies.updateDraft(result.markdown, result.provenance);
      context.setCaptureRevealRange((previous) => ({
        from: result.from,
        to: result.to,
        key: (previous?.key ?? 0) + 1,
      }));
    },
    onError: context.captureError,
    resolve: () =>
      resolveCapturePlacement(
        () => context.draftRef.current,
        dependencies.flushNoteDraft,
        (revision) => api.capturePlacement(targetConversationId, text, revision),
      ),
    targetConversationId,
  });
}

function appendCapturedText(
  dependencies: CaptureDependencies,
  current: Note,
  text: string,
  verbatim: boolean,
) {
  const separator = current.markdown.trim() ? '\n\n' : '';
  const from = current.markdown.length + separator.length;
  dependencies.updateDraft(`${current.markdown}${separator}${text}`, [
    ...current.provenance,
    captureSpan(text, verbatim, from, id('capture')),
  ]);
  return Promise.resolve(true);
}

export function useCaptureActions(context: CaptureContext) {
  const captureError = (message: string) => {
    track('note_capture_failed', {
      conversation_id: context.activeConversationId ?? undefined,
      failure_code: 'capture_failed',
    });
    context.setNotice(message);
  };
  const performCaptureText = async (
    dependencies: CaptureDependencies,
    text: string,
    verbatim: boolean,
  ) => {
    const current = context.draftRef.current;
    if (!current) return captureNewNote(context, dependencies, text, verbatim);
    if (verbatim) return captureExistingNote(context, dependencies, current, text, verbatim);
    return appendCapturedText(dependencies, current, text, verbatim);
  };
  const captureText = (dependencies: CaptureDependencies, text: string, verbatim: boolean) => {
    if (context.capturePromise.current) return context.capturePromise.current;
    track('note_capture_started', {
      conversation_id: context.activeConversationId ?? undefined,
      action: verbatim ? 'verbatim' : 'summary',
    });
    const running = performCaptureText(dependencies, text, verbatim)
      .then((result) => {
        if (result)
          track('note_capture_completed', {
            conversation_id: context.activeConversationId ?? undefined,
            action: verbatim ? 'verbatim' : 'summary',
          });
        return result;
      })
      .finally(() => {
        if (context.capturePromise.current === running) context.capturePromise.current = null;
      });
    context.capturePromise.current = running;
    return running;
  };
  return { captureText, captureError, performCaptureText };
}

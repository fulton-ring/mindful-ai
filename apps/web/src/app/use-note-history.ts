import { api } from '../lib/api';
import { id } from '../lib/ids';
import type { ConversationContext } from './conversation-context';
import { type NoteMutationScope, noteMutationBelongsToRoute } from './workspace-helpers';

type HistoryContext = ConversationContext;

export type HistoryDependencies = {
  flush: () => Promise<number | null | false>;
  applyNoteState: (state: import('@walden/contracts').NoteState, authoritative?: boolean) => void;
};

async function moveNoteHistory(
  context: HistoryContext,
  dependencies: HistoryDependencies,
  action: 'undo' | 'redo',
) {
  if (context.historyPromise.current || context.historyPreparing.current) return;
  context.historyPreparing.current = true;
  if ((await dependencies.flush()) === false || context.historyPromise.current) {
    context.historyPreparing.current = false;
    return;
  }
  const current = context.draftRef.current;
  if (!current) {
    context.historyPreparing.current = false;
    return;
  }
  const scope: NoteMutationScope = { ...context.activeRoute.current, noteId: current.id };
  const isCurrent = () =>
    noteMutationBelongsToRoute(
      scope,
      context.activeRoute.current.conversationId,
      context.activeRoute.current.branchId,
      context.draftRef.current?.id ?? null,
    );
  context.setHistoryPending(true);
  const running = api
    .noteHistory(current.id, action, current.revision, id(action))
    .then((state) => {
      if (!isCurrent()) {
        void context.queryClient.invalidateQueries({ queryKey: ['note-state', scope.noteId] });
        return false;
      }
      dependencies.applyNoteState(state, true);
      return true;
    })
    .catch((error) => {
      if (!isCurrent()) return false;
      context.setNotice(error instanceof Error ? error.message : `The note could not ${action}.`);
      return false;
    })
    .finally(() => {
      if (isCurrent()) context.setHistoryPending(false);
      if (context.historyPromise.current === running) context.historyPromise.current = null;
    });
  context.historyPromise.current = running;
  context.historyPreparing.current = false;
  await running;
}

export function useNoteHistory(context: HistoryContext) {
  return {
    moveNoteHistory: (action: 'undo' | 'redo', dependencies: HistoryDependencies) =>
      moveNoteHistory(context, dependencies, action),
  };
}

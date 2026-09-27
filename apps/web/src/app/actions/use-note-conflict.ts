import type { Note } from '@walden/contracts';
import type { ConversationContext } from '../data/conversation-context';
import {
  clearCachedDraft,
  type NoteMutationScope,
  noteMutationBelongsToRoute,
  writeCachedDraft,
} from '../lifecycle/workspace-helpers';

type ConflictContext = ConversationContext & { doSave: () => Promise<boolean> };

function currentScope(context: ConflictContext, current: Note): NoteMutationScope {
  return { ...context.activeRoute.current, noteId: current.id };
}

function scopeIsCurrent(context: ConflictContext, scope: NoteMutationScope) {
  return noteMutationBelongsToRoute(
    scope,
    context.activeRoute.current.conversationId,
    context.activeRoute.current.branchId,
    context.draftRef.current?.id ?? null,
  );
}

async function loadLatestNote(context: ConflictContext) {
  const current = context.draftRef.current;
  if (!current) return;
  const scope = currentScope(context, current);
  if (context.timer.current) window.clearTimeout(context.timer.current);
  try {
    const result = await context.noteStateQuery.refetch({ throwOnError: true });
    const remote = result.data?.note;
    if (!remote || remote.id !== current.id || !scopeIsCurrent(context, scope)) return;
    clearCachedDraft(current.id);
    context.dismissSuggestionsOnSave.current.clear();
    context.draftRef.current = remote;
    context.setDraft(remote);
    context.setSaveState('idle');
  } catch (error) {
    if (!scopeIsCurrent(context, scope)) return;
    context.setSaveState('conflict');
    context.setNotice(
      error instanceof Error ? error.message : 'The latest note could not be loaded.',
    );
  }
}

async function keepLocalDraft(context: ConflictContext) {
  const current = context.draftRef.current;
  if (!current) return;
  const scope = currentScope(context, current);
  if (context.timer.current) window.clearTimeout(context.timer.current);
  try {
    const result = await context.noteStateQuery.refetch({ throwOnError: true });
    const remote = result.data?.note;
    if (!remote || remote.id !== current.id || !scopeIsCurrent(context, scope)) return;
    const local = context.draftRef.current;
    if (!local) return;
    const rebased = { ...local, revision: remote.revision, updatedAt: remote.updatedAt };
    context.draftRef.current = rebased;
    context.setDraft(rebased);
    context.setSaveState('dirty');
    writeCachedDraft(rebased, context.dismissSuggestionsOnSave.current);
    await context.doSave();
  } catch (error) {
    if (!scopeIsCurrent(context, scope)) return;
    context.setSaveState('conflict');
    context.setNotice(
      error instanceof Error ? error.message : 'The latest note could not be loaded.',
    );
  }
}

export function useNoteConflict(context: ConflictContext) {
  return {
    loadLatestNote: () => loadLatestNote(context),
    keepLocalDraft: () => keepLocalDraft(context),
  };
}

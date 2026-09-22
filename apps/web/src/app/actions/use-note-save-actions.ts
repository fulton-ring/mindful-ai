import type { QueryClient } from '@tanstack/react-query';
import type { Note } from '@walden/contracts';
import { type Dispatch, type RefObject, type SetStateAction, useCallback } from 'react';
import { ApiError, api } from '../../lib/api';
import { id } from '../../lib/ids';
import {
  type CachedNoteDraft,
  type NoteMutationScope,
  noteMutationBelongsToRoute,
  type SaveState,
} from '../lifecycle/workspace-helpers';

type SaveContext = {
  queryClient: QueryClient;
  activeRoute: RefObject<{ conversationId: string | null; branchId: string | null }>;
  draftRef: RefObject<Note | null>;
  setDraft: Dispatch<SetStateAction<Note | null>>;
  setSaveState: (state: SaveState) => void;
  saveStateRef: RefObject<SaveState>;
  savePromise: RefObject<Promise<boolean> | null>;
  suggestionDecisionPromise: RefObject<Promise<boolean> | null>;
  dismissSuggestionsOnSave: RefObject<Set<string>>;
  dismissedSuggestionIds: RefObject<Set<string>>;
  deletedNoteIds: RefObject<Set<string>>;
};

function saveScope(context: SaveContext, note: Note): NoteMutationScope {
  return { ...context.activeRoute.current, noteId: note.id };
}

function isCurrentNote(context: SaveContext, scope: NoteMutationScope, noteId: string) {
  return (
    !context.deletedNoteIds.current.has(noteId) &&
    noteMutationBelongsToRoute(
      scope,
      context.activeRoute.current.conversationId,
      context.activeRoute.current.branchId,
      context.draftRef.current?.id ?? null,
    )
  );
}

function cacheRebasedDraft(context: SaveContext, draft: Note) {
  context.draftRef.current = draft;
  context.setDraft(draft);
  context.setSaveState('dirty');
  sessionStorage.setItem(
    `walden:draft:${draft.id}`,
    JSON.stringify({
      version: 1,
      baseRevision: draft.revision,
      markdown: draft.markdown,
      provenance: draft.provenance,
      dismissedSuggestionIds: [...context.dismissSuggestionsOnSave.current],
    } satisfies CachedNoteDraft),
  );
}

async function applySaveResult(
  context: SaveContext,
  current: Note,
  scope: NoteMutationScope,
  dismissed: string[],
  result: Awaited<ReturnType<typeof api.saveNote>>,
) {
  if (!isCurrentNote(context, scope, current.id)) return false;
  for (const suggestionId of dismissed) {
    context.dismissSuggestionsOnSave.current.delete(suggestionId);
    context.dismissedSuggestionIds.current.delete(suggestionId);
  }
  const saved =
    'id' in result
      ? result
      : { ...current, revision: result.revision, updatedAt: new Date().toISOString() };
  const latest = context.draftRef.current;
  if (
    latest &&
    (latest.markdown !== current.markdown || latest.provenance !== current.provenance)
  ) {
    cacheRebasedDraft(context, { ...latest, revision: saved.revision, updatedAt: saved.updatedAt });
    return true;
  }
  context.draftRef.current = saved;
  context.setDraft(saved);
  context.setSaveState('saved');
  void context.queryClient.invalidateQueries({ queryKey: ['note-state', current.id] });
  sessionStorage.removeItem(`walden:draft:${current.id}`);
  return true;
}

function saveError(context: SaveContext, scope: NoteMutationScope, noteId: string, error: unknown) {
  if (!isCurrentNote(context, scope, noteId)) return false;
  context.setSaveState(error instanceof ApiError && error.status === 409 ? 'conflict' : 'error');
  return false;
}

export function useNoteSaveActions(context: SaveContext) {
  const doSave = useCallback(async () => {
    if (context.suggestionDecisionPromise.current) await context.suggestionDecisionPromise.current;
    if (context.savePromise.current) return context.savePromise.current;
    const current = context.draftRef.current;
    if (!current || !['dirty', 'error'].includes(context.saveStateRef.current))
      return context.saveStateRef.current !== 'conflict';
    context.setSaveState('saving');
    const scope = saveScope(context, current);
    const dismissed = [...context.dismissSuggestionsOnSave.current];
    let running: Promise<boolean>;
    running = api
      .saveNote(current, id('save'), current.markdown, current.provenance, undefined, dismissed)
      .then((result) => applySaveResult(context, current, scope, dismissed, result))
      .catch((error) => saveError(context, scope, current.id, error))
      .finally(() => {
        if (context.savePromise.current === running) {
          context.savePromise.current = null;
          if (context.saveStateRef.current === 'dirty') void doSave();
        }
      });
    context.savePromise.current = running;
    return running;
  }, [context]);
  return { doSave };
}

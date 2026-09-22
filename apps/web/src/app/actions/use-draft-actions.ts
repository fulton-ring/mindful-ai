import { useBlocker } from '@tanstack/react-router';
import type { ProvenanceSpan } from '@walden/contracts';
import { api } from '../../lib/api';
import { productSessionId } from '../../lib/telemetry';
import type { ConversationContext } from '../data/conversation-context';
import {
  type CachedNoteDraft,
  shouldBypassLazyConversationBlock,
  waitForPendingCapture,
} from '../lifecycle/workspace-helpers';

type DraftContext = ConversationContext & {
  doSave: () => Promise<boolean>;
};

export type DraftDependencies = {
  captureText: (text: string, verbatim: boolean) => Promise<boolean>;
  cancelProposalRequest: () => void;
};

async function flushNoteDraft(context: DraftContext, persistUnsavedDraft: () => Promise<boolean>) {
  if (context.timer.current) window.clearTimeout(context.timer.current);
  if (
    !context.draftRef.current &&
    context.unsavedDraftRef.current.markdown &&
    !(await (context.unsavedPersistPromise.current ?? persistUnsavedDraft()))
  )
    return false;
  if (!context.draftRef.current) return null;
  let okay = await (context.savePromise.current ?? context.doSave());
  while (okay && (context.saveStateRef.current === 'dirty' || context.savePromise.current))
    okay = await (context.savePromise.current ?? context.doSave());
  return okay ? context.draftRef.current.revision : false;
}

function updateDraft(
  context: DraftContext,
  markdown: string,
  provenance: ProvenanceSpan[],
  userChange = true,
) {
  if (!context.draftRef.current) return;
  const previous = context.draftRef.current;
  const conflicted = context.saveStateRef.current === 'conflict';
  const next = { ...previous, markdown, provenance };
  context.draftRef.current = next;
  context.setDraft(next);
  context.setSaveState(conflicted ? 'conflict' : 'dirty');
  if (!context.sessionStarted.current) {
    context.sessionStarted.current = true;
    void api
      .event({
        kind: 'session_started',
        sessionId: productSessionId(),
        metadata: { startsFromExisting: previous.markdown.length > 0 },
      })
      .catch(() => undefined);
  }
  if (userChange && !context.ownWordsRecorded.current) {
    context.ownWordsRecorded.current = true;
    void api
      .event({
        kind: 'own_words_saved',
        sessionId: productSessionId(),
        metadata: { noteId: next.id },
      })
      .catch(() => undefined);
  }
  sessionStorage.setItem(
    `walden:draft:${next.id}`,
    JSON.stringify({
      version: 1,
      baseRevision: next.revision,
      markdown,
      provenance,
      dismissedSuggestionIds: [...context.dismissSuggestionsOnSave.current],
    } satisfies CachedNoteDraft),
  );
  if (context.timer.current) window.clearTimeout(context.timer.current);
  if (!conflicted) context.timer.current = window.setTimeout(() => void context.doSave(), 700);
}

function persistUnsavedDraft(
  context: DraftContext,
  captureText: DraftDependencies['captureText'],
  update: (markdown: string, provenance: ProvenanceSpan[]) => void,
) {
  if (context.unsavedPersistPromise.current) return context.unsavedPersistPromise.current;
  const snapshot = context.unsavedDraftRef.current;
  if (!snapshot.markdown) return Promise.resolve(true);
  context.setSaveState('saving');
  const running = captureText(snapshot.markdown, false)
    .then((captured) => {
      if (!captured) {
        context.setSaveState('error');
        return false;
      }
      const latest = context.unsavedDraftRef.current;
      if (latest.markdown !== snapshot.markdown || latest.provenance !== snapshot.provenance)
        update(latest.markdown, latest.provenance);
      context.unsavedDraftRef.current = { markdown: '', provenance: [] };
      context.setUnsavedDraft(context.unsavedDraftRef.current);
      return true;
    })
    .finally(() => {
      if (context.unsavedPersistPromise.current === running)
        context.unsavedPersistPromise.current = null;
    });
  context.unsavedPersistPromise.current = running;
  return running;
}

export function useDraftActions(context: DraftContext) {
  const update = (markdown: string, provenance: ProvenanceSpan[], userChange = true) =>
    updateDraft(context, markdown, provenance, userChange);
  const persist = (dependencies: DraftDependencies) =>
    persistUnsavedDraft(context, dependencies.captureText, (markdown, provenance) =>
      update(markdown, provenance),
    );
  const flushNote = (dependencies: DraftDependencies) =>
    flushNoteDraft(context, () => persist(dependencies));
  const flush = async (
    allowConflict = false,
    dependencies: DraftDependencies,
  ): Promise<number | null | false> => {
    if (
      context.suggestionDecisionPromise.current &&
      !(await context.suggestionDecisionPromise.current)
    )
      return false;
    if (context.historyPromise.current && !(await context.historyPromise.current)) return false;
    if (!(await waitForPendingCapture(context.capturePromise.current))) return false;
    if (allowConflict && context.saveStateRef.current === 'conflict')
      return context.draftRef.current?.revision ?? null;
    const result = await flushNote(dependencies);
    return allowConflict && result === false && context.saveStateRef.current === 'conflict'
      ? (context.draftRef.current?.revision ?? null)
      : result;
  };
  const updateUnsavedDraft = (
    markdown: string,
    provenance: ProvenanceSpan[],
    dependencies: DraftDependencies,
  ) => {
    dependencies.cancelProposalRequest();
    const next = { markdown, provenance };
    context.unsavedDraftRef.current = next;
    context.setUnsavedDraft(next);
    if (context.timer.current) window.clearTimeout(context.timer.current);
    if (!markdown) return context.setSaveState('idle');
    context.setSaveState('dirty');
    context.timer.current = window.setTimeout(() => void persist(dependencies), 700);
  };
  return {
    flush,
    flushNoteDraft: flushNote,
    updateDraft: update,
    updateUnsavedDraft,
    persistUnsavedDraft: (dependencies: DraftDependencies) => persist(dependencies),
  };
}

export function useDraftBlocker(
  context: DraftContext,
  flush: (
    allowConflict: boolean,
    dependencies: DraftDependencies,
  ) => Promise<number | null | false>,
  getDependencies: () => DraftDependencies,
) {
  useBlocker({
    shouldBlockFn: async ({ current, next }) => {
      if (
        current.pathname === next.pathname ||
        shouldBypassLazyConversationBlock(
          current.pathname,
          next.pathname,
          context.adoptingConversationId.current,
        )
      )
        return false;
      return (await flush(true, getDependencies())) === false;
    },
    enableBeforeUnload: () =>
      ['dirty', 'saving', 'error', 'conflict'].includes(context.saveStateRef.current),
  });
}

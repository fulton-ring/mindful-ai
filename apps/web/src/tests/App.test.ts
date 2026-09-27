import { QueryClient } from '@tanstack/react-query';
import type { Conversation } from '@walden/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  cacheConversationTitle,
  cacheConversationUpdate,
  isExpiredNoteConversation,
  isLazyConversationAdoption,
  mergeConversationAggregate,
  noteMutationBelongsToRoute,
  readDismissedNotePanels,
  resolveCaptureConversation,
  resolveCapturePlacement,
  shouldBypassLazyConversationBlock,
  visiblePendingSuggestions,
  waitForPendingCapture,
  writeDismissedNotePanels,
} from '../app/lifecycle/workspace-helpers';

describe('retained note workspace', () => {
  it('opens an expired note-backed conversation in note-only mode', () => {
    expect(
      isExpiredNoteConversation(
        { noteId: 'note', expiresAt: '2026-09-20T12:00:00.000Z' },
        new Date('2026-09-20T12:00:00.001Z'),
      ),
    ).toBe(true);
    expect(
      isExpiredNoteConversation(
        { noteId: 'note', expiresAt: '2026-09-20T12:00:00.000Z' },
        new Date('2026-09-20T12:00:00.000Z'),
      ),
    ).toBe(true);
    expect(
      isExpiredNoteConversation(
        { noteId: null, expiresAt: '2026-09-20T12:00:00.000Z' },
        new Date('2026-09-20T12:01:00.000Z'),
      ),
    ).toBe(false);
  });
});

describe('note panel dismissal across reloads', () => {
  it('restores closed threads per account and clears an explicitly reopened thread', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    try {
      writeDismissedNotePanels('account-a', new Set(['thread-a', 'thread-b']));
      expect(readDismissedNotePanels('account-a')).toEqual(new Set(['thread-a', 'thread-b']));
      expect(readDismissedNotePanels('account-b').size).toBe(0);
      const restored = readDismissedNotePanels('account-a');
      restored.delete('thread-a');
      writeDismissedNotePanels('account-a', restored);
      expect(readDismissedNotePanels('account-a')).toEqual(new Set(['thread-b']));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not block the workspace when storage is unavailable or malformed', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => '{invalid',
      setItem: () => {
        throw new Error('Storage unavailable');
      },
    });
    try {
      expect(readDismissedNotePanels('account').size).toBe(0);
      expect(() => writeDismissedNotePanels('account', new Set(['thread']))).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('delayed thread rename', () => {
  it('changes only titles across cached branches, preserving messages that arrived during rename', () => {
    const client = new QueryClient();
    const latest = {
      id: 'thread-1',
      title: 'Before',
      branchId: 'branch-1',
      branches: [],
      noteId: 'new-note',
      learningChecksEnabled: true,
      expiresAt: '2026-09-25T00:00:00.000Z',
      messages: [
        {
          id: 'new-answer',
          role: 'assistant' as const,
          parts: [{ type: 'text' as const, text: 'Just streamed' }],
        },
      ],
    } satisfies Conversation;
    client.setQueryData(['conversation', latest.id, null], latest);
    client.setQueryData(['conversation', latest.id, 'branch-2'], {
      ...latest,
      branchId: 'branch-2',
      messages: [],
    });
    client.setQueryData(['conversation', 'other', null], { ...latest, id: 'other' });
    client.setQueryData(
      ['conversations'],
      [
        { id: latest.id, title: 'Before' },
        { id: 'other', title: 'Other' },
      ],
    );

    cacheConversationTitle(client, latest.id, 'Renamed');

    expect(client.getQueryData(['conversation', latest.id, null])).toEqual({
      ...latest,
      title: 'Renamed',
    });
    expect(client.getQueryData(['conversation', latest.id, 'branch-2'])).toEqual({
      ...latest,
      title: 'Renamed',
      branchId: 'branch-2',
      messages: [],
    });
    expect(client.getQueryData(['conversation', 'other', null])).toEqual({
      ...latest,
      id: 'other',
    });
    expect(client.getQueryData(['conversations'])).toEqual([
      { id: latest.id, title: 'Renamed' },
      { id: 'other', title: 'Other' },
    ]);
    cacheConversationTitle(client, 'not-cached', 'Missing');
    expect(client.getQueryData(['conversation', 'not-cached', null])).toBeUndefined();
    client.clear();
  });
});

describe('visible pending suggestions', () => {
  const pending = (id: string) => ({ id, status: 'pending' as const });

  it('keeps every pending candidate while merging an active stream by ID', () => {
    expect(
      visiblePendingSuggestions(
        [pending('saved-2'), pending('saved-1')],
        pending('streaming'),
        new Set(),
      ).map((item) => item.id),
    ).toEqual(['streaming', 'saved-2', 'saved-1']);
  });

  it('removes only the locally dismissed candidate during stale query hydration', () => {
    expect(
      visiblePendingSuggestions(
        [pending('saved-2'), pending('saved-1')],
        null,
        new Set(['saved-2']),
      ).map((item) => item.id),
    ).toEqual(['saved-1']);
  });

  it('keeps sibling candidates after one decision and restores them from undo state', () => {
    const acceptedState = [
      { id: 'accepted', status: 'accepted' as const },
      pending('still-pending'),
    ];
    expect(visiblePendingSuggestions(acceptedState, null, new Set())).toEqual([
      pending('still-pending'),
    ]);

    const undoneState = [pending('accepted'), pending('still-pending')];
    expect(visiblePendingSuggestions(undoneState, null, new Set())).toEqual(undoneState);
  });
});

it('conversation branch cache updates the mounted default-URL query after a regular turn', () => {
  const queryClient = new QueryClient();
  const before = {
    id: 'conversation-1',
    branchId: 'branch-1',
    branches: [],
    title: 'Thread',
    noteId: null,
    messages: [],
    expiresAt: '2026-09-25T00:00:00.000Z',
    learningChecksEnabled: false,
  } satisfies Conversation;
  const after = {
    ...before,
    messages: [
      {
        id: 'user-1',
        role: 'user' as const,
        parts: [{ type: 'text' as const, text: 'Question' }],
        metadata: { createdAt: '2026-09-18T00:00:00.000Z' },
      },
    ],
  };
  queryClient.setQueryData(['conversation', before.id, null], before);

  expect(cacheConversationUpdate(queryClient, after, before.id, null, before.branchId)).toBe(true);

  expect(
    queryClient.getQueryData<Conversation>(['conversation', before.id, null])?.messages,
  ).toEqual(after.messages);
  expect(
    queryClient.getQueryData<Conversation>(['conversation', before.id, before.branchId]),
  ).toEqual(after);
});

it('conversation branch cache updates the mounted explicit-branch query after a regular turn', () => {
  const queryClient = new QueryClient();
  const after = {
    id: 'conversation-1',
    branchId: 'branch-2',
    branches: [],
    title: 'Thread',
    noteId: null,
    messages: [
      {
        id: 'assistant-2',
        role: 'assistant' as const,
        parts: [{ type: 'text' as const, text: 'Branch answer' }],
        metadata: { createdAt: '2026-09-18T00:00:00.000Z' },
      },
    ],
    expiresAt: '2026-09-25T00:00:00.000Z',
    learningChecksEnabled: false,
  } satisfies Conversation;

  expect(
    cacheConversationUpdate(queryClient, after, after.id, after.branchId, after.branchId),
  ).toBe(true);
  expect(
    queryClient.getQueryData<Conversation>(['conversation', after.id, after.branchId]),
  ).toEqual(after);
});

it('conversation branch cache keeps the selected branch path when first-note capture returns the default branch', () => {
  const queryClient = new QueryClient();
  const selected = {
    id: 'conversation-1',
    branchId: 'branch-2',
    branches: [],
    title: 'Thread',
    noteId: null,
    messages: [
      {
        id: 'branch-answer',
        role: 'assistant' as const,
        parts: [{ type: 'text' as const, text: 'Selected path' }],
        metadata: { createdAt: '2026-09-18T00:00:00.000Z' },
      },
    ],
    expiresAt: '2026-09-25T00:00:00.000Z',
    learningChecksEnabled: false,
  } satisfies Conversation;
  const defaultBranchResponse = {
    ...selected,
    branchId: 'branch-1',
    noteId: 'note-1',
    messages: [],
  };
  const merged = mergeConversationAggregate(selected, defaultBranchResponse);

  cacheConversationUpdate(queryClient, merged, selected.id, selected.branchId, selected.branchId);

  expect(merged.branchId).toBe('branch-2');
  expect(merged.noteId).toBe('note-1');
  expect(
    queryClient.getQueryData<Conversation>(['conversation', selected.id, selected.branchId])
      ?.messages,
  ).toEqual(selected.messages);
});

describe('note mutation response ownership', () => {
  const scope = {
    conversationId: 'conversation-1',
    branchId: 'branch-1',
    noteId: 'note-1',
  };

  it('rejects a delayed response after branch navigation', () => {
    expect(noteMutationBelongsToRoute(scope, 'conversation-1', 'branch-2', 'note-1')).toBe(false);
  });

  it('rejects a delayed response after navigation to another note', () => {
    expect(noteMutationBelongsToRoute(scope, 'conversation-2', 'branch-3', 'note-2')).toBe(false);
  });

  it('leaves the new note and its save state untouched when an old save resolves', () => {
    let draft = { id: 'note-2', markdown: 'New note', revision: 7 };
    let saveState = 'dirty';

    if (noteMutationBelongsToRoute(scope, 'conversation-2', 'branch-3', draft.id)) {
      draft = { ...draft, markdown: 'Old note', revision: 2 };
      saveState = 'saved';
    }

    expect(draft).toEqual({ id: 'note-2', markdown: 'New note', revision: 7 });
    expect(saveState).toBe('dirty');
  });

  it('allows a response only in its original route and note', () => {
    expect(noteMutationBelongsToRoute(scope, 'conversation-1', 'branch-1', 'note-1')).toBe(true);
  });
});

describe('conversation route transitions', () => {
  it('preserves transient capture state only when a new chat adopts its created conversation', () => {
    expect(isLazyConversationAdoption('conversation-1', 'conversation-1')).toBe(true);
    expect(isLazyConversationAdoption('conversation-2', 'conversation-1')).toBe(false);
    expect(isLazyConversationAdoption(null, 'conversation-1')).toBe(false);
  });

  it('does not flush into its own pending first-conversation adoption', () => {
    expect(
      shouldBypassLazyConversationBlock('/', '/conversations/conversation-1', 'conversation-1'),
    ).toBe(true);
    expect(
      shouldBypassLazyConversationBlock(
        '/conversations/conversation-2',
        '/conversations/conversation-1',
        'conversation-1',
      ),
    ).toBe(false);
    expect(shouldBypassLazyConversationBlock('/', '/settings', 'conversation-1')).toBe(false);
  });
});

describe('unsaved note capture', () => {
  it('loads and links the active conversation when render data is temporarily unavailable', async () => {
    const active = {
      id: 'conversation-1',
      title: 'Conversation',
      noteId: null,
      messages: [],
      expiresAt: '2026-09-25T00:00:00.000Z',
      learningChecksEnabled: false,
    };
    const load = vi.fn().mockResolvedValue(active);
    const ensure = vi.fn();

    await expect(resolveCaptureConversation(null, active.id, load, ensure)).resolves.toBe(active);
    expect(load).toHaveBeenCalledWith(active.id);
    expect(ensure).not.toHaveBeenCalled();
  });

  it('keeps turn flushing blocked until note capture and linking finish', async () => {
    let finishCapture: ((value: boolean) => void) | undefined;
    const capture = new Promise<boolean>((resolve) => {
      finishCapture = resolve;
    });
    let settled = false;
    const waiting = waitForPendingCapture(capture).then((value) => {
      settled = true;
      return value;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    finishCapture?.(true);
    await expect(waiting).resolves.toBe(true);
  });
});

const captureNote = (markdown: string, revision = 3) => ({
  id: 'note-1',
  title: 'Note',
  markdown,
  revision,
  provenance: [],
  createdAt: '',
  updatedAt: '',
});

it('capture placement applies immediately while preserving text typed elsewhere during placement', async () => {
  let current = captureNote('Plans\n\nLater');
  const request = vi.fn(async () => {
    current = captureNote('Plans\n\nLater today', 4);
    return {
      proposal: {
        id: 'capture-1',
        noteId: current.id,
        baseRevision: 3,
        oldText: 'Plans',
        newText: 'Plans\n\nCall Sam',
        reason: 'capture',
        status: 'pending' as const,
      },
    };
  });

  const result = await resolveCapturePlacement(
    () => current,
    async () => current.revision,
    request,
  );

  expect(result).toMatchObject({
    kind: 'applied',
    markdown: 'Plans\n\nCall Sam\n\nLater today',
  });
  expect(request).toHaveBeenCalledTimes(1);
});

it('capture placement refreshes placement once and never overwrites typing in its anchor', async () => {
  let current = captureNote('Plans\n\nLater');
  const request = vi.fn(async () => {
    current = captureNote('Changed plans\n\nLater', 4);
    return {
      proposal: {
        id: 'capture-1',
        noteId: current.id,
        baseRevision: 3,
        oldText: 'Plans',
        newText: 'Plans\n\nCall Sam',
        reason: 'capture',
        status: 'pending' as const,
      },
    };
  });

  await expect(
    resolveCapturePlacement(
      () => current,
      async () => current.revision,
      request,
    ),
  ).resolves.toEqual({ kind: 'conflict' });
  expect(request).toHaveBeenCalledTimes(2);
  expect(current.markdown).toBe('Changed plans\n\nLater');
});

it('capture placement treats an already-present capture as a successful no-op', async () => {
  const current = captureNote('Call Sam');
  await expect(
    resolveCapturePlacement(
      () => current,
      async () => current.revision,
      async () => ({ proposal: null }),
    ),
  ).resolves.toEqual({ kind: 'already-present' });
});

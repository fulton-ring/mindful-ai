// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';
import type { ChatPanel } from './features/chat/ChatPanel';
import type { NotesEditorProps } from './features/notes/NotesEditor';
import { api } from './lib/api';

let chat: ComponentProps<typeof ChatPanel>;
let editor: NotesEditorProps;
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useBlocker: () => undefined,
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: '/conversations/thread', search: {} } }),
}));
vi.mock('./features/chat/ChatPanel', () => ({
  ChatPanel: (props: ComponentProps<typeof ChatPanel>) => {
    chat = props;
    return null;
  },
}));
vi.mock('./features/notes/NotesEditor', () => ({
  NotesEditor: (props: NotesEditorProps) => {
    editor = props;
    return <div>Test editor</div>;
  },
}));
vi.mock('./components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => null,
}));
vi.mock('./lib/telemetry', () => ({ track: vi.fn(), productSessionId: () => 'session' }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubStorage() {
  for (const key of ['localStorage', 'sessionStorage']) {
    const values = new Map<string, string>();
    vi.stubGlobal(key, {
      getItem: (name: string) => values.get(name) ?? null,
      setItem: (name: string, value: string) => values.set(name, value),
      removeItem: (name: string) => values.delete(name),
    });
  }
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

function setupFixtures(linked: boolean) {
  const note = {
    id: 'note',
    title: 'Note',
    markdown: '',
    revision: 0,
    provenance: [],
    createdAt: '',
    updatedAt: '',
  };
  const proposal = {
    id: 'proposal',
    createdAt: '',
    updatedAt: '',
    conversationId: 'thread',
    sourceMessageId: 'message',
    noteId: 'note',
    baseRevision: 0,
    oldText: '',
    newText: 'Water basil on Monday.',
    reason: 'capture',
    status: 'pending' as const,
  };
  const conversation = {
    id: 'thread',
    title: 'Test',
    branchId: 'branch',
    branches: [],
    noteId: linked ? 'note' : null,
    messages: [],
    learningChecksEnabled: false,
    expiresAt: '',
  };
  return { note, proposal, conversation };
}

function stubWorkspaceApi(
  note: ReturnType<typeof setupFixtures>['note'],
  proposal: ReturnType<typeof setupFixtures>['proposal'],
  conversation: ReturnType<typeof setupFixtures>['conversation'],
) {
  vi.spyOn(api, 'personas').mockResolvedValue([]);
  vi.spyOn(api, 'conversations').mockResolvedValue([]);
  vi.spyOn(api, 'notes').mockResolvedValue([]);
  vi.spyOn(api, 'conversation').mockResolvedValue(conversation);
  vi.spyOn(api, 'noteState').mockResolvedValue({
    note,
    suggestions: [],
    canUndo: false,
    canRedo: false,
  });
  return vi.spyOn(api, 'decideSuggestion').mockResolvedValue({
    note: { ...note, markdown: proposal.newText, revision: 1 },
    suggestions: [{ ...proposal, status: 'accepted' }],
    canUndo: true,
    canRedo: false,
  });
}

async function setup(linked = true) {
  stubStorage();
  const { note, proposal, conversation } = setupFixtures(linked);
  const decide = stubWorkspaceApi(note, proposal, conversation);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const previousChat = chat;
  const view = render(
    <QueryClientProvider client={client}>
      <App config={{ authConfigured: true, billingConfigured: false, modelConfigured: true }} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(chat).not.toBe(previousChat));
  if (linked) {
    await view.findByText('Test editor');
    await waitFor(() => expect(editor.note.id).toBe('note'));
  } else {
    await waitFor(() => expect(chat.conversation?.id).toBe('thread'));
    act(() => chat.onOpenNote());
    await view.findByText('Test editor');
  }
  return { note, proposal, decide, client, conversation, view };
}

it('searches thread content and standalone note bodies with plain timestamps', async () => {
  const { client, note, view } = await setup();
  const thread = {
    id: 'thread',
    title: 'Photosynthesis',
    noteId: 'note',
    updatedAt: '2026-09-20T12:00:00.000Z',
    lastMessageAt: '2026-09-20T12:01:00.000Z',
    expiresAt: '2999-01-01T00:00:00.000Z',
  };
  act(() => {
    client.setQueryData(['conversations'], [thread]);
    client.setQueryData(
      ['notes'],
      [note, { ...note, id: 'standalone', title: 'Plant diary', markdown: 'Chloroplast pigments' }],
    );
  });
  const search = await view.findByRole('searchbox', { name: 'Search threads and notes' });
  vi.mocked(api.conversations).mockResolvedValue([thread]);
  fireEvent.change(search, { target: { value: 'chloroplast' } });

  await waitFor(() => expect(api.conversations).toHaveBeenCalledWith('chloroplast'));
  await view.findByText('Photosynthesis');
  expect(view.getByText('Plant diary')).toBeTruthy();
  const timestamps = view.container.querySelectorAll('time.conversation-timestamp');
  expect(timestamps).toHaveLength(2);
  for (const timestamp of timestamps) {
    expect(timestamp.textContent).not.toMatch(/^(Last message|Edited):/);
    expect(timestamp.getAttribute('title')).not.toMatch(/^(Last message|Edited):/);
  }
});

it('removes a deleted thread and its note from the sidebar', async () => {
  const { note, client, view } = await setup();
  const thread = {
    id: 'thread',
    noteId: note.id,
    title: 'Test',
    updatedAt: '2026-09-20T12:00:00.000Z',
    expiresAt: '2999-01-01T00:00:00.000Z',
  };
  act(() => {
    client.setQueryData(['conversations'], [thread]);
    client.setQueryData(['notes'], [note]);
  });
  await view.findByRole('button', { name: 'Thread options: Test' });
  vi.spyOn(api, 'deleteConversation').mockResolvedValue(undefined);
  fireEvent.click(view.getByRole('button', { name: 'Thread options: Test' }));
  fireEvent.click(await view.findByRole('button', { name: 'Delete everything' }));
  const dialog = await view.findByRole('alertdialog');
  fireEvent.click(dialog.querySelector('.danger')!);

  await waitFor(() => expect(api.deleteConversation).toHaveBeenCalledWith('thread'));
  await waitFor(() => expect(client.getQueryData(['conversations'])).toEqual([]));
  expect(client.getQueryData(['notes'])).toEqual([]);
  expect(view.queryByRole('button', { name: 'Open note: Note' })).toBeNull();
  client.clear();
});

it.each(['single', 'batch'])('settles a %s result before allowing its decision', async (kind) => {
  const { note, proposal, decide, client } = await setup();
  act(() => chat.onProposalStart('source'));
  act(() => chat.onGhost(proposal, true, 'source'));
  expect(editor.streamingProposalIds?.has(proposal.id)).toBe(true);
  vi.mocked(api.noteState).mockResolvedValue({
    note,
    suggestions: [proposal],
    canUndo: false,
    canRedo: false,
  });
  await act(async () => {
    if (kind === 'batch') chat.onGhostBatch?.([proposal], 'source');
    else chat.onGhost(proposal, false, 'source');
  });
  await waitFor(() => expect(editor.proposalStreaming).toBe(false));
  expect(editor.streamingProposalIds?.has(proposal.id)).toBe(false);
  await act(async () => editor.onAccept(proposal));
  expect(decide).toHaveBeenCalledWith(
    'note',
    'proposal',
    'accept',
    0,
    expect.any(String),
    proposal.newText,
  );
  expect(editor.note.markdown).toBe(proposal.newText);
  client.clear();
});

it('clears preview controls when a request declines or fails', async () => {
  const { proposal, client } = await setup();
  act(() => chat.onProposalStart('source'));
  act(() => chat.onGhost(proposal, true, 'source'));
  act(() => chat.onGhost(null, false, 'source'));
  expect(editor.proposalStreaming).toBe(false);
  expect(editor.streamingProposalIds?.size).toBe(0);
  expect(editor.proposals).toEqual([]);
  client.clear();
});

it('ignores completion from an older request', async () => {
  const { proposal, client } = await setup();
  act(() => chat.onProposalStart('old'));
  act(() => chat.onProposalStart('new'));
  await act(async () => chat.onGhost(proposal, false, 'old'));
  expect(editor.proposalStreaming).toBe(true);
  expect(editor.proposals).toEqual([]);
  client.clear();
});

it('loads and binds the first note before accepting a completed capture', async () => {
  const { note, proposal, decide, client, conversation } = await setup(false);
  act(() => chat.onProposalStart('first'));
  act(() => chat.onGhost(proposal, true, 'first'));
  vi.mocked(api.conversation).mockResolvedValue({ ...conversation, noteId: note.id });
  vi.mocked(api.noteState).mockResolvedValue({
    note,
    suggestions: [proposal],
    canUndo: false,
    canRedo: false,
  });
  await act(async () => chat.onGhost(proposal, false, 'first'));
  await waitFor(() => expect(editor.note.id).toBe(note.id));
  expect(editor.disabled).toBe(false);
  await act(async () => editor.onAccept(proposal));
  expect(decide).toHaveBeenCalled();
  expect(editor.note.markdown).toBe(proposal.newText);
  client.clear();
});

it('cancels all previews in the active request and ignores late completion', async () => {
  const { proposal, client } = await setup();
  const cancel = vi.fn().mockResolvedValue(null);
  act(() => chat.onProposalCancelable(cancel));
  act(() => chat.onProposalStart('cancel'));
  act(() => chat.onGhost(proposal, true, 'cancel'));
  act(() => chat.onGhost({ ...proposal, id: 'second' }, true, 'cancel'));
  act(() => editor.onDismiss('reject', proposal));
  await act(async () => chat.onGhost(proposal, false, 'cancel'));
  expect(cancel).toHaveBeenCalledOnce();
  expect(editor.proposals).toEqual([]);
  expect(editor.proposalStreaming).toBe(false);
  expect(editor.disabled).toBe(false);
  client.clear();
});

it('does not let an old hydration clear a newer request', async () => {
  const { note, proposal, client } = await setup();
  let finish!: (state: Awaited<ReturnType<typeof api.noteState>>) => void;
  vi.mocked(api.noteState).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  act(() => chat.onProposalStart('old'));
  act(() => chat.onGhost(proposal, false, 'old'));
  expect(editor.disabled).toBe(true);
  act(() => chat.onProposalStart('new'));
  const next = { ...proposal, id: 'new', newText: 'New request' };
  act(() => chat.onGhost(next, true, 'new'));
  await act(async () => finish({ note, suggestions: [proposal], canUndo: false, canRedo: false }));
  expect(editor.proposal?.id).toBe('new');
  expect(editor.proposalStreaming).toBe(true);
  expect(editor.disabled).toBe(false);
  client.clear();
});

it('releases the editor when loading saved proposals fails', async () => {
  const { proposal, client } = await setup();
  vi.mocked(api.noteState).mockRejectedValueOnce(new Error('Connection interrupted'));
  act(() => chat.onProposalStart('source'));
  await act(async () => chat.onGhost(proposal, false, 'source'));
  expect(editor.disabled).toBe(false);
  expect(editor.proposalStreaming).toBe(false);
  expect(editor.proposals).toContainEqual(proposal);
  client.clear();
});

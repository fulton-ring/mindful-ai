import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, setTokenProvider, streamMessageAnnotations, streamNoteProposal } from '../api';

afterEach(() => {
  setTokenProvider(null);
  vi.unstubAllGlobals();
});

describe('authenticated API transport', () => {
  it('loads the selected conversation branch through the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: 'conversation/1' }));
    vi.stubGlobal('fetch', fetchMock);

    await api.conversation('conversation/1', 'branch/2');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/conversations/conversation%2F1?branch=branch%2F2',
      expect.any(Object),
    );
  });

  it('requests a capture placement against the saved note revision', async () => {
    const proposal = {
      id: 'placement-1',
      noteId: 'note-1',
      baseRevision: 4,
      oldText: 'Plans',
      newText: 'Plans\n\nCall Sam',
      reason: 'capture',
      status: 'pending',
    };
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ proposal }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.capturePlacement('conversation/1', 'Call Sam', 4)).resolves.toEqual({
      proposal,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/conversations/conversation%2F1/capture-placement',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ text: 'Call Sam', noteRevision: 4 }),
      }),
    );
  });
});

describe('authenticated API followups', () => {
  it('encodes ids and parses CRLF, multi-line server-sent event frames', async () => {
    const annotation = { id: 'a-1', quote: 'Clear', kind: 'claim', whose: 'assistant' } as const;
    const done = JSON.stringify({ type: 'done', annotations: [annotation] }, null, 1);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          `: comment\r\n\r\n${done.replace(/^/gm, 'data: ').replace(/\n/g, '\r\n')}\r\n\r\n`,
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const events: unknown[] = [];

    await streamMessageAnnotations(
      'message/1',
      {
        conversationId: 'conversation-1',
        branchId: 'branch-1',
        personaId: 'thinking-partner',
        noteRevision: 3,
      },
      (event) => events.push(event),
      new AbortController().signal,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/messages/message%2F1/annotations?stream=1',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          conversationId: 'conversation-1',
          branchId: 'branch-1',
          personaId: 'thinking-partner',
          noteRevision: 3,
        }),
      }),
    );
    expect(events).toEqual([{ type: 'done', annotations: [annotation] }]);
  });

  it('cancels a turn by its encoded id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ cancelled: true }));
    vi.stubGlobal('fetch', fetchMock);

    await api.cancelTurn('turn/request');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/turns/turn%2Frequest/cancel',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
  });
});

describe('note and annotation API transport', () => {
  it('loads note state and records suggestion decisions against its revision', async () => {
    const state = {
      note: {
        id: 'note-1',
        title: 'Note',
        markdown: 'Tuesday',
        revision: 3,
        provenance: [],
        createdAt: '2026-09-18T00:00:00.000Z',
        updatedAt: '2026-09-18T00:00:00.000Z',
      },
      suggestions: [],
      canUndo: true,
      canRedo: false,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(state))
      .mockResolvedValueOnce(Response.json(state));
    vi.stubGlobal('fetch', fetchMock);

    await api.noteState('note-1');
    await api.decideSuggestion('note-1', 'suggestion-1', 'accept', 2, 'accept-1');

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/notes/note-1/state', expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/notes/note-1/suggestions/suggestion-1/decision',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          decision: 'accept',
          baseRevision: 2,
          operationId: 'accept-1',
        }),
      }),
    );
  });
});

describe('note persistence API transport', () => {
  it('records typing over a suggestion with the note save and uses durable history routes', async () => {
    const note = {
      id: 'note-1',
      title: 'Note',
      markdown: 'Monday',
      revision: 2,
      provenance: [],
      createdAt: '2026-09-18T00:00:00.000Z',
      updatedAt: '2026-09-18T00:00:00.000Z',
    };
    const state = { note, suggestions: [], canUndo: true, canRedo: true };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(note))
      .mockResolvedValueOnce(Response.json(state))
      .mockResolvedValueOnce(Response.json(state));
    vi.stubGlobal('fetch', fetchMock);

    await api.saveNote(note, 'save-1', 'Wednesday', [], ['suggestion-1']);
    await api.noteHistory('note-1', 'undo', 3, 'undo-1');
    await api.noteHistory('note-1', 'redo', 4, 'redo-1');

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/notes/note-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          operationId: 'save-1',
          baseRevision: 2,
          markdown: 'Wednesday',
          provenance: [],
          dismissSuggestionIds: ['suggestion-1'],
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/notes/note-1/undo',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ baseRevision: 3, operationId: 'undo-1' }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/notes/note-1/redo',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ baseRevision: 4, operationId: 'redo-1' }),
      }),
    );
  });
});

describe('atomic note persistence API transport', () => {
  it('saves all typed-over suggestion dismissals atomically', async () => {
    const note = {
      id: 'note-1',
      title: 'Note',
      markdown: 'Monday',
      revision: 2,
      provenance: [],
      createdAt: '2026-09-18T00:00:00.000Z',
      updatedAt: '2026-09-18T00:00:00.000Z',
    };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(note));
    vi.stubGlobal('fetch', fetchMock);

    await api.saveNote(note, 'save-2', 'Wednesday', [], ['suggestion-1', 'suggestion-2']);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/notes/note-1',
      expect.objectContaining({
        body: JSON.stringify({
          operationId: 'save-2',
          baseRevision: 2,
          markdown: 'Wednesday',
          provenance: [],
          dismissSuggestionIds: ['suggestion-1', 'suggestion-2'],
        }),
      }),
    );
  });
});

describe('streaming API transport', () => {
  it('streams note proposal previews through the terminal proposal', async () => {
    const preview = {
      id: 'proposal-1',
      noteId: 'note-1',
      baseRevision: 3,
      oldText: 'Before',
      newText: 'Before after',
      reason: 'Capture the useful detail',
      status: 'pending',
    } as const;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            `data: ${JSON.stringify({ type: 'preview', proposal: preview })}\n\ndata: ${JSON.stringify({ type: 'done', proposal: preview })}\n\n`,
          ),
        ),
    );
    const events: unknown[] = [];

    await streamNoteProposal(
      'message-1',
      {
        conversationId: 'conversation-1',
        branchId: 'branch-1',
        personaId: 'thinking-partner',
        noteRevision: 3,
      },
      (event) => events.push(event),
      new AbortController().signal,
    );

    expect(events).toEqual([
      { type: 'preview', proposal: preview },
      { type: 'done', proposal: preview },
    ]);
  });
});

describe('annotation stream transport', () => {
  it('streams annotations individually before the terminal collection', async () => {
    const annotation = {
      id: 'annotation-1',
      quote: 'Clear answer',
      kind: 'claim',
      whose: 'assistant',
    } as const;
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          `data: ${JSON.stringify({ type: 'annotation', annotation })}\n\ndata: ${JSON.stringify({ type: 'done', annotations: [annotation] })}\n\n`,
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const events: unknown[] = [];

    await streamMessageAnnotations(
      'message-1',
      {
        conversationId: 'conversation-1',
        branchId: 'branch-1',
        personaId: 'thinking-partner',
        noteRevision: 3,
      },
      (event) => events.push(event),
      new AbortController().signal,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/messages/message-1/annotations?stream=1',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(events).toEqual([
      { type: 'annotation', annotation },
      { type: 'done', annotations: [annotation] },
    ]);
  });
});

describe('stream interruption errors', () => {
  it('reports a note proposal stream that closes before a terminal event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('data: {"type":"preview","proposal":null}\n\n')),
    );

    await expect(
      streamNoteProposal(
        'message-1',
        {
          conversationId: 'conversation-1',
          branchId: 'branch-1',
          personaId: 'thinking-partner',
          noteRevision: null,
        },
        () => undefined,
        new AbortController().signal,
      ),
    ).rejects.toThrow('response was interrupted');
  });
});

describe('conversation API transport', () => {
  it('creates note-free conversations', async () => {
    const conversation = {
      id: 'conversation-1',
      noteId: null,
      messages: [],
      expiresAt: '2026-09-25T00:00:00.000Z',
      learningChecksEnabled: false,
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ data: conversation }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.startConversation()).resolves.toEqual(conversation);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/conversations',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
  });
});

describe('conversation history transport', () => {
  it('lists, archives, and deletes conversation history', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await api.conversations();
    await api.archiveConversation('conversation-1');
    await api.deleteConversation('conversation-1');

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/conversations', expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/conversations/conversation-1?keepNote=1',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/conversations/conversation-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

describe('authenticated conversation transport', () => {
  it('adds the current Clerk bearer token to JSON requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    setTokenProvider(async () => 'session-token');

    await api.notes();

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer session-token');
    expect(init.credentials).toBeUndefined();
  });
});

describe('token refresh transport', () => {
  it('retries one unauthorized request only after Clerk supplies a new token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ error: 'Invalid authentication token' }, { status: 401 }),
      )
      .mockResolvedValueOnce(Response.json([]));
    vi.stubGlobal('fetch', fetchMock);
    let calls = 0;
    let refreshOptions: { skipCache?: boolean } | undefined;
    setTokenProvider(async (options) => {
      refreshOptions = options;
      return calls++ === 0 ? 'expired-token' : 'fresh-token';
    });

    await api.notes();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('authorization')).toBe(
      'Bearer fresh-token',
    );
    expect(refreshOptions).toEqual({ skipCache: true });
  });
});

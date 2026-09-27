import { attachmentUrl, type WaldenUIMessage } from '@walden/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTokenProvider } from '../api';
import { buildTurnRequest, DurableTurnTransport } from '../durable-turn-transport';

afterEach(() => {
  setTokenProvider(null);
  vi.unstubAllGlobals();
});

const context = {
  conversationId: 'conversation-1',
  branchId: 'branch-1',
  noteRevision: 3,
  personaId: 'thinking-partner',
};
const user: WaldenUIMessage = {
  id: 'user-1',
  role: 'user',
  parts: [{ type: 'text', text: 'Synthetic test' }],
};
const frame = (sequence: number, chunk: unknown) =>
  `id: ${sequence}\ndata: ${JSON.stringify(chunk)}\n\n`;
const text = (sequence: number, delta: string) =>
  frame(sequence, { type: 'text-delta', id: 't', delta });

function transport(onTurn = vi.fn()) {
  return new DurableTurnTransport({
    prepare: async () => context,
    locate: () => ({ conversationId: 'conversation-1', branchId: 'branch-1' }),
    onTurn,
  });
}

function send(
  target: DurableTurnTransport,
  signal = new AbortController().signal,
  messages = [user],
) {
  return target.sendMessages({
    trigger: 'submit-message',
    chatId: 'chat',
    messageId: undefined,
    messages,
    abortSignal: signal,
    body: { requestId: 'request-1' },
  });
}

async function read(stream: ReadableStream<{ type: string }> | null) {
  const chunks: unknown[] = [];
  if (!stream) return chunks;
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

const urls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.map(([url]) => String(url));

describe('turn requests', () => {
  it('builds the chat request from the last user message and the send options', () => {
    const answered: WaldenUIMessage = {
      id: 'user-2',
      role: 'user',
      parts: [
        { type: 'file', mediaType: 'text/plain', url: attachmentUrl('conversation-1', 'file-1') },
        { type: 'text', text: 'Stroma' },
        { type: 'data-learning-check-response', data: { checkId: 'c', answers: {} } },
      ],
    };
    const request = buildTurnRequest(
      {
        trigger: 'submit-message',
        messageId: 'user-2',
        messages: [user, answered],
        body: { requestId: 'r', action: 'feedback' },
      },
      context,
    );
    expect(request).toEqual({
      ...context,
      requestId: 'r',
      action: 'feedback',
      message: 'Stroma',
      attachmentIds: ['file-1'],
      learningCheckResponse: { checkId: 'c', answers: {} },
      editMessageId: 'user-2',
    });
    expect(
      buildTurnRequest(
        { trigger: 'regenerate-message', messageId: 'assistant-1', messages: [user], body: {} },
        context,
      ),
    ).toEqual(expect.objectContaining({ regenerateMessageId: 'assistant-1', action: 'message' }));
  });
});

describe('durable turn streaming', () => {
  it('re-reads after the last event id when the server ends a response, without duplicates', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ turnId: 'turn-1' }))
      .mockResolvedValueOnce(new Response(`: keepalive\n\n${text(1, 'Par')}`))
      .mockResolvedValueOnce(new Response(`${text(1, 'Par')}${text(2, 'tial')}data: [DONE]\n\n`));
    vi.stubGlobal('fetch', fetchMock);
    const onTurn = vi.fn();
    const chunks = await read(await send(transport(onTurn)));
    expect(chunks).toEqual([
      { type: 'text-delta', id: 't', delta: 'Par' },
      { type: 'text-delta', id: 't', delta: 'tial' },
    ]);
    expect(urls(fetchMock)).toEqual([
      '/api/chat/turns',
      '/api/chat/turns/turn-1/events?after=0',
      '/api/chat/turns/turn-1/events?after=1',
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body)).toEqual(
      expect.objectContaining({ requestId: 'request-1', message: 'Synthetic test', ...context }),
    );
    expect(onTurn).toHaveBeenCalledWith({ id: 'turn-1', requestId: 'request-1' });
  });

  it('replays from the last cursor after a network outage and never cancels', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ turnId: 'turn-1' }))
      .mockResolvedValueOnce(new Response(text(1, 'A')))
      .mockRejectedValueOnce(new TypeError('Network connection lost'))
      .mockResolvedValueOnce(new Response(`${text(2, 'B')}data: [DONE]\n\n`));
    vi.stubGlobal('fetch', fetchMock);
    expect(await read(await send(transport()))).toHaveLength(2);
    expect(urls(fetchMock).slice(1)).toEqual([
      '/api/chat/turns/turn-1/events?after=0',
      '/api/chat/turns/turn-1/events?after=1',
      '/api/chat/turns/turn-1/events?after=1',
    ]);
    expect(urls(fetchMock).some((url) => url.endsWith('/cancel'))).toBe(false);
  });

  it('ends on a 204: the turn is over and nothing follows the cursor', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ turnId: 'turn-1' }))
      .mockResolvedValueOnce(new Response(text(1, 'Done')))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await read(await send(transport()))).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('stops at a reset marker instead of continuing after the discarded attempt', async () => {
    const reset = { type: 'data-turn', transient: true, data: { ...context, reset: true } };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ turnId: 'turn-1' }))
      .mockResolvedValueOnce(new Response(`${text(1, 'Old')}${frame(2, reset)}`));
    vi.stubGlobal('fetch', fetchMock);
    const chunks = await read(await send(transport()));
    expect(chunks.at(-1)).toEqual(reset);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('durable turn failures and auth', () => {
  it('rejects with the server message and does not retry a refused turn', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: 'A response is still in progress.' }, { status: 409 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    await expect(send(transport())).rejects.toThrow('A response is still in progress.');
    const limited = vi
      .fn()
      .mockResolvedValue(Response.json({ error: 'Message limit reached.' }, { status: 429 }));
    vi.stubGlobal('fetch', limited);
    await expect(send(transport())).rejects.toMatchObject({ status: 429 });
    expect(limited).toHaveBeenCalledTimes(1);
  });

  it('detaches on abort without cancelling the server turn', async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ turnId: 'turn-1' }))
      .mockResolvedValueOnce(new Response(new ReadableStream()));
    vi.stubGlobal('fetch', fetchMock);
    const reading = read(await send(transport(), controller.signal));
    controller.abort();
    await expect(reading).rejects.toThrow();
    expect(urls(fetchMock).some((url) => url.endsWith('/cancel'))).toBe(false);
  });

  it('sends the bearer token on every request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ turnId: 'turn-1' }))
      .mockResolvedValueOnce(new Response('data: [DONE]\n\n'));
    vi.stubGlobal('fetch', fetchMock);
    setTokenProvider(async () => 'fresh-token');
    await read(await send(transport()));
    for (const [, init] of fetchMock.mock.calls)
      expect(new Headers((init as RequestInit).headers).get('authorization')).toBe(
        'Bearer fresh-token',
      );
  });
});

describe('reconnecting', () => {
  it('replays the running turn of the scope from the start', async () => {
    const turn = { id: 'turn-9', requestId: 'r', conversationId: 'c', branchId: 'b' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ turn }))
      .mockResolvedValueOnce(new Response(`${text(1, 'Hi')}data: [DONE]\n\n`));
    vi.stubGlobal('fetch', fetchMock);
    const onTurn = vi.fn();
    const stream = await transport(onTurn).reconnectToStream({ chatId: 'chat' });
    expect(await read(stream)).toHaveLength(1);
    expect(urls(fetchMock)).toEqual([
      '/api/chat/turns?conversationId=conversation-1&branchId=branch-1',
      '/api/chat/turns/turn-9/events?after=0',
    ]);
    expect(onTurn).toHaveBeenCalledWith({ id: 'turn-9', requestId: 'r', resumed: turn });
  });

  it('returns null without a running turn, and follows a known turn id directly', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ turn: null }))
      .mockResolvedValueOnce(new Response('data: [DONE]\n\n'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await transport().reconnectToStream({ chatId: 'chat' })).toBeNull();
    const known = await transport().reconnectToStream({ chatId: 'chat', body: { turnId: 't-2' } });
    expect(await read(known)).toEqual([]);
    expect(urls(fetchMock).at(-1)).toBe('/api/chat/turns/t-2/events?after=0');
  });
});

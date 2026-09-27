import {
  type ChatRequest,
  uiMessageText,
  type WaldenUIMessage,
  type WaldenUIMessageChunk,
} from '@walden/contracts';
import type { ChatTransport } from 'ai';

import { ApiError, api, readSseFrames } from './api';
import { id } from './ids';

type SendOptions = Parameters<ChatTransport<WaldenUIMessage>['sendMessages']>[0];
type ReconnectOptions = Parameters<ChatTransport<WaldenUIMessage>['reconnectToStream']>[0];
export type ActiveTurn = NonNullable<Awaited<ReturnType<typeof api.activeTurn>>['turn']>;
/** Where a new turn goes, resolved just before it is sent. */
export type TurnContext = Pick<
  ChatRequest,
  'conversationId' | 'branchId' | 'noteRevision' | 'personaId'
>;
/** `body` extras a caller may pass to `sendMessage`/`regenerate`; they win over the context. */
export type TurnBody = Partial<Omit<ChatRequest, 'message' | 'learningCheckResponse'>>;

type Options = {
  /** Runs before each send (note flush, conversation creation); may throw to refuse the send. */
  prepare(input: { editing: boolean; abortSignal?: AbortSignal }): Promise<TurnContext>;
  /** The conversation and branch whose running turn a reconnect should find. */
  locate(): { conversationId: string; branchId: string } | null;
  /** The server admitted (`resumed` absent) or already had (`resumed`) this turn. */
  onTurn?(turn: {
    id: string;
    requestId: string;
    userMessageId?: string | null;
    resumed?: ActiveTurn;
  }): void;
};

/** Attachment ids are the last segment of a `file` part's `attachmentUrl`. */
export function attachmentIdFromUrl(url: string) {
  return decodeURIComponent(url.split('/').pop() ?? '');
}

export function buildTurnRequest(
  {
    trigger,
    messageId,
    messages,
    body,
  }: Pick<SendOptions, 'trigger' | 'messageId' | 'messages' | 'body'>,
  context: TurnContext,
): ChatRequest {
  const user = [...messages].reverse().find((message) => message.role === 'user');
  const extras = (body ?? {}) as TurnBody;
  const attachmentIds =
    extras.attachmentIds ??
    (user?.parts ?? []).flatMap((part) =>
      part.type === 'file' ? [attachmentIdFromUrl(part.url)] : [],
    );
  const response = user?.parts.find((part) => part.type === 'data-learning-check-response')?.data;
  return {
    requestId: id('turn'),
    action: 'message',
    ...context,
    ...extras,
    message: user ? uiMessageText(user) : '',
    ...(attachmentIds.length ? { attachmentIds } : {}),
    ...(response ? { learningCheckResponse: response } : {}),
    ...(messageId && trigger === 'regenerate-message' ? { regenerateMessageId: messageId } : {}),
    ...(messageId && trigger === 'submit-message' ? { editMessageId: messageId } : {}),
  };
}

/** Network failures and 5xx leave the durable turn running; 4xx (429 limit, 409) cannot be retried. */
function canRetry(error: unknown) {
  return (
    error instanceof TypeError ||
    (error instanceof ApiError && (error.status >= 500 || error.status === 408))
  );
}

function retryDelay(attempt: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, Math.min(500 * 2 ** Math.min(attempt, 4), 5_000));
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

async function startTurn(request: ChatRequest, signal: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    try {
      const turn = await api.startTurn(request, signal);
      if (typeof turn?.turnId !== 'string')
        throw new TypeError('The start response was incomplete.');
      return turn;
    } catch (error) {
      signal.throwIfAborted();
      if (!canRetry(error) || attempt >= 5) throw error;
      await retryDelay(attempt, signal);
    }
  }
}

/** The server retried the turn and closed this response: a replay from 0 is the new attempt. */
const isReset = (chunk: WaldenUIMessageChunk) =>
  chunk.type === 'data-turn' && chunk.data.reset === true;

/** Yields one response's new chunks; returns true once the turn needs no further reads. */
async function* readTurnResponse(
  response: Response,
  cursor: { after: number },
  signal: AbortSignal,
): AsyncGenerator<WaldenUIMessageChunk, boolean> {
  for await (const frame of readSseFrames(response, signal)) {
    const sequence = frame.id && /^\d+$/.test(frame.id) ? Number(frame.id) : undefined;
    if (sequence !== undefined && sequence <= cursor.after) continue;
    if (frame.data === '[DONE]') return true;
    const chunk = JSON.parse(frame.data) as WaldenUIMessageChunk;
    if (sequence !== undefined) cursor.after = sequence;
    yield chunk;
    if (isReset(chunk)) return true;
  }
  return false;
}

/**
 * Every chunk of the turn exactly once: re-GETs after the last seen sequence number whenever
 * the server ends a response or the network drops before `[DONE]` (or a 204: nothing follows).
 * A reset marker ends the stream; the reader restarts the turn from 0.
 */
async function* followTurn(
  turnId: string,
  signal: AbortSignal,
): AsyncGenerator<WaldenUIMessageChunk> {
  const cursor = { after: 0 };
  let attempt = 0;
  while (true) {
    const response = await api.turnEvents(turnId, cursor.after, signal).catch((error: unknown) => {
      signal.throwIfAborted();
      if (!canRetry(error)) throw error;
      return undefined;
    });
    if (response === null) return;
    if (response) {
      const seen = cursor.after;
      if (yield* readTurnResponse(response, cursor, signal)) return;
      if (cursor.after > seen) attempt = 0;
    }
    await retryDelay(attempt++, signal);
  }
}

function chunkStream(turnId: string, signal = new AbortController().signal) {
  const chunks = followTurn(turnId, signal);
  return new ReadableStream<WaldenUIMessageChunk>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
}

/**
 * Chat transport over durable server turns: a POST admits the turn, then its event log is
 * streamed (and resumed) by sequence number. Aborting only detaches; Stop cancels explicitly.
 */
export class DurableTurnTransport implements ChatTransport<WaldenUIMessage> {
  constructor(private readonly options: Options) {}

  async sendMessages(options: SendOptions) {
    const signal = options.abortSignal ?? new AbortController().signal;
    const editing = options.trigger === 'submit-message' && Boolean(options.messageId);
    const context = await this.options.prepare({ editing, abortSignal: signal });
    signal.throwIfAborted();
    const request = buildTurnRequest(options, context);
    const { turnId, userMessageId } = await startTurn(request, signal);
    this.options.onTurn?.({ id: turnId, requestId: request.requestId, userMessageId });
    return chunkStream(turnId, signal);
  }

  /** `body.turnId` replays a known turn from its start; otherwise the scope's running turn. */
  async reconnectToStream({ abortSignal, body }: ReconnectOptions) {
    const known = (body as { turnId?: string } | undefined)?.turnId;
    if (known) return chunkStream(known, abortSignal);
    const scope = this.options.locate();
    if (!scope) return null;
    const { turn } = await api.activeTurn(scope.conversationId, scope.branchId);
    if (!turn || abortSignal?.aborted) return null;
    this.options.onTurn?.({ id: turn.id, requestId: turn.requestId, resumed: turn });
    return chunkStream(turn.id, abortSignal);
  }
}

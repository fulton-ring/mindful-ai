import { toAISdkStream } from '@mastra/ai-sdk';
import type { ChunkType, MastraModelOutput } from '@mastra/core/stream';
import type { WaldenUIMessageChunk } from '@walden/contracts';
import { transientStatus } from '../chat/messages';
import { publicUrl } from '../services/research/research';
import { GemmaToolLeakDecoder, type RecoveredFrontendToolCall } from './learning-checks';
import { isLengthLimitedFinalChunk } from './stream-events';

/** What the turn needs to know about the reply once the model stream ends. */
export type UIStreamState = {
  /** Visible text, after recovering leaked frontend tool calls. */
  text: string;
  lengthLimited: boolean;
  quizToolCalled: boolean;
  /** Visible tool calls by id, to their tool name. */
  tools: Map<string, string>;
  sources: Set<string>;
  decoders: Map<string, GemmaToolLeakDecoder>;
};

type Chunk = WaldenUIMessageChunk;
type ChunkOf<T extends Chunk['type']> = Extract<Chunk, { type: T }>;
type Source = { sourceId: string; url: string; title?: string };
type OnRecoveredCall = (call: RecoveredFrontendToolCall) => void;

const MAX_TOOLS = 20;
const MAX_SOURCES = 20;
const FRONTEND_TOOLS = new Set(['proposeAsk', 'proposeLearningCheck']);
const TOOL_STATUS: Record<string, string> = {
  readWebPage: 'Reading source…',
  searchSources: 'Searching sources…',
  searchWeb: 'Searching the web…',
  listWebLinks: 'Listing page links…',
  screenshotWebPage: 'Capturing page…',
};
const TOOL_ERROR: Record<string, string> = {
  readWebPage: 'Could not read source',
  searchSources: 'Could not search sources',
  searchWeb: 'Web search failed',
  listWebLinks: 'Could not list page links',
  screenshotWebPage: 'Could not capture page',
};
const SOURCE_TOOLS = new Set(['searchWeb', 'searchSources', 'readWebPage', 'screenshotWebPage']);

export const newUIStreamState = (): UIStreamState => ({
  text: '',
  lengthLimited: false,
  quizToolCalled: false,
  tools: new Map(),
  sources: new Set(),
  decoders: new Map(),
});

const safeToolName = (name: string) => name.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 100) || 'tool';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Tool parts carry only a public query or URL, never raw tool arguments. */
function publicToolInput(name: string, input: unknown): { query?: string } {
  if (!isRecord(input)) return {};
  const key =
    name === 'searchWeb' || name === 'searchSources'
      ? 'query'
      : name === 'listWebLinks' || name === 'screenshotWebPage'
        ? 'url'
        : null;
  const value = key ? input[key] : undefined;
  return typeof value === 'string' && value.trim() ? { query: value.trim().slice(0, 500) } : {};
}

function publicSource(id: string, url: unknown, title?: unknown): Source | null {
  if (typeof url !== 'string') return null;
  try {
    return {
      sourceId: id.slice(0, 200),
      url: publicUrl(url).toString(),
      ...(typeof title === 'string' && title.trim() ? { title: title.trim().slice(0, 300) } : {}),
    };
  } catch {
    return null;
  }
}

function resultSources(name: string, toolCallId: string, result: Record<string, unknown>) {
  const found: Source[] = [];
  const add = (source: Source | null) => {
    if (source && !found.some(({ url }) => url === source.url)) found.push(source);
  };
  if (name === 'readWebPage' || name === 'screenshotWebPage')
    add(publicSource(`${toolCallId}:0`, result.url));
  if ((name === 'searchSources' || name === 'searchWeb') && Array.isArray(result.results))
    for (const [index, item] of result.results.slice(0, MAX_SOURCES).entries())
      if (isRecord(item)) add(publicSource(`${toolCallId}:${index}`, item.url, item.title));
  return found;
}

function sourceChunks(state: UIStreamState, sources: Source[]): Chunk[] {
  return sources.flatMap((source) => {
    if (state.sources.has(source.url) || state.sources.size >= MAX_SOURCES) return [];
    state.sources.add(source.url);
    return [{ type: 'source-url' as const, ...source }];
  });
}

function toolCallChunks(chunk: ChunkOf<'tool-input-available'>, state: UIStreamState): Chunk[] {
  const { toolCallId, toolName } = chunk;
  if (toolName === 'proposeLearningCheck') state.quizToolCalled = true;
  // Frontend proposals surface as a data-intervention part instead.
  if (FRONTEND_TOOLS.has(toolName) || state.tools.size >= MAX_TOOLS) return [];
  state.tools.set(toolCallId, toolName);
  const status = TOOL_STATUS[toolName];
  return [
    {
      type: 'tool-input-available',
      toolCallId,
      toolName: safeToolName(toolName),
      input: publicToolInput(toolName, chunk.input),
    },
    ...(status ? [transientStatus(status)] : []),
  ];
}

/**
 * A failed tool is shown as failed and never ends the reply: the model receives
 * the tool's error (which says a failed search is not an empty one) and carries on.
 */
function* toolErrorChunks(toolCallId: string, name: string): Generator<Chunk> {
  yield { type: 'tool-output-error', toolCallId, errorText: TOOL_ERROR[name] ?? 'Tool failed' };
}

function* toolResultChunks(
  chunk: ChunkOf<'tool-output-available'>,
  state: UIStreamState,
): Generator<Chunk> {
  const name = state.tools.get(chunk.toolCallId);
  if (!name) return;
  const result = isRecord(chunk.output) ? chunk.output : {};
  if (result.error === true) return yield* toolErrorChunks(chunk.toolCallId, name);
  const sources = resultSources(name, chunk.toolCallId, result);
  yield* sourceChunks(state, sources);
  const notIndexed =
    name === 'readWebPage' && isRecord(result.indexing) && result.indexing.status === 'failed';
  yield {
    type: 'tool-output-available',
    toolCallId: chunk.toolCallId,
    output: {
      ...(SOURCE_TOOLS.has(name)
        ? { sources: sources.map(({ url, title }) => ({ url, ...(title ? { title } : {}) })) }
        : {}),
      ...(notIndexed ? { summary: 'Read, but not saved to search' } : {}),
    },
  };
}

function textChunks(chunk: Chunk, state: UIStreamState, onCall: OnRecoveredCall): Chunk[] {
  if (chunk.type === 'text-start') {
    state.decoders.set(chunk.id, new GemmaToolLeakDecoder());
    return [{ type: 'text-start', id: chunk.id }];
  }
  if (chunk.type !== 'text-delta' && chunk.type !== 'text-end') return [];
  const decoder = state.decoders.get(chunk.id) ?? new GemmaToolLeakDecoder();
  state.decoders.set(chunk.id, decoder);
  const decoded =
    chunk.type === 'text-delta' ? decoder.push(chunk.delta) : { text: decoder.finish(), calls: [] };
  decoded.calls.forEach(onCall);
  state.text += decoded.text;
  const delta: Chunk[] = decoded.text
    ? [{ type: 'text-delta', id: chunk.id, delta: decoded.text }]
    : [];
  return chunk.type === 'text-end' ? [...delta, { type: 'text-end', id: chunk.id }] : delta;
}

function* visibleChunks(
  chunk: Chunk,
  state: UIStreamState,
  onCall: OnRecoveredCall,
): Generator<Chunk> {
  switch (chunk.type) {
    case 'reasoning-start':
    case 'reasoning-end':
      return yield { type: chunk.type, id: chunk.id };
    case 'reasoning-delta':
      return yield { type: chunk.type, id: chunk.id, delta: chunk.delta };
    case 'start-step':
    case 'finish-step':
      return yield { type: chunk.type };
    case 'tool-input-available':
      return yield* toolCallChunks(chunk, state);
    case 'tool-output-available':
      return yield* toolResultChunks(chunk, state);
    case 'tool-output-error': {
      const name = state.tools.get(chunk.toolCallId);
      return name ? yield* toolErrorChunks(chunk.toolCallId, name) : undefined;
    }
    case 'source-url':
      return yield* sourceChunks(
        state,
        [publicSource(chunk.sourceId, chunk.url, chunk.title)].filter((item) => item !== null),
      );
    default:
      yield* textChunks(chunk, state, onCall);
  }
}

async function* readStream<T>(stream: ReadableStream<T>): AsyncGenerator<T> {
  const reader = stream.getReader();
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) yield next.value;
  } finally {
    reader.releaseLock();
  }
}

/** Records the model's finish state and fails the turn on a stream error. */
async function* observeModelChunks(
  stream: ReadableStream<ChunkType>,
  state: UIStreamState,
): AsyncGenerator<ChunkType> {
  for await (const chunk of readStream(stream)) {
    if (
      (chunk.type === 'finish' || chunk.type === 'step-finish') &&
      isLengthLimitedFinalChunk(chunk)
    )
      state.lengthLimited = true;
    if (chunk.type === 'error')
      throw chunk.payload.error instanceof Error
        ? chunk.payload.error
        : new Error('The model stream failed.');
    yield chunk;
  }
}

function toStream<T>(iterator: AsyncIterator<T>): ReadableStream<T> {
  return new ReadableStream<T>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

/**
 * The agent's reply as UI message chunks: text, reasoning, tool calls reduced
 * to their public query and sources, and `source-url` parts. The caller writes
 * `start` and `finish`.
 */
export async function* agentUIChunks(
  fullStream: MastraModelOutput<undefined>['fullStream'],
  turnId: string,
  state: UIStreamState,
  onRecoveredCall: OnRecoveredCall,
): AsyncGenerator<Chunk> {
  const model = fullStream as unknown as ReadableStream<ChunkType>;
  const source = { fullStream: toStream(observeModelChunks(model, state)) };
  const ui = toAISdkStream(source as unknown as MastraModelOutput<unknown>, {
    from: 'agent',
    version: 'v6',
    lastMessageId: turnId,
    sendStart: false,
    sendFinish: false,
    sendReasoning: true,
    sendSources: true,
  }) as unknown as ReadableStream<Chunk>;
  for await (const chunk of readStream(ui)) yield* visibleChunks(chunk, state, onRecoveredCall);
}

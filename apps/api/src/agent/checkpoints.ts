import type { LanguageModelV3, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { WaldenUIMessageChunk } from '@walden/contracts';

/** Live, provisional output of a durable turn, written to the turn's chunk stream. */
export type ChunkPreview = {
  /** Position to rewind to; the count of chunks written so far. */
  mark(): number;
  write(chunks: WaldenUIMessageChunk[]): Promise<void>;
  /** Discards everything written after `mark`, for a retried model call. */
  rewind(mark: number): Promise<void>;
};

/** Each callback is an independently persisted operation, never an entire agent turn. */
export type AgentCheckpoints = {
  preview?: ChunkPreview;
  do<T>(name: string, callback: () => Promise<T>, options?: { retries?: number }): Promise<T>;
};

// Leave room for Workflow's result envelope below its 1 MiB limit.
const MAX_CHECKPOINT_BYTES = 900_000;
const TYPE = '__walden_checkpoint_type__';
function encode(value: unknown): string {
  const serialized = JSON.stringify({ value }, function (key, item) {
    const original = this[key];
    if (original instanceof Date) return { [TYPE]: 'date', value: original.toISOString() };
    if (original instanceof Uint8Array) return { [TYPE]: 'bytes', value: Array.from(original) };
    if (original instanceof Error)
      return { [TYPE]: 'error', name: original.name, message: original.message };
    return item;
  });
  if (new TextEncoder().encode(JSON.stringify(serialized)).byteLength > MAX_CHECKPOINT_BYTES)
    throw new Error('Agent checkpoint exceeds the durable result size limit.');
  return serialized;
}
function decode<T>(value: string): T {
  return JSON.parse(value, (_key, item) => {
    if (item?.[TYPE] === 'date') return new Date(item.value);
    if (item?.[TYPE] === 'bytes') return new Uint8Array(item.value);
    if (item?.[TYPE] === 'error')
      return Object.assign(new Error(item.message), { name: item.name });
    return item;
  }).value as T;
}

type StreamPart = LanguageModelV3StreamPart;
type StreamOptions = Parameters<LanguageModelV3['doStream']>[0];

/** Receives a model call's text and reasoning parts as they stream, keyed by call. */
export type ModelProgress = {
  begin(call: string): Promise<void>;
  parts(call: string, parts: StreamPart[]): Promise<void>;
  end(call: string): Promise<void>;
};

const PREVIEW_PARTS = new Set<StreamPart['type']>([
  'text-start',
  'text-delta',
  'text-end',
  'reasoning-start',
  'reasoning-delta',
  'reasoning-end',
]);

type StreamState = { pending: StreamPart[]; finished: boolean };

function recordStreamPart(part: StreamPart, parts: StreamPart[], state: StreamState) {
  if (part.type === 'error')
    throw part.error instanceof Error ? part.error : new Error('Model stream failed.');
  if (part.type === 'raw') return;
  if (part.type === 'finish') state.finished = true;
  parts.push(part);
  if (PREVIEW_PARTS.has(part.type)) state.pending.push(part);
}

async function readWithIdleFlush(
  reader: ReadableStreamDefaultReader<StreamPart>,
  onPart: (part: StreamPart) => void,
  flush: (idle: boolean) => Promise<void>,
  hasPending: () => boolean,
) {
  let nextRead = reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    while (true) {
      const next = hasPending()
        ? await Promise.race([
            nextRead,
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), 100);
            }),
          ])
        : await nextRead;
      clearTimeout(timer);
      if (next === null) {
        await flush(true);
        continue;
      }
      if (next.done) return;
      nextRead = reader.read();
      onPart(next.value);
      await flush(false);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function collectStreamParts(
  model: LanguageModelV3,
  options: StreamOptions,
  name: string,
  progress?: ModelProgress,
): Promise<string> {
  await progress?.begin(name);
  const { stream } = await model.doStream(options);
  const parts: StreamPart[] = [];
  const state: StreamState = { pending: [], finished: false };
  let publishedAt = 0;
  const flush = async (idle: boolean) => {
    if (!progress || !state.pending.length || (!idle && Date.now() - publishedAt < 100)) return;
    await progress.parts(name, state.pending.splice(0));
    publishedAt = Date.now();
  };
  const reader = stream.getReader();
  try {
    await readWithIdleFlush(
      reader,
      (part) => recordStreamPart(part, parts, state),
      flush,
      () => Boolean(progress && state.pending.length),
    );
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (!state.finished) throw new Error('Model stream ended without a finish event.');
  await flush(true);
  await progress?.end(name);
  return encode(parts);
}

async function replayStreamParts(saved: string, name: string, progress?: ModelProgress) {
  const parts = decode<StreamPart[]>(saved);
  if (progress) {
    // A call restored from its checkpoint was not previewed in this execution.
    await progress.begin(name);
    await progress.parts(
      name,
      parts.filter((part) => PREVIEW_PARTS.has(part.type)),
    );
    await progress.end(name);
  }
  return {
    stream: new ReadableStream<StreamPart>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
  };
}

/** Publish provisional output while checkpointing the complete response for Mastra. */
export function checkpointModel(
  model: LanguageModelV3,
  checkpoints: AgentCheckpoints,
  scope: string,
  checkpointOptions?: { retries?: number },
  progress?: ModelProgress,
): LanguageModelV3 {
  let call = 0;
  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    async doGenerate(options) {
      const saved = await checkpoints.do(
        `${scope}-generate-${++call}`,
        async () => {
          const { request: _request, response, ...result } = await model.doGenerate(options);
          return encode({
            ...result,
            ...(response
              ? {
                  response: {
                    id: response.id,
                    timestamp: response.timestamp,
                    modelId: response.modelId,
                  },
                }
              : {}),
          });
        },
        checkpointOptions,
      );
      return decode(saved);
    },
    async doStream(options) {
      const name = `${scope}-stream-${++call}`;
      let live = false;
      const saved = await checkpoints.do(
        name,
        async () => {
          const parts = await collectStreamParts(model, options, name, progress);
          live = true;
          return parts;
        },
        checkpointOptions,
      );
      return replayStreamParts(saved, name, live ? undefined : progress);
    },
  };
}

type ExecutableTool = { execute?: (...args: never[]) => Promise<unknown> };
/** Local proposal reducers deliberately remain outside this wrapper. */
export function checkpointTools<T extends Record<string, ExecutableTool>>(
  tools: T,
  checkpoints: AgentCheckpoints,
  afterResult?: (name: string, result: unknown) => void,
): T {
  let call = 0;
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      {
        ...tool,
        ...(tool.execute
          ? {
              execute: async (...args: never[]) => {
                const saved = await checkpoints.do(
                  `chat-tool-${++call}-${name}`,
                  async () => {
                    let outcome: { ok: true; value: unknown } | { ok: false; error: Error };
                    try {
                      outcome = { ok: true, value: await tool.execute!(...args) };
                    } catch (error) {
                      outcome = {
                        ok: false,
                        error: error instanceof Error ? error : new Error(String(error)),
                      };
                    }
                    return encode(outcome);
                  },
                  { retries: 0 },
                );
                const outcome = decode<{ ok: true; value: unknown } | { ok: false; error: Error }>(
                  saved,
                );
                if (!outcome.ok) throw outcome.error;
                afterResult?.(name, outcome.value);
                return outcome.value;
              },
            }
          : {}),
      },
    ]),
  ) as T;
}

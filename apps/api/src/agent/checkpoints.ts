import type { LanguageModelV3, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { ChatEvent } from '@walden/contracts';

/** Each callback is an independently persisted operation, never an entire agent turn. */
export type AgentCheckpoints = {
  publish?: (event: ChatEvent) => Promise<void>;
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

export type ModelProgress = (
  step: string,
  text: string,
  reasoning: string,
  complete: boolean,
) => Promise<void>;

type StreamPart = LanguageModelV3StreamPart;
type StreamOptions = Parameters<LanguageModelV3['doStream']>[0];

type StreamState = { text: string; reasoning: string; dirty: boolean; finished: boolean };

function recordStreamPart(part: StreamPart, parts: StreamPart[], state: StreamState) {
  if (part.type === 'error')
    throw part.error instanceof Error ? part.error : new Error('Model stream failed.');
  if (part.type === 'raw') return;
  if (part.type === 'finish') state.finished = true;
  parts.push(part);
  if (part.type === 'text-delta') {
    state.text += part.delta;
    state.dirty = true;
  }
  if (part.type === 'reasoning-delta') {
    state.reasoning += part.delta;
    state.dirty = true;
  }
}

async function collectStreamParts(
  model: LanguageModelV3,
  options: StreamOptions,
  name: string,
  progress?: ModelProgress,
): Promise<string> {
  await progress?.(name, '', '', false);
  const { stream } = await model.doStream(options);
  const parts: StreamPart[] = [];
  const state: StreamState = { text: '', reasoning: '', finished: false, dirty: false };
  let publishedAt = 0;
  const publish = async () => {
    if (!state.dirty || !progress) return;
    await progress(name, state.text, state.reasoning, false);
    state.dirty = false;
    publishedAt = Date.now();
  };
  const reader = stream.getReader();
  let nextRead = reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    while (true) {
      const next =
        state.dirty && progress
          ? await Promise.race([
              nextRead,
              new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), 100);
              }),
            ])
          : await nextRead;
      clearTimeout(timer);
      if (next === null) {
        await publish();
        continue;
      }
      if (next.done) break;
      nextRead = reader.read();
      recordStreamPart(next.value, parts, state);
      if (Date.now() - publishedAt >= 100) await publish();
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (!state.finished) throw new Error('Model stream ended without a finish event.');
  return encode(parts);
}

async function replayStreamParts(saved: string, name: string, progress?: ModelProgress) {
  const parts = decode<StreamPart[]>(saved);
  await progress?.(
    name,
    parts
      .filter((part) => part.type === 'text-delta')
      .map((part) => part.delta)
      .join(''),
    parts
      .filter((part) => part.type === 'reasoning-delta')
      .map((part) => part.delta)
      .join(''),
    true,
  );
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
      const saved = await checkpoints.do(
        name,
        () => collectStreamParts(model, options, name, progress),
        checkpointOptions,
      );
      return replayStreamParts(saved, name, progress);
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

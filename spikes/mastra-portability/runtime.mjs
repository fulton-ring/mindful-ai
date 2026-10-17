import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent } from '@mastra/core/agent';
import { DurableAgent, EventedAgent } from '@mastra/core/agent/durable';
import { Mastra } from '@mastra/core/mastra';
import { createTool } from '@mastra/core/tools';
import { LibSQLStore } from '@mastra/libsql';
import { PostgresStore } from '@mastra/pg';
import { RedisServerCache } from '@mastra/redis';
import { RedisStreamsPubSub } from '@mastra/redis-streams';
import Redis from 'ioredis';
import { z } from 'zod';

const usage = {
  inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

/** A deterministic provider boundary; all orchestration, storage and streams are real. */
export function fixtureModel({ record = () => {}, wait = async () => {}, mode = 'text' } = {}) {
  return {
    specificationVersion: 'v3',
    provider: 'spike',
    modelId: 'deterministic',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('The spike expects streamed model calls');
    },
    async doStream(options) {
      record('model-call');
      const hasToolResult = options.prompt.some((message) => message.role === 'tool');
      return {
        stream: new ReadableStream({
          async start(controller) {
            const emit = (part) => controller.enqueue(part);
            emit({ type: 'stream-start', warnings: [] });
            try {
              if (mode === 'tool' && !hasToolResult) {
                emit({
                  type: 'tool-call',
                  toolCallId: 'write-note-1',
                  toolName: 'writeNote',
                  input: '{"text":"kept"}',
                });
                emit({
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
                  usage,
                });
              } else {
                emit({ type: 'text-start', id: 'answer' });
                emit({
                  type: 'text-delta',
                  id: 'answer',
                  delta: mode === 'tool' ? 'Saved.' : 'Hello ',
                });
                await wait('model', options.abortSignal);
                if (mode !== 'tool') emit({ type: 'text-delta', id: 'answer', delta: 'world.' });
                emit({ type: 'text-end', id: 'answer' });
                emit({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
              }
              controller.close();
            } catch (error) {
              record('model-aborted');
              controller.error(error);
            }
          },
        }),
      };
    },
  };
}

function effectTool({ dir, deduplicate }, record, wait) {
  // This ledger represents a tool effect outside Mastra's workflow transaction.
  const effectsDb = new DatabaseSync(join(dir, 'effects.sqlite'));
  effectsDb.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS effects(id INTEGER PRIMARY KEY, effect_key TEXT UNIQUE, text TEXT)',
  );
  const writeNote = createTool({
    id: 'writeNote',
    description: 'Persist a note for the portability experiment',
    inputSchema: z.object({ text: z.string() }),
    execute: async ({ text }, context) => {
      record('tool-enter');
      await wait('tool-before-write', context?.abortSignal);
      effectsDb
        .prepare('INSERT OR IGNORE INTO effects(effect_key, text) VALUES (?, ?)')
        .run(deduplicate ? 'logical-turn:write-note-1' : crypto.randomUUID(), text);
      record('tool-written');
      await wait('tool-after-write', context?.abortSignal);
      record('tool-returned');
      return { saved: true };
    },
  });
  return { effectsDb, writeNote };
}

export async function createRuntime(config, notify = () => {}) {
  const { dir, kind = 'durable', hold, mode, redisUrl } = config;
  mkdirSync(dir, { recursive: true });
  const record = (type) => {
    appendFileSync(join(dir, 'ledger.jsonl'), `${JSON.stringify({ type, pid: process.pid })}\n`);
    notify({ event: type });
  };
  const wait = async (phase, signal) => {
    if (hold !== phase) return;
    while (!existsSync(join(dir, 'release'))) {
      signal?.throwIfAborted();
      await delay(10, undefined, { signal });
    }
  };
  const { effectsDb, writeNote } = effectTool(config, record, wait);
  const base = new Agent({
    id: 'portability-spike',
    name: 'Portability spike',
    instructions: 'Use writeNote when requested, then answer.',
    model: fixtureModel({ record, wait, mode }),
    tools: { writeNote },
  });
  const storage = process.env.SPIKE_DATABASE_URL
    ? new PostgresStore({
        id: 'spike-store',
        connectionString: process.env.SPIKE_DATABASE_URL,
        schemaName: `spike_${dir.split('/').at(-1).replaceAll('-', '_').toLowerCase()}`,
      })
    : new LibSQLStore({ id: 'spike-store', url: `file:${join(dir, 'mastra.sqlite')}` });
  await storage.init();
  const redis = redisUrl ? new Redis(redisUrl) : undefined;
  const pubsub = redisUrl
    ? new RedisStreamsPubSub({
        url: redisUrl,
        keyPrefix: `spike:${dir.split('/').at(-1)}`,
        blockMs: 50,
      })
    : undefined;
  const cache = redis
    ? new RedisServerCache(
        { client: redis },
        { keyPrefix: `spike:${dir.split('/').at(-1)}:cache:` },
      )
    : undefined;
  const Wrapper = kind === 'evented' ? EventedAgent : DurableAgent;
  const agent = new Wrapper({
    agent: base,
    cleanupTimeoutMs: 0,
    maxSteps: 4,
    ...(pubsub && { pubsub }),
    ...(cache && { cache }),
  });
  const mastra = new Mastra({
    agents: { spike: agent },
    storage,
    logger: false,
    recovery: { durableAgents: 'auto' },
    ...(pubsub && { pubsub }),
  });
  return {
    agent,
    mastra,
    storage,
    effects: () => effectsDb.prepare('SELECT * FROM effects ORDER BY id').all(),
    async close() {
      await mastra.shutdown({ drainTimeout: 100 });
      await pubsub?.close();
      redis?.disconnect();
      effectsDb.close();
      await storage.close();
    },
  };
}

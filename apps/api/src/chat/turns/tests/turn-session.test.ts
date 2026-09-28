import { DEFAULT_PERSONAS, type WaldenUIMessage } from '@walden/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../../../types';

const mocks = vi.hoisted(() => ({ streamTurn: vi.fn(), updateMemory: vi.fn() }));
vi.mock('../../../services/agent/agent', () => ({
  createAgentService: () => ({ streamTurn: mocks.streamTurn, updateMemory: mocks.updateMemory }),
  modelNameForPersona: () => 'test-model',
}));

import { HEARTBEAT_MS, RETENTION_MS, TurnSession } from '../turn-session';
import { memoryTurnStorage, readTurnStream, turnFixture } from './turn-fixture';

async function setup() {
  const db = await turnFixture();
  const input = {
    conversation: { title: 'Title', expiresAt: '2999-01-01' },
    persona: DEFAULT_PERSONAS[0],
  };
  await db
    .prepare("UPDATE turns SET input_json=? WHERE id='turn'")
    .bind(JSON.stringify(input))
    .run();
  const env = { DB: db } as unknown as Bindings;
  const storage = memoryTurnStorage();
  const session = () => new TurnSession(env, storage, (task) => void task.catch(() => {}));
  return { db, storage, session };
}

const turnStatus = async (db: D1Database) =>
  (await db.prepare("SELECT status FROM turns WHERE id='turn'").first<{ status: string }>())
    ?.status;
const reply = async (db: D1Database) => {
  const row = await db
    .prepare("SELECT ui_message FROM messages WHERE id='turn'")
    .first<{ ui_message: string }>();
  return row && (JSON.parse(row.ui_message) as WaldenUIMessage);
};

/** Streams some text, then ends quietly once aborted, as the agent stream does. */
function partialUntilAborted(started: () => void) {
  mocks.streamTurn.mockImplementation(async (_input: unknown, signal: AbortSignal) =>
    (async function* () {
      yield { type: 'text-start', id: 't' } as const;
      yield { type: 'text-delta', id: 't', delta: 'Partial' } as const;
      started();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    })(),
  );
}

beforeEach(() => vi.clearAllMocks());

describe('turn session: Stop', () => {
  it('keeps what streamed as an interrupted reply even when the agent ends quietly', async () => {
    const { db, session } = await setup();
    let streaming!: () => void;
    const started = new Promise<void>((resolve) => {
      streaming = resolve;
    });
    partialUntilAborted(streaming);
    const turn = session();
    const reader = readTurnStream(await turn.stream('turn', 0));
    await started;
    expect(await turn.stop('turn')).toBe(true);
    const { chunks, done } = await reader;
    expect(done).toBe(true);
    expect(chunks.slice(-2)).toEqual([
      { type: 'error', errorText: 'Turn cancelled' },
      { type: 'finish', finishReason: 'error', messageMetadata: { status: 'interrupted' } },
    ]);
    expect(await turnStatus(db)).toBe('cancelled');
    expect(await reply(db)).toMatchObject({
      metadata: { status: 'interrupted' },
      parts: [{ type: 'text', text: 'Partial', state: 'done' }],
    });
  });

  it('seals a turn it never started as cancelled without running it', async () => {
    const { db, session } = await setup();
    expect(await session().stop('turn')).toBe(true);
    expect(mocks.streamTurn).not.toHaveBeenCalled();
    expect(await turnStatus(db)).toBe('cancelled');
  });
});

describe('turn session: lost runs and alarms', () => {
  it('keeps a running turn alive with a heartbeat alarm', async () => {
    const { storage, session } = await setup();
    partialUntilAborted(() => {});
    const turn = session();
    await turn.start('turn');
    const before = Date.now();
    await turn.alarm();
    expect(storage.alarmAt).toBeGreaterThanOrEqual(before + HEARTBEAT_MS);
    await turn.stop('turn');
  });

  it('seals a run lost to a restart as interrupted, with what it had streamed', async () => {
    const { db, storage, session } = await setup();
    partialUntilAborted(() => {});
    const first = session();
    const reader = readTurnStream(await first.stream('turn', 0));
    await vi.waitFor(() => expect(storage.chunks().length).toBeGreaterThan(4));
    // A new instance over the same storage: the object restarted mid-run.
    await session().alarm();
    expect(await turnStatus(db)).toBe('failed');
    expect(await reply(db)).toMatchObject({
      metadata: { status: 'interrupted' },
      parts: [{ type: 'text', text: 'Partial' }],
    });
    const replay = await readTurnStream(await session().stream('turn', 0));
    expect(replay.chunks.at(-2)).toEqual({
      type: 'error',
      errorText: 'The response was interrupted. Please try again.',
    });
    expect(replay.done).toBe(true);
    await first.stop('turn');
    await reader;
  });

  it('clears an ended turn once its retention has passed', async () => {
    const { storage, session } = await setup();
    mocks.streamTurn.mockResolvedValue((async function* () {})());
    const turn = session();
    await readTurnStream(await turn.stream('turn', 0));
    // Readers finish at [DONE]; the run settles after updating memory.
    await vi.waitFor(() =>
      expect(storage.alarmAt).toBeGreaterThan(Date.now() + RETENTION_MS - 5_000),
    );
    vi.useFakeTimers({ now: Date.now() + RETENTION_MS + 1 });
    try {
      await turn.alarm();
    } finally {
      vi.useRealTimers();
    }
    expect(await storage.state()).toBeUndefined();
    expect(storage.chunks()).toEqual([]);
  });
});

describe('turn session: memory after the reply', () => {
  it('updates memory with the saved reply after readers have it, and not after a Stop', async () => {
    const { db, session } = await setup();
    mocks.streamTurn.mockResolvedValue(
      (async function* () {
        yield { type: 'text-start', id: 't' } as const;
        yield { type: 'text-delta', id: 't', delta: 'Saved answer' } as const;
        yield { type: 'text-end', id: 't' } as const;
      })(),
    );
    await readTurnStream(await session().stream('turn', 0));
    await vi.waitFor(() => expect(mocks.updateMemory).toHaveBeenCalledOnce());
    const [input] = mocks.updateMemory.mock.calls[0]!;
    expect(input.conversation.messages.map(({ id }: { id: string }) => id)).toEqual([
      'user',
      'turn',
    ]);
    expect(await turnStatus(db)).toBe('completed');

    const stopped = await setup();
    let streaming!: () => void;
    const started = new Promise<void>((resolve) => {
      streaming = resolve;
    });
    partialUntilAborted(streaming);
    mocks.updateMemory.mockClear();
    const turn = stopped.session();
    const reader = readTurnStream(await turn.stream('turn', 0));
    await started;
    await turn.stop('turn');
    await reader;
    expect(mocks.updateMemory).not.toHaveBeenCalled();
  });
});

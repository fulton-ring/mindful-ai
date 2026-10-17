import type { WaldenUIMessageChunk } from '@walden/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChunkLog } from '../chunk-log';
import { readTurnStream } from './turn-fixture';

const reply = (text: string): WaldenUIMessageChunk[] => [
  { type: 'start', messageId: 'turn', messageMetadata: { createdAt: 't0' } },
  { type: 'start-step' },
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: text },
  { type: 'text-end', id: 't' },
  { type: 'finish-step' },
  { type: 'finish', finishReason: 'stop' },
];

async function endedLog(chunks: WaldenUIMessageChunk[]) {
  const log = new ChunkLog();
  await log.append(...chunks);
  log.end();
  return log;
}

afterEach(() => vi.useRealTimers());

describe('turn chunk log: replay', () => {
  it('replays an ended turn from the start, numbered from 1, ending in [DONE]', async () => {
    const response = (await endedLog(reply('Hello'))).response(0);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    const { chunks, done, ids } = await readTurnStream(response);
    expect(chunks).toEqual(reply('Hello'));
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(done).toBe(true);
  });

  it('resumes after a cursor with only the later chunks', async () => {
    const { chunks, ids } = await readTurnStream((await endedLog(reply('Hello'))).response(4));
    expect(chunks).toEqual(reply('Hello').slice(4));
    expect(ids[0]).toBe(5);
  });

  it('answers 204 for an ended turn with nothing after the cursor', async () => {
    expect((await endedLog(reply('Hello'))).response(7).status).toBe(204);
  });

  it('persists every appended chunk with its sequence number', async () => {
    const persisted: [number, WaldenUIMessageChunk][] = [];
    const log = new ChunkLog([], false, (seq, chunk) => persisted.push([seq, chunk]));
    await log.append(...reply('Hi').slice(0, 2));
    expect(persisted).toEqual([
      [1, reply('Hi')[0]],
      [2, reply('Hi')[1]],
    ]);
  });
});

describe('turn chunk log: live readers', () => {
  it('sends what streamed so far, then live chunks to every reader until the turn ends', async () => {
    const log = new ChunkLog();
    const [first, ...rest] = reply('Live');
    await log.append(first!);
    const early = readTurnStream(log.response(0));
    await log.append(rest[0]!);
    const late = readTurnStream(log.response(1));
    await log.append(...rest.slice(1));
    log.end();
    expect((await early).chunks).toEqual(reply('Live'));
    expect((await late).chunks).toEqual(reply('Live').slice(1));
    expect((await late).done).toBe(true);
  });

  it('refuses chunks after the turn ended', async () => {
    await expect((await endedLog(reply('Done'))).append({ type: 'start-step' })).rejects.toThrow();
  });

  it('keeps a live reader open with keepalive comments', async () => {
    vi.useFakeTimers();
    const log = new ChunkLog();
    const reader = log.response(0).body!.pipeThrough(new TextDecoderStream()).getReader();
    vi.advanceTimersByTime(15_000);
    expect((await reader.read()).value).toBe(': keepalive\n\n');
    await reader.cancel();
  });
});

it('does not expose a chunk until its durable write completes', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const log = new ChunkLog([], false, () => pending);
  const writing = log.append({ type: 'start-step' });
  expect(log.chunks).toEqual([]);
  release();
  await writing;
  expect(log.chunks).toEqual([{ type: 'start-step' }]);
});

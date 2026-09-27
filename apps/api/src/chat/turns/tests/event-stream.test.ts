import type { WaldenUIMessageChunk } from '@walden/contracts';
import { describe, expect, it } from 'vitest';
import {
  appendTurnChunks,
  beginTurnExecution,
  cancelTurn,
  completeTurn,
  type DurableTurnRow,
} from '../durable-store';
import { createTurnEventsResponse } from '../event-stream';
import { turnFixture } from './turn-fixture';

const TURN = { id: 'turn', conversation_id: 'conversation', branch_id: 'branch' };
const reply = (text: string): WaldenUIMessageChunk[] => [
  { type: 'start', messageId: 'turn', messageMetadata: { createdAt: 't0' } },
  { type: 'data-turn', transient: true, data: { conversationId: 'c', branchId: 'b' } },
  { type: 'start-step' },
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: text },
  { type: 'text-delta', id: 't', delta: '!' },
  { type: 'text-end', id: 't' },
  { type: 'finish-step' },
];

type Frame = { id?: number; data: string };

/** Reads SSE frames until the server closes, or until `limit` data frames arrived. */
async function readFrames(response: Response, limit = Number.POSITIVE_INFINITY) {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  const frames: Frame[] = [];
  const comments: string[] = [];
  while (frames.length < limit) {
    const next = await reader.read();
    if (next.done) break;
    buffer += next.value;
    for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (block.startsWith(':')) comments.push(block);
      else {
        const id = /^id: (\d+)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)![1]!;
        frames.push({ ...(id ? { id: Number(id) } : {}), data });
      }
      if (frames.length >= limit || comments.length) break;
    }
    if (comments.length) break;
  }
  await reader.cancel();
  return { frames, comments };
}

const chunksOf = (frames: Frame[]) =>
  frames
    .filter(({ data }) => data !== '[DONE]')
    .map(({ data }) => JSON.parse(data) as WaldenUIMessageChunk);

/** Every part delta and end follows its start, and nothing follows `finish`. */
function expectWellFormed(chunks: WaldenUIMessageChunk[]) {
  const open = new Set<string>();
  chunks.forEach((chunk, index) => {
    if (chunk.type === 'text-start' || chunk.type === 'reasoning-start') open.add(chunk.id);
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')
      expect(open.has(chunk.id)).toBe(true);
    if (chunk.type === 'text-end' || chunk.type === 'reasoning-end')
      expect(open.delete(chunk.id)).toBe(true);
    if (chunk.type === 'finish') expect(index).toBe(chunks.length - 1);
  });
}

const turnRow = async (db: D1Database) =>
  (await db.prepare("SELECT * FROM turns WHERE id='turn'").first<DurableTurnRow>())!;

describe('turn events endpoint', () => {
  it('replays a finished turn from seq 0 as one well-formed stream ending in [DONE]', async () => {
    const db = await turnFixture();
    const epoch = (await beginTurnExecution(db, TURN))!;
    await appendTurnChunks(db, 'turn', epoch, reply('Hello'));
    await completeTurn(db, 'turn', epoch);
    const response = await createTurnEventsResponse(db, await turnRow(db), 0);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    const { frames } = await readFrames(response);
    expect(frames.at(-1)).toEqual({ data: '[DONE]' });
    const ids = frames.flatMap(({ id }) => (id === undefined ? [] : [id]));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    const chunks = chunksOf(frames);
    expect(chunks[0]).toEqual(reply('Hello')[0]);
    expect(chunks.at(-1)).toMatchObject({ type: 'finish' });
    expectWellFormed(chunks);
  });

  it('resumes after a cursor with only the later chunks', async () => {
    const db = await turnFixture();
    const epoch = (await beginTurnExecution(db, TURN))!;
    await appendTurnChunks(db, 'turn', epoch, reply('Hello'));
    await completeTurn(db, 'turn', epoch);
    const all = chunksOf(
      (await readFrames(await createTurnEventsResponse(db, await turnRow(db), 0))).frames,
    );
    const { frames: first } = await readFrames(
      await createTurnEventsResponse(db, await turnRow(db), 0),
      5,
    );
    const cursor = first.at(-1)!.id!;
    const { frames } = await readFrames(
      await createTurnEventsResponse(db, await turnRow(db), cursor),
    );
    expect(frames[0]!.id).toBe(cursor + 1);
    expect([...chunksOf(first), ...chunksOf(frames)]).toEqual(all);
    expect(frames.at(-1)).toEqual({ data: '[DONE]' });
  });
});

describe('turn events endpoint: ends and restarts', () => {
  it('answers 204 for a finished turn with nothing after the cursor', async () => {
    const db = await turnFixture();
    const epoch = (await beginTurnExecution(db, TURN))!;
    await appendTurnChunks(db, 'turn', epoch, reply('Hello'));
    await completeTurn(db, 'turn', epoch);
    const { frames } = await readFrames(await createTurnEventsResponse(db, await turnRow(db), 0));
    const response = await createTurnEventsResponse(db, await turnRow(db), frames.at(-2)!.id!);
    expect(response.status).toBe(204);
  });

  it('sends a restarted execution only to readers holding the discarded one', async () => {
    const db = await turnFixture();
    const first = (await beginTurnExecution(db, TURN))!;
    await appendTurnChunks(db, 'turn', first, reply('Stale'));
    const { frames: stale } = await readFrames(
      await createTurnEventsResponse(db, await turnRow(db), 0),
      3,
    );
    const second = (await beginTurnExecution(db, TURN))!;
    await appendTurnChunks(db, 'turn', second, reply('Fresh'));
    await cancelTurn(db, 'turn', 'owner');

    const behind = await readFrames(
      await createTurnEventsResponse(db, await turnRow(db), stale.at(-1)!.id!),
    );
    expect(chunksOf(behind.frames)).toEqual([
      {
        type: 'data-turn',
        transient: true,
        data: { conversationId: 'conversation', branchId: 'branch', reset: true },
      },
    ]);

    const replay = chunksOf(
      (await readFrames(await createTurnEventsResponse(db, await turnRow(db), 0))).frames,
    );
    expect(replay[0]).toEqual(reply('Fresh')[0]);
    expect(replay).toContainEqual({ type: 'text-delta', id: 't', delta: 'Fresh' });
    expect(replay).not.toContainEqual({ type: 'text-delta', id: 't', delta: 'Stale' });
    expect(replay.at(-1)).toMatchObject({ type: 'finish' });
    expectWellFormed(replay);
  });

  it('keeps a live turn open with keepalive comments', async () => {
    const db = await turnFixture();
    await beginTurnExecution(db, TURN);
    const { frames, comments } = await readFrames(
      await createTurnEventsResponse(db, await turnRow(db), 0),
    );
    expect(frames).toEqual([]);
    expect(comments).toEqual([': keepalive']);
  });
});

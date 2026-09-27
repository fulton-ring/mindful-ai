import type { WaldenUIMessageChunk } from '@walden/contracts';
import { UI_MESSAGE_STREAM_HEADERS } from 'ai';
import { first } from '../../db/client';
import {
  type DurableTurnRow,
  isResetChunk,
  readTurnChunks,
  type StoredChunk,
} from './durable-store';

type Observer = { cursor: number; started: number };
type Output = ReadableStreamDefaultController<Uint8Array>;

const encoder = new TextEncoder();
const RECONNECT_WINDOW_MS = 25_000;
const ENDED: WaldenUIMessageChunk = {
  type: 'error',
  errorText: 'Turn has ended. Reload the conversation.',
};

const frame = (chunk: WaldenUIMessageChunk, seq?: number) =>
  encoder.encode(`${seq === undefined ? '' : `id: ${seq}\n`}data: ${JSON.stringify(chunk)}\n\n`);
const DONE = encoder.encode('data: [DONE]\n\n');

/**
 * Sends stored chunks after the cursor; returns true once the stream is over.
 * A reset marker reaches only a reader that already holds chunks of the
 * discarded attempt, and ends its connection so it replays from seq 0.
 */
function sendChunks(output: Output, rows: StoredChunk[], state: Observer) {
  for (const { seq, chunk } of rows) {
    if (isResetChunk(chunk)) {
      if (state.cursor > 0) {
        output.enqueue(frame(chunk, seq));
        return true;
      }
      state.cursor = seq;
      continue;
    }
    state.cursor = seq;
    output.enqueue(frame(chunk, seq));
    if (chunk.type === 'finish') {
      output.enqueue(DONE);
      return true;
    }
  }
  return false;
}

async function turnStatus(db: D1Database, row: DurableTurnRow) {
  const active = await first<{ status: string }>(
    db.prepare('SELECT status FROM turns WHERE id=? AND owner_id=?').bind(row.id, row.owner_id),
  );
  return active?.status ?? 'deleted';
}

/** One poll: send new chunks, or detect the end, or keep the connection alive. */
async function pollChunks(db: D1Database, row: DurableTurnRow, state: Observer, output: Output) {
  const rows = await readTurnChunks(db, row.id, state.cursor);
  if (rows.length) return sendChunks(output, rows, state);
  if ((await turnStatus(db, row)) !== 'streaming') {
    const tail = await readTurnChunks(db, row.id, state.cursor);
    if (sendChunks(output, tail, state)) return true;
    output.enqueue(frame(ENDED));
    output.enqueue(DONE);
    return true;
  }
  // The client reconnects after this window; it never outlives a request.
  if (Date.now() - state.started > RECONNECT_WINDOW_MS) return true;
  output.enqueue(encoder.encode(': keepalive\n\n'));
  await new Promise((resolve) => setTimeout(resolve, 250));
  return false;
}

/**
 * Serves a turn's UI message stream: `id: <seq>` + `data: <chunk>` frames from
 * after the cursor, ending with `data: [DONE]` once the turn is terminal. A turn
 * that already ended with nothing after the cursor answers 204.
 */
export async function createTurnEventsResponse(
  db: D1Database,
  row: DurableTurnRow,
  after: number,
): Promise<Response> {
  if (row.status !== 'streaming' && !(await readTurnChunks(db, row.id, after, 1)).length)
    return new Response(null, { status: 204 });
  const state: Observer = { cursor: after, started: Date.now() };
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(output) {
      try {
        if (!(await pollChunks(db, row, state, output)) || closed) return;
        closed = true;
        output.close();
      } catch (error) {
        if (closed) return;
        closed = true;
        output.error(error);
      }
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(stream, { headers: UI_MESSAGE_STREAM_HEADERS });
}

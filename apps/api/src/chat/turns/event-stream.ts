import type { ChatEvent } from '@walden/contracts';
import { first } from '../../db/client';
import { encodeSse, sseResponse } from '../sse';
import { type DurableTurnRow, readTurnEvents } from './durable-store';

type Observer = { cursor: number; detached: boolean; started: number };
type EventRow = { seq: number; event: ChatEvent };

function sendEvents(
  output: ReadableStreamDefaultController<Uint8Array>,
  rows: EventRow[],
  state: Observer,
) {
  for (const row of rows) {
    state.cursor = row.seq;
    output.enqueue(encodeSse(row.event, row.seq));
    if (row.event.type === 'done' || row.event.type === 'error') return true;
  }
  return false;
}

async function pollEvents(
  db: D1Database,
  row: DurableTurnRow,
  state: Observer,
  output: ReadableStreamDefaultController<Uint8Array>,
) {
  const events = await readTurnEvents(db, row.id, state.cursor);
  if (events.length) {
    if (sendEvents(output, events, state)) {
      state.detached = true;
      output.close();
    }
    return;
  }
  const active = await first<{ status: string }>(
    db.prepare('SELECT status FROM turns WHERE id=? AND owner_id=?').bind(row.id, row.owner_id),
  );
  if (!active || active.status !== 'streaming') {
    const tail = await readTurnEvents(db, row.id, state.cursor);
    sendEvents(output, tail, state);
    if (!tail.length)
      output.enqueue(
        encodeSse({ type: 'error', message: 'Turn has ended. Reload the conversation.' }),
      );
    state.detached = true;
    output.close();
    return;
  }
  if (Date.now() - state.started > 25_000) {
    state.detached = true;
    output.close();
    return;
  }
  output.enqueue(new TextEncoder().encode(': keepalive\n\n'));
  await new Promise((resolve) => setTimeout(resolve, 250));
}

export function createTurnEventsResponse(db: D1Database, row: DurableTurnRow, after: number) {
  const state: Observer = { cursor: after, detached: false, started: Date.now() };
  const stream = new ReadableStream<Uint8Array>({
    async pull(output) {
      try {
        await pollEvents(db, row, state, output);
      } catch (error) {
        if (state.detached) return;
        state.detached = true;
        output.error(error);
      }
    },
    cancel() {
      state.detached = true;
    },
  });
  return sseResponse(stream);
}

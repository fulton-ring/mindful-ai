import { DurableObject } from 'cloudflare:workers';
import type { WaldenUIMessageChunk } from '@walden/contracts';
import type { Bindings } from '../../types';
import { TurnSession, type TurnState, type TurnStorage } from './turn-session';

function objectStorage(storage: DurableObjectStorage): TurnStorage {
  storage.sql.exec(
    'CREATE TABLE IF NOT EXISTS chunks(seq INTEGER PRIMARY KEY, chunk TEXT NOT NULL)',
  );
  return {
    state: () => storage.get<TurnState>('turn'),
    chunks: () =>
      storage.sql
        .exec<{ chunk: string }>('SELECT chunk FROM chunks ORDER BY seq')
        .toArray()
        .map(({ chunk }) => JSON.parse(chunk) as WaldenUIMessageChunk),
    begin: (turnId) => storage.put<TurnState>('turn', { turnId }),
    append: (seq, chunk) => {
      storage.sql.exec('INSERT INTO chunks(seq,chunk) VALUES(?,?)', seq, JSON.stringify(chunk));
    },
    end: async (endedAt) => {
      const state = await storage.get<TurnState>('turn');
      if (state) await storage.put<TurnState>('turn', { ...state, endedAt });
    },
    setAlarm: (at) => storage.setAlarm(at),
    clear: () => storage.deleteAll(),
  };
}

/** One chat turn: runs it, buffers its chunks, and streams them to every reader. */
export class ChatTurn extends DurableObject<Bindings> {
  private readonly session: TurnSession;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.session = new TurnSession(env, objectStorage(ctx.storage), (task) => {
      void task.catch(() => undefined);
    });
  }

  start(turnId: string) {
    return this.session.start(turnId);
  }

  stream(turnId: string, after: number) {
    return this.session.stream(turnId, after);
  }

  stop(turnId: string) {
    return this.session.stop(turnId);
  }

  override alarm() {
    return this.session.alarm();
  }
}

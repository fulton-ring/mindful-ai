import { DurableObject } from 'cloudflare:workers';
import type { WaldenUIMessageChunk } from '@walden/contracts';
import type { Bindings } from '../../types';
import type { TurnSession, TurnState, TurnStorage } from './turn-session';

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
  private readonly session: Promise<TurnSession>;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    // Importing this class at startup must not initialize the agent runtime.
    this.session = import('./turn-session').then(
      ({ TurnSession }) =>
        new TurnSession(env, objectStorage(ctx.storage), (task) => {
          void task.catch(() => undefined);
        }),
    );
  }

  async start(turnId: string) {
    return (await this.session).start(turnId);
  }

  async stream(turnId: string, after: number) {
    return (await this.session).stream(turnId, after);
  }

  async stop(turnId: string) {
    return (await this.session).stop(turnId);
  }

  override async alarm() {
    return (await this.session).alarm();
  }
}

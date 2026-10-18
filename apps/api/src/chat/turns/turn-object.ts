import { DurableObject } from 'cloudflare:workers';
import { MastraCompositeStore } from '@mastra/core/storage';
import type { WaldenUIMessageChunk } from '@walden/contracts';
import { ensureD1Schema } from '../../db/d1-startup';
import { DoWorkflowsStorage } from '../../execution/do-workflows';
import { DoSqliteCache } from '../../execution/sqlite-cache';
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
    begin: (turnId, execution) =>
      storage.put<TurnState>('turn', { turnId, ...(execution ? { execution } : {}) }),
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
  private session: Promise<TurnSession> | undefined;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
  }

  private getSession(): Promise<TurnSession> {
    this.session ??= this.createSession().catch((error) => {
      this.session = undefined;
      throw error;
    });
    return this.session;
  }

  private async createSession(): Promise<TurnSession> {
    await ensureD1Schema(this.env.DB);
    const { TurnSession } = await import('./turn-session');
    return new TurnSession(
      this.env,
      objectStorage(this.ctx.storage),
      (task) => {
        void task.catch(() => undefined);
      },
      {
        storage: new MastraCompositeStore({
          id: 'walden-turn-execution',
          domains: { workflows: new DoWorkflowsStorage({ storage: this.ctx.storage }) },
        }),
        cache: new DoSqliteCache({ storage: this.ctx.storage, ttlMs: 60 * 60_000 }),
      },
    );
  }

  async start(turnId: string) {
    return (await this.getSession()).start(turnId);
  }

  async stream(turnId: string, after: number) {
    return (await this.getSession()).stream(turnId, after);
  }

  async stop(turnId: string) {
    return (await this.getSession()).stop(turnId);
  }

  async purge(turnId: string) {
    return (await this.getSession()).purge(turnId);
  }

  override async alarm() {
    return (await this.getSession()).alarm();
  }
}

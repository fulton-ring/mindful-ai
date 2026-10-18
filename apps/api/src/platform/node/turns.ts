import { setTimeout as delay } from 'node:timers/promises';
import { UI_MESSAGE_STREAM_HEADERS } from 'ai';
import { TurnSession } from '../../chat/turns/turn-session';
import { loadTurn, recordTurnCancellation, TURN_BUDGET_MS } from '../../chat/turns/turn-store';
import type { AppDatabase } from '../../db/database';
import type { TurnHandle, TurnRouter } from '../../execution/host';
import type { NativeExecutionHost } from '../../execution/native-agent';
import { sweepNativeRuns } from '../../execution/purge';
import type { Bindings } from '../../types';
import { SQLTurnStorage } from './turn-storage';

const encoder = new TextEncoder();
const DONE = encoder.encode('data: [DONE]\n\n');
type Options = { execute: boolean; concurrency?: number; pollMs?: number };
type Reader = ReadableStreamDefaultController<Uint8Array>;

class PersistedTurnStream {
  readonly abort = new AbortController();
  private heartbeat = Date.now();
  constructor(
    private readonly db: AppDatabase,
    private readonly turnId: string,
    private cursor: number,
    private readonly pollMs: number,
  ) {}
  async ended() {
    const state = await this.db
      .prepare('SELECT ended_at FROM turn_execution_state WHERE turn_id=?')
      .bind(this.turnId)
      .first<{ ended_at: number | null }>();
    if (state) return Boolean(state.ended_at);
    return (await loadTurn(this.db, this.turnId))?.status !== 'streaming';
  }
  async sendBatch(reader: Reader) {
    const events = (
      await this.db
        .prepare(
          'SELECT sequence,event_json FROM turn_events WHERE turn_id=? AND sequence>? ORDER BY sequence LIMIT 128',
        )
        .bind(this.turnId, this.cursor)
        .all<{ sequence: number; event_json: string }>()
    ).results;
    if (!events.length || this.abort.signal.aborted) return false;
    for (const event of events) {
      reader.enqueue(encoder.encode(`id: ${event.sequence}\ndata: ${event.event_json}\n\n`));
      this.cursor = Number(event.sequence);
    }
    this.heartbeat = Date.now();
    return true;
  }
  async poll(reader: Reader) {
    try {
      while (!this.abort.signal.aborted) {
        if (await this.sendBatch(reader)) return;
        if (await this.ended()) {
          reader.enqueue(DONE);
          reader.close();
          this.abort.abort();
          return;
        }
        if (Date.now() - this.heartbeat >= 15_000) {
          reader.enqueue(encoder.encode(': keepalive\n\n'));
          this.heartbeat = Date.now();
          return;
        }
        await delay(this.pollMs, undefined, { signal: this.abort.signal });
      }
    } catch (error) {
      if (!this.abort.signal.aborted) reader.error(error);
    }
  }
}

class NodeTurns {
  private readonly sessions = new Map<string, TurnSession>();
  private readonly readers = new Map<PersistedTurnStream, Reader>();
  private readonly polls = new Set<Promise<void>>();
  private lastPrune = 0;
  private pruneTask?: Promise<void>;
  private scanning = false;
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  private scanTask?: Promise<void>;
  readonly router: TurnRouter = {
    get: (_id): TurnHandle => ({
      start: (id) => this.startTurn(id),
      stream: (id, after) => this.stream(id, after),
      stop: (id) => this.stop(id),
      purge: (id) => this.purge(id),
    }),
  };
  constructor(
    private readonly env: Bindings,
    private readonly host: NativeExecutionHost,
    private readonly options: Options,
  ) {}
  private session(id: string) {
    let found = this.sessions.get(id);
    if (!found) {
      found = new TurnSession(
        this.env,
        new SQLTurnStorage(this.env.DB, id),
        (task) => {
          void task.catch((error) =>
            console.warn('Turn background task failed', { error: String(error) }),
          );
        },
        this.host,
      );
      this.sessions.set(id, found);
    }
    return found;
  }
  private async startTurn(id: string) {
    if (this.closed) throw new Error('Turn host is draining');
    if (this.options.execute) await this.session(id).start(id);
    return { queued: true };
  }
  private async stream(id: string, after: number) {
    await this.startTurn(id);
    const stream = new PersistedTurnStream(this.env.DB, id, after, this.options.pollMs ?? 150);
    const available = await this.env.DB.prepare(
      'SELECT 1 FROM turn_events WHERE turn_id=? AND sequence>? LIMIT 1',
    )
      .bind(id, after)
      .first();
    if (!available && (await stream.ended())) return new Response(null, { status: 204 });
    const body = new ReadableStream<Uint8Array>({
      start: (reader) => {
        this.readers.set(stream, reader);
      },
      pull: (reader) => {
        const task = stream.poll(reader);
        this.polls.add(task);
        void task.finally(() => {
          this.polls.delete(task);
          if (stream.abort.signal.aborted) this.readers.delete(stream);
        });
        return task;
      },
      cancel: () => {
        this.readers.delete(stream);
        stream.abort.abort();
      },
    });
    return new Response(body, { headers: UI_MESSAGE_STREAM_HEADERS });
  }
  private async stop(id: string) {
    const row = await loadTurn(this.env.DB, id);
    if (!row || row.status !== 'streaming') return false;
    await recordTurnCancellation(this.env.DB, row);
    const local = this.sessions.get(id);
    if (local?.isRunning) return local.stop(id);
    const owner = await (await this.host.storage.getStore('workflows'))?.getRunOwnership({
      runId: id,
    });
    if (!owner?.live && this.options.execute) return this.session(id).stop(id);
    for (let attempt = 0; attempt < 30; attempt++) {
      const latest = await loadTurn(this.env.DB, id);
      if (!latest || latest.status !== 'streaming') return latest?.status === 'cancelled';
      await delay(100);
    }
    return true;
  }
  private async purge(id: string) {
    const local = this.sessions.get(id);
    if (local) {
      await local.purge(id);
      this.sessions.delete(id);
    } else await this.stop(id);
  }
  async scan() {
    if (this.scanning || this.closed || !this.options.execute) return;
    this.scanning = true;
    try {
      const now = Date.now();
      await this.prune(now);
      await this.alarms(now);
      const rows = (
        await this.env.DB.prepare(
          `SELECT t.id FROM turns t LEFT JOIN turn_execution_state s ON s.turn_id=t.id WHERE t.status='streaming' AND t.input_json IS NOT NULL AND (s.turn_id IS NULL OR s.alarm_at IS NULL OR s.alarm_at<=?) ORDER BY t.created_at LIMIT 100`,
        )
          .bind(now)
          .all<{ id: string }>()
      ).results;
      for (const row of rows) {
        if (
          [...this.sessions.values()].filter((item) => item.isRunning).length >=
          (this.options.concurrency ?? 4)
        )
          break;
        await this.startTurn(row.id);
      }
      const expired = (
        await this.env.DB.prepare(
          "SELECT id FROM turns WHERE status='streaming' AND created_at<=? LIMIT 100",
        )
          .bind(new Date(now - TURN_BUDGET_MS).toISOString())
          .all<{ id: string }>()
      ).results;
      for (const row of expired) await this.startTurn(row.id);
    } finally {
      this.scanning = false;
    }
  }
  private async alarms(now: number) {
    const alarms = (
      await this.env.DB.prepare(
        'SELECT turn_id FROM turn_execution_state WHERE alarm_at<=? ORDER BY alarm_at LIMIT 100',
      )
        .bind(now)
        .all<{ turn_id: string }>()
    ).results;
    for (const alarm of alarms) {
      await this.session(alarm.turn_id).alarm();
      if (
        !(await this.env.DB.prepare('SELECT 1 FROM turn_execution_state WHERE turn_id=?')
          .bind(alarm.turn_id)
          .first())
      )
        this.sessions.delete(alarm.turn_id);
    }
  }
  private prune(now: number) {
    if (!this.pruneTask || now - this.lastPrune >= 60_000) {
      this.lastPrune = now;
      this.pruneTask = this.pruneNative();
    }
    // Retain failures until the next refresh so stale policy never permits recovery in between.
    return this.pruneTask;
  }
  private async pruneNative() {
    await sweepNativeRuns(this.env.DB, this.host, this.env);
    if ('prune' in this.host.cache && typeof this.host.cache.prune === 'function')
      await this.host.cache.prune();
    await this.host.storage.prune({
      maxBatches: 1,
      maxRows: 1000,
      retention: {
        workflows: { workflowSnapshot: { maxAge: '7d' }, runOwnership: { maxAge: '7d' } },
        memory: { runFences: { maxAge: '7d' } },
      },
    });
  }
  async start() {
    if (!this.options.execute || this.timer) return;
    this.scanTask = this.scan();
    await this.scanTask;
    this.timer = setInterval(() => {
      if (this.scanning) return;
      this.scanTask = this.scan();
      void this.scanTask.catch((error) =>
        console.warn('Turn recovery deferred', { error: String(error) }),
      );
    }, 500);
    this.timer.unref();
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const [stream, reader] of this.readers) {
      stream.abort.abort();
      try {
        reader.close();
      } catch {
        /* Reader already detached. */
      }
    }
    this.readers.clear();
    await Promise.allSettled([...this.polls]);
    await this.scanTask?.catch(() => undefined);
    await Promise.allSettled([...this.sessions.values()].map((item) => item.drain()));
    this.sessions.clear();
  }
}
/** Native owners run the shared session; every HTTP process reads the durable UI log. */
export const createNodeTurnRouter = (env: Bindings, host: NativeExecutionHost, options: Options) =>
  new NodeTurns(env, host, options);

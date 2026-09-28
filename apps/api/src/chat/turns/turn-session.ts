import type { WaldenUIMessageChunk } from '@walden/contracts';
import type { Bindings } from '../../types';
import { ChunkLog } from './chunk-log';
import { type Background, runTurn, STOPPED, sealInterruptedTurn } from './turn-runner';
import { loadTurn } from './turn-store';

/** A running turn's object is evicted after about a minute without incoming events. */
export const HEARTBEAT_MS = 30_000;
/** How long a finished turn's chunks stay replayable for readers that were mid-stream. */
export const RETENTION_MS = 60 * 60_000;

export type TurnState = { turnId: string; endedAt?: number };

/** The per-turn storage of the turn's Durable Object. */
export type TurnStorage = {
  state(): Promise<TurnState | undefined>;
  chunks(): WaldenUIMessageChunk[];
  begin(turnId: string): Promise<void>;
  append(seq: number, chunk: WaldenUIMessageChunk): void;
  end(endedAt: number): Promise<void>;
  setAlarm(at: number): Promise<void>;
  clear(): Promise<void>;
};

/**
 * One turn's run and stream, owned by the turn's Durable Object. The run is
 * detached from every request: readers come and go while it streams into the
 * chunk log. A turn stored as running that this instance never ran was lost to
 * a restart or deploy, and is sealed as interrupted with what it had streamed.
 */
export class TurnSession {
  private ready?: Promise<void>;
  private log?: ChunkLog;
  private run?: Promise<string>;
  private controller?: AbortController;
  private sealed?: string;

  constructor(
    private readonly env: Bindings,
    private readonly storage: TurnStorage,
    private readonly background: Background,
  ) {}

  /** Starts the admitted turn, once; later calls find it running or ended. */
  start(turnId: string) {
    return this.open(turnId, true);
  }

  /** The turn's UI message stream after `after`; 204 once it ended with nothing after. */
  async stream(turnId: string, after: number): Promise<Response> {
    await this.start(turnId);
    return this.log?.response(after) ?? new Response(null, { status: 204 });
  }

  /** Stops the turn, keeping what streamed; true when this call ended it. */
  async stop(turnId: string): Promise<boolean> {
    // A turn this instance never started is sealed as cancelled, never started.
    await this.open(turnId, false);
    if (!this.run) return this.sealed === 'cancelled';
    this.controller!.abort(STOPPED);
    return (await this.run) === 'cancelled';
  }

  /** Keeps a running turn's object alive, seals a lost run, and clears an old turn. */
  async alarm() {
    const state = await this.storage.state();
    if (!state) return;
    await this.start(state.turnId);
    if (this.log && !this.log.isEnded) return this.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    const endedAt = (await this.storage.state())?.endedAt ?? 0;
    if (Date.now() < endedAt + RETENTION_MS) return this.storage.setAlarm(endedAt + RETENTION_MS);
    await this.storage.clear();
    this.ready = this.log = this.run = this.controller = this.sealed = undefined;
  }

  private open(turnId: string, run: boolean) {
    this.ready ??= this.load(turnId, run);
    return this.ready;
  }

  private async load(turnId: string, run: boolean) {
    const state = await this.storage.state();
    const persist = (seq: number, chunk: WaldenUIMessageChunk) => this.storage.append(seq, chunk);
    if (state) {
      this.log = new ChunkLog(this.storage.chunks(), state.endedAt !== undefined, persist);
      if (!this.log.isEnded) await this.seal(turnId, !run);
      return;
    }
    const row = await loadTurn(this.env.DB, turnId);
    if (!row || row.status !== 'streaming') return;
    await this.storage.begin(turnId);
    this.log = new ChunkLog([], false, persist);
    if (!run || !row.input_json) return this.seal(turnId, !run);
    this.controller = new AbortController();
    await this.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    this.run = runTurn(this.env, row, this.log, this.controller, this.background).finally(() =>
      this.settle(),
    );
  }

  private async seal(turnId: string, stopped: boolean) {
    const row = await loadTurn(this.env.DB, turnId);
    this.sealed = row
      ? await sealInterruptedTurn(this.env, row, this.log!, this.background, stopped)
      : 'deleted';
    if (!this.log!.isEnded) this.log!.end();
    await this.settle();
  }

  private async settle() {
    const endedAt = Date.now();
    await this.storage.end(endedAt);
    await this.storage.setAlarm(endedAt + RETENTION_MS);
  }
}

/** The Durable Object that owns a turn. */
export const turnObject = (env: Pick<Bindings, 'CHAT_TURN'>, turnId: string) =>
  env.CHAT_TURN.get(env.CHAT_TURN.idFromName(turnId));

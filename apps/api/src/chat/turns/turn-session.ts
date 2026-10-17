import type { WaldenUIMessageChunk } from '@walden/contracts';
import type { TurnHandle, TurnRouter } from '../../execution/host';
import {
  claimNativeFinalization,
  type NativeExecutionContext,
  type NativeExecutionHost,
} from '../../execution/native-agent';
import {
  finishNativeRun,
  purgeNativeReplay,
  purgeNativeRun,
  trackNativeRun,
} from '../../execution/purge';
import { resolveInferenceConfig } from '../../inference/config';
import { modelNameForPersona } from '../../services/agent/agent';
import type { Bindings } from '../../types';
import { ChunkLog } from './chunk-log';
import {
  type Background,
  openingChunks,
  runTurn,
  STOPPED,
  sealInterruptedTurn,
} from './turn-runner';
import {
  claimTurnExecution,
  completionChunks,
  loadTurn,
  recordTurnCancellation,
  TURN_BUDGET_MS,
  type TurnInput,
  type TurnRow,
} from './turn-store';

/** A running turn's object is evicted after about a minute without incoming events. */
export const HEARTBEAT_MS = 30_000;
/** How long a finished turn's chunks stay replayable for readers that were mid-stream. */
export const RETENTION_MS = 60 * 60_000;

export type ExecutionDescriptor = {
  version: 1;
  startedAt: number;
  deadlineAt: number;
  model: string;
  generation: number;
  configRef?: string;
};
export type TurnState = { turnId: string; endedAt?: number; execution?: ExecutionDescriptor };

/** The per-turn storage of the turn's Durable Object. */
export type TurnStorage = {
  state(): Promise<TurnState | undefined>;
  chunks(): WaldenUIMessageChunk[] | Promise<WaldenUIMessageChunk[]>;
  begin(turnId: string, execution?: ExecutionDescriptor): Promise<void>;
  append(seq: number, chunk: WaldenUIMessageChunk): unknown | Promise<unknown>;
  end(endedAt: number): Promise<void>;
  setAlarm(at: number): Promise<void>;
  clear(): Promise<void>;
};

/**
 * One turn's run and stream, owned by the turn's Durable Object. The run is
 * detached from requests. Readers follow a persisted cursor while native Mastra
 * checkpoints recover a lost execution from its reconstructed per-turn runtime.
 */
export class TurnSession {
  private ready?: Promise<void>;
  private log?: ChunkLog;
  private run?: Promise<string>;
  private controller?: AbortController;
  private sealed?: string;
  private nativeExecution?: NativeExecutionContext;

  constructor(
    private readonly env: Bindings,
    private readonly storage: TurnStorage,
    private readonly background: Background,
    private readonly executionHost?: NativeExecutionHost,
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
    // A delivered reply may still be updating memory; it can no longer be stopped.
    if (this.log?.isEnded) return false;
    const row = await loadTurn(this.env.DB, turnId);
    if (row) await recordTurnCancellation(this.env.DB, row);
    this.controller!.abort(STOPPED);
    return (await this.run) === 'cancelled';
  }

  get isRunning() {
    return Boolean(this.run && !this.log?.isEnded);
  }

  /** Checkpoint and release native ownership during a Node process drain. */
  async drain() {
    if (!this.nativeExecution) return;
    this.nativeExecution.draining = true;
    await this.nativeExecution.shutdown?.();
    this.controller?.abort('Turn host is draining');
    await this.run;
  }

  /** Privacy deletion waits for every native/background writer before removing its state. */
  async purge(turnId: string) {
    await this.ready;
    const row = await loadTurn(this.env.DB, turnId);
    if (row) await recordTurnCancellation(this.env.DB, row);
    if (row?.status === 'streaming' && !this.run) await this.open(turnId, false);
    this.controller?.abort(STOPPED);
    await this.run?.catch(() => undefined);
    await this.nativeExecution?.shutdown?.();
    await this.storage.clear();
    this.log?.end();
    this.ready =
      this.log =
      this.run =
      this.controller =
      this.sealed =
      this.nativeExecution =
        undefined;
  }

  /** Keeps a running turn's object alive, seals a lost run, and clears an old turn. */
  async alarm() {
    const state = await this.storage.state();
    if (!state) return;
    await this.start(state.turnId);
    if (this.log && !this.log.isEnded) return this.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    const endedAt = (await this.storage.state())?.endedAt ?? 0;
    if (Date.now() < endedAt + RETENTION_MS) return this.storage.setAlarm(endedAt + RETENTION_MS);
    const row = await loadTurn(this.env.DB, state.turnId);
    if (this.executionHost && row)
      await purgeNativeRun(
        this.executionHost,
        {
          runId: row.id,
          ownerId: row.owner_id,
          conversationId: row.conversation_id,
          branchId: row.branch_id,
        },
        false,
      );
    else if (this.executionHost) await purgeNativeReplay(this.executionHost, state.turnId);
    await this.storage.clear();
    if (row)
      await this.env.DB.prepare('DELETE FROM app_settings WHERE key=?')
        .bind(`native-run:${state.turnId}`)
        .run();
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
      this.log = new ChunkLog(await this.storage.chunks(), state.endedAt !== undefined, persist);
      if (this.log.isEnded) return;
      if (!run || !this.executionHost) return this.seal(turnId, !run);
      return this.drive(turnId, true, state.execution);
    }
    const row = await loadTurn(this.env.DB, turnId);
    if (!row || row.status !== 'streaming') return;
    await this.storage.begin(turnId);
    this.log = new ChunkLog([], false, persist);
    if (!run || !row.input_json) return this.seal(turnId, !run);
    await this.drive(turnId, false);
  }

  private async drive(turnId: string, recover: boolean, saved?: ExecutionDescriptor) {
    const row = await loadTurn(this.env.DB, turnId);
    if (!row || row.status !== 'streaming') return this.seal(turnId, false);
    const input = JSON.parse(row.input_json ?? '{}') as TurnInput;
    const model = saved?.model ?? modelNameForPersona(this.env, input.persona);
    const config = this.executionHost ? resolveInferenceConfig(this.env) : undefined;
    const configRef = config?.configured
      ? JSON.stringify({
          provider: config.provider,
          baseURL: config.baseURL,
          backgroundModel: config.backgroundModel,
        })
      : undefined;
    if ((saved && saved.version !== 1) || (saved?.configRef && saved.configRef !== configRef))
      return this.seal(turnId, false);
    const startedAt = Date.parse(row.created_at);
    // Legacy test fixtures use a non-date; admitted production turns always have ISO dates.
    const deadlineAt =
      saved?.deadlineAt ?? (Number.isFinite(startedAt) ? startedAt : Date.now()) + TURN_BUDGET_MS;
    if (Date.now() >= deadlineAt) return this.seal(turnId, false);
    this.controller = new AbortController();
    const timeout = setTimeout(
      () => this.controller?.abort('Turn execution deadline exceeded'),
      deadlineAt - Date.now(),
    );
    await this.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    const execution: NativeExecutionContext | undefined = this.executionHost
      ? {
          host: this.executionHost,
          runId: turnId,
          recover,
          generation: row.execution_generation ?? 0,
          model,
          onClaim: (failure = false) =>
            this.claimStart(
              row,
              input,
              {
                version: 1,
                startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
                deadlineAt,
                model,
                generation: 0,
                configRef,
              },
              recover,
              execution!,
              failure,
            ),
        }
      : undefined;
    this.nativeExecution = execution;
    this.run = runTurn(this.env, row, this.log!, this.controller, this.background, execution)
      .then(async (status) => {
        await this.settle();
        return status;
      })
      .catch(async (error) => {
        // A live native owner keeps its generation. Retry from the host alarm after its lease.
        this.ready = undefined;
        this.run = undefined;
        await this.storage.setAlarm(Date.now() + HEARTBEAT_MS);
        console.warn('Turn recovery deferred', { turnId, error: String(error) });
        return 'streaming';
      })
      .finally(() => clearTimeout(timeout));
  }

  private async claimStart(
    row: TurnRow,
    input: TurnInput,
    descriptor: ExecutionDescriptor,
    recover: boolean,
    execution: NativeExecutionContext,
    failure = false,
  ) {
    const claimed = await claimTurnExecution(this.env.DB, row.id, { allowCancelled: failure });
    if (!claimed) {
      this.controller!.abort('Turn is no longer active');
      throw new Error('Turn is no longer active');
    }
    Object.assign(row, claimed);
    execution.generation = descriptor.generation = claimed.execution_generation ?? 0;
    await trackNativeRun(this.env.DB, {
      runId: row.id,
      ownerId: row.owner_id,
      conversationId: row.conversation_id,
      branchId: row.branch_id,
      deadlineAt: descriptor.deadlineAt,
    });
    await this.storage.begin(row.id, descriptor);
    this.log!.reload(await this.storage.chunks());
    const opening = openingChunks(row, input, descriptor.model);
    if (recover)
      await this.log!.append(
        {
          type: 'data-turn-replace',
          transient: true,
          data: { turnId: row.id, generation: execution.generation },
        },
        ...opening,
      );
    else await this.log!.append(...opening);
  }

  private async seal(turnId: string, stopped: boolean) {
    const row = await loadTurn(this.env.DB, turnId);
    if (row?.status === 'completed') return this.replayCompleted(row);
    if (row && stopped) await recordTurnCancellation(this.env.DB, row);
    this.sealed = row
      ? await sealInterruptedTurn(this.env, row, this.log!, this.background, stopped)
      : 'deleted';
    if (!this.log!.isEnded) this.log!.end();
    await this.settle();
  }

  /** The reply commit is authoritative even if its final UI events did not reach storage. */
  private async replayCompleted(row: TurnRow) {
    const execution: NativeExecutionContext | undefined = this.executionHost && {
      host: this.executionHost,
      runId: row.id,
      recover: true,
      generation: row.execution_generation ?? 0,
    };
    try {
      if (execution) await claimNativeFinalization(execution);
      this.log!.reload(await this.storage.chunks());
      if (
        !this.log!.chunks.some(
          (chunk) => chunk.type === 'finish' && chunk.messageMetadata?.status === 'complete',
        )
      )
        await this.log!.append(...completionChunks(row));
      this.log!.end();
      await this.settle();
    } catch (error) {
      this.ready = undefined;
      await this.storage.setAlarm(Date.now() + HEARTBEAT_MS);
      throw error;
    } finally {
      await execution?.releaseOwnership?.();
    }
  }

  private async settle() {
    const endedAt = Date.now();
    await this.storage.end(endedAt);
    if (this.executionHost)
      await finishNativeRun(
        this.env.DB,
        (await this.storage.state())!.turnId,
        endedAt + RETENTION_MS,
      );
    await this.storage.setAlarm(endedAt + RETENTION_MS);
  }
}

/** The Durable Object that owns a turn. */
export const turnObject = (
  env: { TURNS?: TurnRouter; CHAT_TURN?: Bindings['CHAT_TURN'] },
  turnId: string,
): TurnHandle => {
  if (env.TURNS) return env.TURNS.get(turnId);
  if (!env.CHAT_TURN) throw new Error('Turn execution is not configured');
  return env.CHAT_TURN.get(env.CHAT_TURN.idFromName(turnId));
};

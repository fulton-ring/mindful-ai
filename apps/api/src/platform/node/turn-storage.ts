import type { WaldenUIMessageChunk } from '@walden/contracts';
import type { ExecutionDescriptor, TurnState, TurnStorage } from '../../chat/turns/turn-session';
import type { AppDatabase } from '../../db/database';

/** Durable application event log; each owner keeps its own claimed generation. */
export class SQLTurnStorage implements TurnStorage {
  private generation?: number;
  private get lockOwner() {
    return this.db.dialect === 'postgres' ? ' FOR UPDATE' : '';
  }
  constructor(
    private readonly db: AppDatabase,
    private readonly turnId: string,
  ) {}

  async state(): Promise<TurnState | undefined> {
    const row = await this.db
      .prepare(`SELECT s.state_json,t.execution_generation FROM turn_execution_state s
      JOIN turns t ON t.id=s.turn_id WHERE s.turn_id=?`)
      .bind(this.turnId)
      .first<{ state_json: string; execution_generation: number }>();
    if (!row) return undefined;
    const state: TurnState = JSON.parse(row.state_json);
    this.generation ??= state.execution?.generation ?? Number(row.execution_generation);
    return state;
  }
  async chunks(): Promise<WaldenUIMessageChunk[]> {
    const rows = await this.db
      .prepare('SELECT event_json FROM turn_events WHERE turn_id=? ORDER BY sequence')
      .bind(this.turnId)
      .all<{ event_json: string }>();
    return rows.results.map((row) => JSON.parse(row.event_json) as WaldenUIMessageChunk);
  }
  private async ownerGeneration(): Promise<number> {
    if (this.generation === undefined) {
      await this.state();
      if (this.generation === undefined) {
        const row = await this.db
          .prepare('SELECT execution_generation FROM turns WHERE id=?')
          .bind(this.turnId)
          .first<{ execution_generation: number }>();
        if (!row) throw new Error('Turn generation is no longer available');
        this.generation = Number(row.execution_generation);
      }
    }
    return this.generation;
  }
  async begin(turnId: string, execution?: ExecutionDescriptor): Promise<void> {
    if (turnId !== this.turnId) throw new Error('Turn storage belongs to a different turn');
    if (!execution) {
      await this.db
        .prepare(`INSERT INTO turn_execution_state(turn_id,state_json)
        SELECT id,?1 FROM turns WHERE id=?2 ON CONFLICT(turn_id) DO NOTHING`)
        .bind(JSON.stringify({ turnId }), turnId)
        .run();
      await this.ownerGeneration();
      return;
    }
    const result = await this.db
      .prepare(`INSERT INTO turn_execution_state(turn_id,state_json,ended_at)
      SELECT id,?1,NULL FROM turns WHERE id=?2 AND execution_generation=?3${this.lockOwner}
      ON CONFLICT(turn_id) DO UPDATE SET state_json=excluded.state_json,ended_at=NULL`)
      .bind(JSON.stringify({ turnId, execution }), turnId, execution.generation)
      .run();
    if (!result.meta.changes) throw new Error('Turn generation changed before execution began');
    this.generation = execution.generation;
  }
  async append(seq: number, chunk: WaldenUIMessageChunk): Promise<void> {
    const generation = await this.ownerGeneration();
    const result = await this.db
      .prepare(`INSERT INTO turn_events(turn_id,generation,sequence,event_json,created_at)
      SELECT id,?1,?2,?3,?4 FROM turns WHERE id=?5 AND execution_generation=?1${this.lockOwner}`)
      .bind(generation, seq, JSON.stringify(chunk), new Date().toISOString(), this.turnId)
      .run();
    if (!result.meta.changes) throw new Error('Turn generation changed before event append');
  }
  async end(endedAt: number): Promise<void> {
    const state = await this.state();
    if (!state) return;
    await this.db
      .prepare(`UPDATE turn_execution_state SET state_json=?1,ended_at=?2
      WHERE turn_id=?3 AND EXISTS(SELECT 1 FROM turns WHERE id=?3 AND execution_generation=?4${this.lockOwner})`)
      .bind(
        JSON.stringify({ ...state, endedAt }),
        endedAt,
        this.turnId,
        await this.ownerGeneration(),
      )
      .run();
  }
  async setAlarm(at: number): Promise<void> {
    await this.db
      .prepare(`UPDATE turn_execution_state SET alarm_at=?1
      WHERE turn_id=?2 AND EXISTS(SELECT 1 FROM turns WHERE id=?2 AND execution_generation=?3${this.lockOwner})`)
      .bind(at, this.turnId, await this.ownerGeneration())
      .run();
  }
  async clear(): Promise<void> {
    const generation = await this.ownerGeneration();
    const guard = `turn_id=?1 AND EXISTS(SELECT 1 FROM turns WHERE id=?1 AND execution_generation=?2${this.lockOwner})`;
    await this.db.batch([
      this.db.prepare(`DELETE FROM turn_events WHERE ${guard}`).bind(this.turnId, generation),
      this.db
        .prepare(`DELETE FROM turn_execution_state WHERE ${guard}`)
        .bind(this.turnId, generation),
    ]);
  }
}

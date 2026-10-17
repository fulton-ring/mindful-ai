import {
  type ClaimRunOwnershipInput,
  type ClaimRunOwnershipResult,
  matchesExpectedWorkflowStatus,
  matchesRunFence,
  mergeWorkflowStepResult,
  type RenewRunOwnershipInput,
  type RenewRunOwnershipResult,
  type RunFence,
  RunFenceConflictError,
  type RunOwnershipRecord,
  resolveRunFence,
  type StorageListWorkflowRunsInput,
  type WorkflowRun,
  type WorkflowRuns,
  WorkflowsStorage,
} from '@mastra/core/storage';
import type { WorkflowRunState } from '@mastra/core/workflows';

/** The synchronous SQLite surface owned by one Durable Object. */
export interface DoSqliteStorage {
  sql: {
    exec(
      query: string,
      ...bindings: (string | number | null | ArrayBuffer)[]
    ): Iterable<Record<string, unknown>>;
  };
  transactionSync<T>(callback: () => T): T;
}
type RunRow = {
  workflow_name: string;
  run_id: string;
  resource_id: string | null;
  snapshot: string;
  created_at: number;
  updated_at: number;
};
type OwnerRow = {
  run_id: string;
  generation: number;
  owner_id: string;
  lease_expires_at: number | null;
};

/** Native DO SQLite workflow domain: every read/modify/write is one synchronous transaction. */
export class DoWorkflowsStorage extends WorkflowsStorage {
  private readonly storage: DoSqliteStorage;
  constructor({ storage }: { storage: DoSqliteStorage }) {
    super();
    this.storage = storage;
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS execution_workflows (
      workflow_name TEXT NOT NULL, run_id TEXT NOT NULL, resource_id TEXT,
      snapshot TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(workflow_name, run_id))`);
    storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS execution_workflows_created ON execution_workflows(created_at)`,
    );
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS execution_run_owners (
      run_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, owner_id TEXT NOT NULL,
      lease_expires_at INTEGER, updated_at INTEGER NOT NULL)`);
  }
  supportsConcurrentUpdates() {
    return true;
  }
  supportsRunFencing() {
    return true;
  }
  private row(workflowName: string, runId: string): RunRow | undefined {
    return [
      ...this.storage.sql.exec(
        'SELECT * FROM execution_workflows WHERE workflow_name = ? AND run_id = ?',
        workflowName,
        runId,
      ),
    ][0] as RunRow | undefined;
  }
  private owner(runId: string): RunOwnershipRecord | null {
    const row = [
      ...this.storage.sql.exec('SELECT * FROM execution_run_owners WHERE run_id = ?', runId),
    ][0] as OwnerRow | undefined;
    return row
      ? {
          runId,
          generation: row.generation,
          ownerId: row.owner_id,
          leaseExpiresAt: row.lease_expires_at === null ? null : new Date(row.lease_expires_at),
          live: row.lease_expires_at !== null && row.lease_expires_at > Date.now(),
        }
      : null;
  }
  private assertFence(fence: RunFence | undefined, operation: string) {
    if (fence && !matchesRunFence(this.owner(fence.runId), fence))
      throw new RunFenceConflictError(fence, operation);
  }
  async claimRunOwnership({
    runId,
    ownerId,
    leaseMs,
    force,
    expectedGeneration,
  }: ClaimRunOwnershipInput): Promise<ClaimRunOwnershipResult> {
    return this.storage.transactionSync(() => {
      const current = this.owner(runId);
      if (
        (expectedGeneration !== undefined && (current?.generation ?? 0) !== expectedGeneration) ||
        (current?.live && !force)
      )
        return { acquired: false, record: current };
      const now = Date.now();
      this.storage.sql.exec(
        `INSERT INTO execution_run_owners VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET generation=excluded.generation, owner_id=excluded.owner_id, lease_expires_at=excluded.lease_expires_at, updated_at=excluded.updated_at`,
        runId,
        current ? current.generation + 1 : Math.max(1, now),
        ownerId,
        now + leaseMs,
        now,
      );
      return { acquired: true, record: this.owner(runId)! };
    });
  }
  async renewRunOwnership({
    leaseMs,
    ...fence
  }: RenewRunOwnershipInput): Promise<RenewRunOwnershipResult> {
    return this.storage.transactionSync(() => {
      const current = this.owner(fence.runId);
      if (!current?.leaseExpiresAt || !matchesRunFence(current, fence))
        return { renewed: false, record: current };
      const now = Date.now();
      this.storage.sql.exec(
        'UPDATE execution_run_owners SET lease_expires_at = ?, updated_at = ? WHERE run_id = ?',
        now + leaseMs,
        now,
        fence.runId,
      );
      return { renewed: true, record: this.owner(fence.runId)! };
    });
  }
  async releaseRunOwnership(fence: RunFence): Promise<boolean> {
    return this.storage.transactionSync(() => {
      if (!matchesRunFence(this.owner(fence.runId), fence)) return false;
      this.storage.sql.exec(
        'UPDATE execution_run_owners SET lease_expires_at = NULL, updated_at = ? WHERE run_id = ?',
        Date.now(),
        fence.runId,
      );
      return true;
    });
  }
  async getRunOwnership({ runId }: { runId: string }) {
    return this.owner(runId);
  }
  async persistWorkflowSnapshot(
    args: Parameters<WorkflowsStorage['persistWorkflowSnapshot']>[0],
  ): Promise<void> {
    const { workflowName, runId, resourceId, snapshot, createdAt, updatedAt } = args;
    const fence = resolveRunFence(this, args.fence, runId);
    this.storage.transactionSync(() => {
      this.assertFence(fence, 'persistWorkflowSnapshot');
      const existing = this.row(workflowName, runId);
      const now = Date.now();
      this.storage.sql.exec(
        `INSERT INTO execution_workflows VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(workflow_name, run_id) DO UPDATE SET resource_id=excluded.resource_id, snapshot=excluded.snapshot, created_at=excluded.created_at, updated_at=excluded.updated_at`,
        workflowName,
        runId,
        resourceId ?? existing?.resource_id ?? null,
        JSON.stringify(snapshot),
        createdAt?.getTime() ?? existing?.created_at ?? now,
        updatedAt?.getTime() ?? now,
      );
    });
  }
  async loadWorkflowSnapshot({
    workflowName,
    runId,
  }: {
    workflowName: string;
    runId: string;
  }): Promise<WorkflowRunState | null> {
    const row = this.row(workflowName, runId);
    return row ? JSON.parse(row.snapshot) : null;
  }
  async updateWorkflowResults(args: Parameters<WorkflowsStorage['updateWorkflowResults']>[0]) {
    const { workflowName, runId, stepId, result, requestContext, state } = args;
    const fence = resolveRunFence(this, args.fence, runId);
    return this.storage.transactionSync(() => {
      this.assertFence(fence, 'updateWorkflowResults');
      const row = this.row(workflowName, runId);
      if (!row) return {};
      const snapshot: WorkflowRunState = JSON.parse(row.snapshot);
      const context = mergeWorkflowStepResult({ snapshot, stepId, result, requestContext, state });
      this.writeSnapshot(workflowName, runId, snapshot);
      return context;
    });
  }
  async updateWorkflowState(
    args: Parameters<WorkflowsStorage['updateWorkflowState']>[0],
  ): Promise<WorkflowRunState | undefined> {
    const { workflowName, runId, opts } = args;
    const fence = resolveRunFence(this, args.fence, runId);
    return this.storage.transactionSync(() => {
      this.assertFence(fence, 'updateWorkflowState');
      const row = this.row(workflowName, runId);
      if (!row) return undefined;
      const snapshot: WorkflowRunState = JSON.parse(row.snapshot);
      const { expectedStatus, ...state } = opts;
      if (!matchesExpectedWorkflowStatus(snapshot.status, expectedStatus)) return undefined;
      const next = { ...snapshot, ...state };
      this.writeSnapshot(workflowName, runId, next);
      return next;
    });
  }
  private writeSnapshot(workflowName: string, runId: string, snapshot: WorkflowRunState) {
    this.storage.sql.exec(
      'UPDATE execution_workflows SET snapshot = ?, updated_at = ? WHERE workflow_name = ? AND run_id = ?',
      JSON.stringify(snapshot),
      Date.now(),
      workflowName,
      runId,
    );
  }
  private run(row: RunRow): WorkflowRun {
    return {
      workflowName: row.workflow_name,
      runId: row.run_id,
      snapshot: JSON.parse(row.snapshot),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      ...(row.resource_id !== null ? { resourceId: row.resource_id } : {}),
    };
  }
  async listWorkflowRuns(args: StorageListWorkflowRunsInput = {}): Promise<WorkflowRuns> {
    if (args.page !== undefined && args.page < 0) throw new Error('page must be >= 0');
    const filters: string[] = [];
    const values: (string | number)[] = [];
    for (const [column, value] of [
      ['workflow_name', args.workflowName],
      ['resource_id', args.resourceId],
      ["json_extract(snapshot, '$.status')", args.status],
    ] as const) {
      if (value !== undefined) {
        filters.push(`${column} = ?`);
        values.push(value);
      }
    }
    if (args.fromDate) {
      filters.push('created_at >= ?');
      values.push(args.fromDate.getTime());
    }
    if (args.toDate) {
      filters.push('created_at <= ?');
      values.push(args.toDate.getTime());
    }
    const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
    return this.storage.transactionSync(() => {
      const total = [
        ...this.storage.sql.exec(
          `SELECT count(*) AS count FROM execution_workflows${where}`,
          ...values,
        ),
      ][0]!.count as number;
      let limit = '';
      const pagedValues = [...values];
      if (args.perPage !== undefined && args.perPage !== false && args.page !== undefined) {
        if (args.perPage <= 0) throw new Error('perPage must be positive');
        limit = ' LIMIT ? OFFSET ?';
        pagedValues.push(args.perPage, args.page * args.perPage);
      }
      const rows = [
        ...this.storage.sql.exec(
          `SELECT * FROM execution_workflows${where} ORDER BY created_at DESC, run_id ASC${limit}`,
          ...pagedValues,
        ),
      ] as RunRow[];
      // threadId is a documented best-effort filter; returning a superset is allowed.
      return { runs: rows.map((row) => this.run(row)), total };
    });
  }
  async getWorkflowRunById({
    runId,
    workflowName,
  }: {
    runId: string;
    workflowName?: string;
  }): Promise<WorkflowRun | null> {
    const row =
      workflowName === undefined
        ? ([
            ...this.storage.sql.exec(
              'SELECT * FROM execution_workflows WHERE run_id = ? ORDER BY created_at DESC LIMIT 1',
              runId,
            ),
          ][0] as RunRow | undefined)
        : this.row(workflowName, runId);
    return row ? this.run(row) : null;
  }
  async deleteWorkflowRunById(
    args: Parameters<WorkflowsStorage['deleteWorkflowRunById']>[0],
  ): Promise<void> {
    const fence = resolveRunFence(this, args.fence, args.runId);
    this.storage.transactionSync(() => {
      this.assertFence(fence, 'deleteWorkflowRunById');
      this.storage.sql.exec(
        'DELETE FROM execution_workflows WHERE workflow_name = ? AND run_id = ?',
        args.workflowName,
        args.runId,
      );
    });
  }
  async dangerouslyClearAll(): Promise<void> {
    this.storage.transactionSync(() => {
      this.storage.sql.exec('DELETE FROM execution_workflows');
      this.storage.sql.exec('DELETE FROM execution_run_owners');
    });
  }
}

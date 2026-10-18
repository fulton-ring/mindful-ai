import { type D1DomainConfig, MemoryStorageD1 } from '@mastra/cloudflare-d1';
import type {
  BufferedObservationChunk,
  CreateObservationalMemoryInput,
  CreateReflectionGenerationInput,
  ObservationalMemoryHistoryOptions,
  ObservationalMemoryRecord,
  SwapBufferedReflectionToActiveInput,
  SwapBufferedToActiveInput,
  SwapBufferedToActiveResult,
  UpdateActiveObservationsInput,
  UpdateBufferedObservationsInput,
  UpdateBufferedReflectionInput,
  UpdateObservationalMemoryConfigInput,
} from '@mastra/core/storage';
import { applicationMemoryWriteGuard } from '../../execution/write-guard';

type BindingConfig = Extract<D1DomainConfig, { binding: D1Database }>;
type Row = Record<string, unknown>;

const MAX_CAS_ATTEMPTS = 8;

/**
 * D1's Mastra memory adapter does not yet implement the optional observational
 * memory contract. This subclass stores the native Mastra OM record shape and
 * uses a database revision for cross-isolate read/modify/write operations.
 */
export class D1ObservationalMemory extends MemoryStorageD1 {
  readonly supportsObservationalMemory = true;

  readonly #binding: D1Database;
  readonly #table: string;
  readonly #threadsTable: string;

  constructor(config: BindingConfig) {
    super(config);
    if (!/^[A-Za-z0-9_]*$/.test(config.tablePrefix ?? '')) {
      throw new Error('D1 tablePrefix may contain only letters, numbers, and underscores');
    }
    this.#binding = config.binding;
    this.#table = `${config.tablePrefix ?? ''}mastra_observational_memory`;
    this.#threadsTable = `${config.tablePrefix ?? ''}mastra_threads`;
  }

  override async init(): Promise<void> {
    await super.init();
    await this.#binding
      .prepare(
        `CREATE TABLE IF NOT EXISTS "${this.#table}" (
          id TEXT PRIMARY KEY NOT NULL,
          lookupKey TEXT NOT NULL,
          scope TEXT NOT NULL,
          resourceId TEXT,
          threadId TEXT,
          activeObservations TEXT NOT NULL DEFAULT '',
          activeObservationsPendingUpdate TEXT,
          originType TEXT NOT NULL,
          config TEXT NOT NULL DEFAULT '{}',
          generationCount INTEGER NOT NULL DEFAULT 0,
          lastObservedAt TEXT,
          lastReflectionAt TEXT,
          pendingMessageTokens INTEGER NOT NULL DEFAULT 0,
          totalTokensObserved INTEGER NOT NULL DEFAULT 0,
          observationTokenCount INTEGER NOT NULL DEFAULT 0,
          isObserving INTEGER NOT NULL DEFAULT 0,
          isReflecting INTEGER NOT NULL DEFAULT 0,
          observedMessageIds TEXT,
          observedTimezone TEXT,
          bufferedObservations TEXT,
          bufferedObservationTokens INTEGER,
          bufferedMessageIds TEXT,
          bufferedReflection TEXT,
          bufferedReflectionTokens INTEGER,
          bufferedReflectionInputTokens INTEGER,
          reflectedObservationLineCount INTEGER,
          bufferedObservationChunks TEXT,
          isBufferingObservation INTEGER NOT NULL DEFAULT 0,
          isBufferingReflection INTEGER NOT NULL DEFAULT 0,
          lastBufferedAtTokens INTEGER NOT NULL DEFAULT 0,
          lastBufferedAtTime TEXT,
          metadata TEXT,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0
        )`,
      )
      .run();
    await this.#binding
      .prepare(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${this.#table}_lookup_generation"
         ON "${this.#table}" (lookupKey, generationCount)`,
      )
      .run();
  }

  override async deleteThread({ threadId }: { threadId: string }): Promise<void> {
    const thread = await this.getThreadById({ threadId });
    await super.deleteThread({ threadId });
    // Delete by threadId as well as lookupKey so all generations are removed,
    // including rows written by older adapters with a malformed lookup key.
    await this.#binding
      .prepare(`DELETE FROM "${this.#table}" WHERE threadId = ? OR lookupKey = ?`)
      .bind(threadId, this.#key(threadId, thread?.resourceId ?? ''))
      .run();
  }

  async getObservationalMemory(
    threadId: string | null,
    resourceId: string,
  ): Promise<ObservationalMemoryRecord | null> {
    const row = await this.#binding
      .prepare(
        `SELECT * FROM "${this.#table}" WHERE lookupKey = ? ORDER BY generationCount DESC LIMIT 1`,
      )
      .bind(this.#key(threadId, resourceId))
      .first<Row>();
    return row ? this.#parse(row) : null;
  }

  async getObservationalMemoryHistory(
    threadId: string | null,
    resourceId: string,
    limit = 10,
    options?: ObservationalMemoryHistoryOptions,
  ): Promise<ObservationalMemoryRecord[]> {
    const conditions = ['lookupKey = ?'];
    const values: unknown[] = [this.#key(threadId, resourceId)];
    if (options?.from) {
      conditions.push('createdAt >= ?');
      values.push(options.from.toISOString());
    }
    if (options?.to) {
      conditions.push('createdAt <= ?');
      values.push(options.to.toISOString());
    }
    values.push(limit);
    let sql = `SELECT * FROM "${this.#table}" WHERE ${conditions.join(' AND ')} ORDER BY generationCount DESC LIMIT ?`;
    if (options?.offset !== undefined) {
      sql += ' OFFSET ?';
      values.push(options.offset);
    }
    const result = await this.#binding
      .prepare(sql)
      .bind(...values)
      .all<Row>();
    return result.results.map((row) => this.#parse(row));
  }

  async initializeObservationalMemory(
    input: CreateObservationalMemoryInput,
  ): Promise<ObservationalMemoryRecord> {
    if (input.threadId) {
      const parent = await this.#binding
        .prepare(`SELECT 1 AS present FROM "${this.#threadsTable}" WHERE id = ? AND resourceId = ?`)
        .bind(input.threadId, input.resourceId)
        .first();
      if (!parent)
        throw new Error(
          `Cannot initialize observational memory for missing thread: ${input.threadId}`,
        );
    }
    const now = new Date();
    const record: ObservationalMemoryRecord = {
      id: crypto.randomUUID(),
      scope: input.scope,
      threadId: input.threadId,
      resourceId: input.resourceId,
      createdAt: now,
      updatedAt: now,
      originType: 'initial',
      generationCount: 0,
      activeObservations: '',
      totalTokensObserved: 0,
      observationTokenCount: 0,
      pendingMessageTokens: 0,
      isReflecting: false,
      isObserving: false,
      isBufferingObservation: false,
      isBufferingReflection: false,
      lastBufferedAtTokens: 0,
      lastBufferedAtTime: null,
      config: input.config,
      observedTimezone: input.observedTimezone,
    };
    await this.#insert(record, true);
    const stored = await this.getObservationalMemory(input.threadId, input.resourceId);
    if (!stored)
      throw new Error(
        `Cannot initialize observational memory for missing thread: ${input.threadId}`,
      );
    return stored;
  }

  async insertObservationalMemoryRecord(record: ObservationalMemoryRecord): Promise<void> {
    const inserted = await this.#insert(record, false);
    if (!inserted)
      throw new Error(`Cannot insert observational memory for missing thread: ${record.threadId}`);
  }

  async updateActiveObservations(input: UpdateActiveObservationsInput): Promise<void> {
    await this.#change(
      `UPDATE "${this.#table}" SET activeObservations = ?, lastObservedAt = ?, pendingMessageTokens = 0,
       observationTokenCount = ?, totalTokensObserved = totalTokensObserved + ?, observedMessageIds = ?,
       observedTimezone = COALESCE(?, observedTimezone), updatedAt = ?, revision = revision + 1 WHERE id = ?`,
      input.observations,
      input.lastObservedAt.toISOString(),
      input.tokenCount,
      input.tokenCount,
      input.observedMessageIds ? JSON.stringify(input.observedMessageIds) : null,
      input.observedTimezone ?? null,
      new Date().toISOString(),
      input.id,
    );
  }

  async updateBufferedObservations(input: UpdateBufferedObservationsInput): Promise<void> {
    await this.#cas(input.id, (row) => {
      const chunks = this.#chunks(row.bufferedObservationChunks);
      if (chunks.some((chunk) => chunk.cycleId === input.chunk.cycleId)) return null;
      const chunk: BufferedObservationChunk = {
        ...input.chunk,
        id: `ombuf-${crypto.randomUUID()}`,
        createdAt: new Date(),
      };
      return {
        sql: `UPDATE "${this.#table}" SET bufferedObservationChunks = ?,
              lastBufferedAtTime = COALESCE(?, lastBufferedAtTime), updatedAt = ?, revision = revision + 1
              WHERE id = ? AND revision = ?`,
        values: [
          JSON.stringify([...chunks, chunk]),
          input.lastBufferedAtTime?.toISOString() ?? null,
          new Date().toISOString(),
        ],
      };
    });
  }

  async swapBufferedToActive(
    input: SwapBufferedToActiveInput,
  ): Promise<SwapBufferedToActiveResult> {
    let answer: SwapBufferedToActiveResult = this.#emptySwap();
    await this.#cas(input.id, (row) => {
      const persisted = this.#chunks(row.bufferedObservationChunks);
      const persistedIds = new Set(persisted.map((chunk) => chunk.id));
      // Refreshed chunks contain newer token weights, but may have been captured
      // before another isolate activated some of them. Only current persisted IDs
      // remain eligible on every CAS retry.
      const refreshed = input.bufferedChunks?.filter((chunk) => persistedIds.has(chunk.id));
      const chunks = refreshed?.length ? refreshed : persisted;
      if (!chunks.length) return null;
      const count = this.#activationBoundary(chunks, input);
      const activated = chunks.slice(0, count);
      const activatedIds = new Set(activated.map((chunk) => chunk.id));
      const remaining = persisted.filter((chunk) => !activatedIds.has(chunk.id));
      const content = activated.map((chunk) => chunk.observations).join('\n\n');
      const observationTokens = activated.reduce((sum, chunk) => sum + chunk.tokenCount, 0);
      const messageTokens = activated.reduce((sum, chunk) => sum + (chunk.messageTokens ?? 0), 0);
      const lastChunk = activated.at(-1);
      const observedAt =
        input.lastObservedAt ??
        (lastChunk?.lastObservedAt ? new Date(lastChunk.lastObservedAt) : new Date());
      const existing = String(row.activeObservations ?? '');
      const boundary = `\n\n--- message boundary (${observedAt.toISOString()}) ---\n\n`;
      answer = {
        chunksActivated: activated.length,
        messageTokensActivated: messageTokens,
        observationTokensActivated: observationTokens,
        messagesActivated: activated.reduce((sum, chunk) => sum + chunk.messageIds.length, 0),
        activatedCycleIds: activated.map((chunk) => chunk.cycleId).filter(Boolean),
        activatedMessageIds: activated.flatMap((chunk) => chunk.messageIds),
        observations: content,
        perChunk: activated.map((chunk) => ({
          cycleId: chunk.cycleId,
          messageTokens: chunk.messageTokens ?? 0,
          observationTokens: chunk.tokenCount,
          messageCount: chunk.messageIds.length,
          observations: chunk.observations,
        })),
        suggestedContinuation: lastChunk?.suggestedContinuation,
        currentTask: lastChunk?.currentTask,
      };
      return {
        sql: `UPDATE "${this.#table}" SET activeObservations = ?, observationTokenCount = ?,
              pendingMessageTokens = ?, bufferedObservationChunks = ?, lastObservedAt = ?,
              lastBufferedAtTime = CASE WHEN ? IS NULL THEN NULL ELSE lastBufferedAtTime END,
              updatedAt = ?, revision = revision + 1 WHERE id = ? AND revision = ?`,
        values: [
          existing ? `${existing}${boundary}${content}` : content,
          Number(row.observationTokenCount ?? 0) + observationTokens,
          Math.max(0, Number(row.pendingMessageTokens ?? 0) - messageTokens),
          remaining.length ? JSON.stringify(remaining) : null,
          observedAt.toISOString(),
          remaining.length ? 1 : null,
          new Date().toISOString(),
        ],
      };
    });
    return answer;
  }

  async createReflectionGeneration(
    input: CreateReflectionGenerationInput,
  ): Promise<ObservationalMemoryRecord> {
    return this.#createGeneration(input.currentRecord, input.reflection, input.tokenCount);
  }

  async updateBufferedReflection(input: UpdateBufferedReflectionInput): Promise<void> {
    await this.#change(
      `UPDATE "${this.#table}" SET bufferedReflection = CASE WHEN bufferedReflection IS NOT NULL
       AND bufferedReflection != '' THEN bufferedReflection || char(10) || char(10) || ? ELSE ? END,
       bufferedReflectionTokens = COALESCE(bufferedReflectionTokens, 0) + ?,
       bufferedReflectionInputTokens = COALESCE(bufferedReflectionInputTokens, 0) + ?,
       reflectedObservationLineCount = ?, updatedAt = ?, revision = revision + 1 WHERE id = ?`,
      input.reflection,
      input.reflection,
      input.tokenCount,
      input.inputTokenCount,
      input.reflectedObservationLineCount,
      new Date().toISOString(),
      input.id,
    );
  }

  async swapBufferedReflectionToActive(
    input: SwapBufferedReflectionToActiveInput,
  ): Promise<ObservationalMemoryRecord> {
    const row = await this.#row(input.currentRecord.id);
    const reflection = String(row.bufferedReflection ?? '');
    if (!reflection) throw new Error('No buffered reflection to swap');
    const lines = String(row.activeObservations ?? '').split('\n');
    const unreflected = lines
      .slice(Number(row.reflectedObservationLineCount ?? 0))
      .join('\n')
      .trim();
    const combined = unreflected ? `${reflection}\n\n${unreflected}` : reflection;
    const result = await this.#createGeneration(this.#parse(row), combined, input.tokenCount, {
      oldRevision: Number(row.revision),
      clearBuffered: true,
    });
    return result;
  }

  async setReflectingFlag(id: string, isReflecting: boolean): Promise<void> {
    await this.#flag(id, 'isReflecting', isReflecting);
  }

  async setObservingFlag(id: string, isObserving: boolean): Promise<void> {
    await this.#flag(id, 'isObserving', isObserving);
  }

  async setBufferingObservationFlag(
    id: string,
    isBuffering: boolean,
    lastBufferedAtTokens?: number,
  ): Promise<void> {
    if (lastBufferedAtTokens === undefined) {
      await this.#flag(id, 'isBufferingObservation', isBuffering);
      return;
    }
    await this.#change(
      `UPDATE "${this.#table}" SET isBufferingObservation = ?, lastBufferedAtTokens = ?,
       updatedAt = ?, revision = revision + 1 WHERE id = ?`,
      Number(isBuffering),
      lastBufferedAtTokens,
      new Date().toISOString(),
      id,
    );
  }

  async setBufferingReflectionFlag(id: string, isBuffering: boolean): Promise<void> {
    await this.#flag(id, 'isBufferingReflection', isBuffering);
  }

  async clearObservationalMemory(threadId: string | null, resourceId: string): Promise<void> {
    const guard = applicationMemoryWriteGuard();
    await this.#binding
      .prepare(`DELETE FROM "${this.#table}" WHERE lookupKey = ?${guard.sql}`)
      .bind(this.#key(threadId, resourceId), ...guard.values)
      .run();
  }

  async setPendingMessageTokens(id: string, tokenCount: number): Promise<void> {
    await this.#change(
      `UPDATE "${this.#table}" SET pendingMessageTokens = ?, updatedAt = ?, revision = revision + 1 WHERE id = ?`,
      tokenCount,
      new Date().toISOString(),
      id,
    );
  }

  async updateObservationalMemoryConfig(
    input: UpdateObservationalMemoryConfigInput,
  ): Promise<void> {
    await this.#cas(input.id, (row) => ({
      sql: `UPDATE "${this.#table}" SET config = ?, updatedAt = ?, revision = revision + 1
            WHERE id = ? AND revision = ?`,
      values: [
        JSON.stringify(this.deepMergeConfig(this.#json(row.config, {}), input.config)),
        new Date().toISOString(),
      ],
    }));
  }

  async #insert(record: ObservationalMemoryRecord, ignoreConflict: boolean): Promise<boolean> {
    const columns = [
      'id',
      'lookupKey',
      'scope',
      'resourceId',
      'threadId',
      'activeObservations',
      'originType',
      'config',
      'generationCount',
      'lastObservedAt',
      'pendingMessageTokens',
      'totalTokensObserved',
      'observationTokenCount',
      'isObserving',
      'isReflecting',
      'observedMessageIds',
      'observedTimezone',
      'bufferedReflection',
      'bufferedReflectionTokens',
      'bufferedReflectionInputTokens',
      'reflectedObservationLineCount',
      'bufferedObservationChunks',
      'isBufferingObservation',
      'isBufferingReflection',
      'lastBufferedAtTokens',
      'lastBufferedAtTime',
      'metadata',
      'createdAt',
      'updatedAt',
    ];
    const verb = ignoreConflict ? 'INSERT OR IGNORE' : 'INSERT';
    const guard = applicationMemoryWriteGuard();
    const result = await this.#binding
      .prepare(
        `${verb} INTO "${this.#table}" (${columns.join(',')})
         SELECT ${columns.map(() => '?').join(',')}
         WHERE (? IS NULL OR EXISTS (
           SELECT 1 FROM "${this.#threadsTable}" WHERE id = ? AND resourceId = ?
         ))${guard.sql}`,
      )
      .bind(
        ...this.#insertValues(record),
        record.threadId,
        record.threadId,
        record.resourceId,
        ...guard.values,
      )
      .run();
    return Boolean(result.meta.changes);
  }

  #insertValues(record: ObservationalMemoryRecord): unknown[] {
    return [
      record.id,
      this.#key(record.threadId, record.resourceId),
      record.scope,
      record.resourceId,
      record.threadId,
      record.activeObservations,
      record.originType,
      JSON.stringify(record.config),
      record.generationCount,
      record.lastObservedAt?.toISOString() ?? null,
      record.pendingMessageTokens,
      record.totalTokensObserved,
      record.observationTokenCount,
      Number(record.isObserving),
      Number(record.isReflecting),
      record.observedMessageIds ? JSON.stringify(record.observedMessageIds) : null,
      record.observedTimezone ?? null,
      record.bufferedReflection ?? null,
      record.bufferedReflectionTokens ?? null,
      record.bufferedReflectionInputTokens ?? null,
      record.reflectedObservationLineCount ?? null,
      record.bufferedObservationChunks ? JSON.stringify(record.bufferedObservationChunks) : null,
      Number(record.isBufferingObservation),
      Number(record.isBufferingReflection),
      record.lastBufferedAtTokens,
      record.lastBufferedAtTime?.toISOString() ?? null,
      record.metadata ? JSON.stringify(record.metadata) : null,
      record.createdAt.toISOString(),
      record.updatedAt.toISOString(),
    ];
  }

  async #createGeneration(
    current: ObservationalMemoryRecord,
    observations: string,
    tokenCount: number,
    options?: { oldRevision: number; clearBuffered: boolean },
  ): Promise<ObservationalMemoryRecord> {
    const source = await this.#row(current.id);
    const revision = options?.oldRevision ?? Number(source.revision);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const generation = Number(source.generationCount) + 1;
    const guard = applicationMemoryWriteGuard();
    const insert = this.#binding
      .prepare(
        `INSERT OR IGNORE INTO "${this.#table}" (
          id,lookupKey,scope,resourceId,threadId,activeObservations,originType,config,generationCount,
          lastObservedAt,lastReflectionAt,pendingMessageTokens,totalTokensObserved,observationTokenCount,
          isObserving,isReflecting,isBufferingObservation,isBufferingReflection,lastBufferedAtTokens,
          lastBufferedAtTime,observedTimezone,metadata,createdAt,updatedAt
        ) SELECT ?,lookupKey,scope,resourceId,threadId,?,'reflection',config,?,lastObservedAt,?,0,
          totalTokensObserved,?,0,0,0,0,0,NULL,observedTimezone,metadata,?,?
          FROM "${this.#table}" source WHERE source.id = ? AND source.revision = ?
          AND NOT EXISTS (SELECT 1 FROM "${this.#table}" newer WHERE newer.lookupKey = source.lookupKey AND newer.generationCount >= ?)${guard.sql}`,
      )
      .bind(
        id,
        observations,
        generation,
        now,
        tokenCount,
        now,
        now,
        current.id,
        revision,
        generation,
        ...guard.values,
      );
    if (options?.clearBuffered) {
      const clear = this.#binding
        .prepare(
          `UPDATE "${this.#table}" SET bufferedReflection = NULL, bufferedReflectionTokens = NULL,
           bufferedReflectionInputTokens = NULL, reflectedObservationLineCount = NULL,
           updatedAt = ?, revision = revision + 1 WHERE id = ? AND revision = ?
           AND EXISTS (SELECT 1 FROM "${this.#table}" created WHERE created.id = ?)${guard.sql}`,
        )
        .bind(now, current.id, revision, id, ...guard.values);
      const [inserted, cleared] = await this.#binding.batch([insert, clear]);
      if (!inserted.meta.changes || !cleared.meta.changes)
        throw new Error('Observational memory changed concurrently');
    } else {
      const inserted = await insert.run();
      if (!inserted.meta.changes) throw new Error('Observational memory changed concurrently');
    }
    return this.#parse(await this.#row(id));
  }

  async #flag(id: string, column: string, value: boolean): Promise<void> {
    await this.#change(
      `UPDATE "${this.#table}" SET ${column} = ?, updatedAt = ?, revision = revision + 1 WHERE id = ?`,
      Number(value),
      new Date().toISOString(),
      id,
    );
  }

  async #change(sql: string, ...values: unknown[]): Promise<void> {
    const guard = applicationMemoryWriteGuard();
    const result = await this.#binding
      .prepare(sql + guard.sql)
      .bind(...values, ...guard.values)
      .run();
    if (!result.meta.changes)
      throw new Error(`Observational memory record not found: ${String(values.at(-1))}`);
  }

  async #cas(
    id: string,
    update: (row: Row) => { sql: string; values: unknown[] } | null,
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const row = await this.#row(id);
      const change = update(row);
      if (!change) return;
      const guard = applicationMemoryWriteGuard();
      const result = await this.#binding
        .prepare(change.sql + guard.sql)
        .bind(...change.values, id, Number(row.revision), ...guard.values)
        .run();
      if (result.meta.changes) return;
    }
    throw new Error(
      `Observational memory update contention exceeded ${MAX_CAS_ATTEMPTS} attempts: ${id}`,
    );
  }

  async #row(id: string): Promise<Row> {
    const row = await this.#binding
      .prepare(`SELECT * FROM "${this.#table}" WHERE id = ?`)
      .bind(id)
      .first<Row>();
    if (!row) throw new Error(`Observational memory record not found: ${id}`);
    return row;
  }

  #key(threadId: string | null, resourceId: string): string {
    return threadId ? `thread:${threadId}` : `resource:${resourceId}`;
  }

  #json<T>(value: unknown, fallback: T): T {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value !== 'string') return value as T;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  #chunks(value: unknown): BufferedObservationChunk[] {
    const chunks = this.#json<unknown[]>(value, []);
    return Array.isArray(chunks)
      ? chunks.map((chunk) => {
          const value = chunk as BufferedObservationChunk;
          return {
            ...value,
            createdAt: new Date(value.createdAt),
            lastObservedAt: new Date(value.lastObservedAt),
          };
        })
      : [];
  }

  #parse(row: Row): ObservationalMemoryRecord {
    return {
      id: String(row.id),
      scope: row.scope as ObservationalMemoryRecord['scope'],
      threadId: row.threadId ? String(row.threadId) : null,
      resourceId: String(row.resourceId),
      createdAt: new Date(String(row.createdAt)),
      updatedAt: new Date(String(row.updatedAt)),
      lastObservedAt: row.lastObservedAt ? new Date(String(row.lastObservedAt)) : undefined,
      originType: (row.originType ?? 'initial') as ObservationalMemoryRecord['originType'],
      generationCount: Number(row.generationCount ?? 0),
      activeObservations: String(row.activeObservations ?? ''),
      bufferedObservationChunks: row.bufferedObservationChunks
        ? this.#chunks(row.bufferedObservationChunks)
        : undefined,
      bufferedObservations: row.activeObservationsPendingUpdate
        ? String(row.activeObservationsPendingUpdate)
        : undefined,
      bufferedObservationTokens:
        row.bufferedObservationTokens == null ? undefined : Number(row.bufferedObservationTokens),
      bufferedReflection: row.bufferedReflection ? String(row.bufferedReflection) : undefined,
      bufferedReflectionTokens:
        row.bufferedReflectionTokens == null ? undefined : Number(row.bufferedReflectionTokens),
      bufferedReflectionInputTokens:
        row.bufferedReflectionInputTokens == null
          ? undefined
          : Number(row.bufferedReflectionInputTokens),
      reflectedObservationLineCount:
        row.reflectedObservationLineCount == null
          ? undefined
          : Number(row.reflectedObservationLineCount),
      observedMessageIds: row.observedMessageIds
        ? this.#json<string[]>(row.observedMessageIds, [])
        : undefined,
      observedTimezone: row.observedTimezone ? String(row.observedTimezone) : undefined,
      totalTokensObserved: Number(row.totalTokensObserved ?? 0),
      observationTokenCount: Number(row.observationTokenCount ?? 0),
      pendingMessageTokens: Number(row.pendingMessageTokens ?? 0),
      isReflecting: Boolean(row.isReflecting),
      isObserving: Boolean(row.isObserving),
      isBufferingObservation: Boolean(row.isBufferingObservation),
      isBufferingReflection: Boolean(row.isBufferingReflection),
      lastBufferedAtTokens: Number(row.lastBufferedAtTokens ?? 0),
      lastBufferedAtTime: row.lastBufferedAtTime ? new Date(String(row.lastBufferedAtTime)) : null,
      config: this.#json(row.config, {}),
      metadata: row.metadata ? this.#json(row.metadata, {}) : undefined,
    };
  }

  #activationBoundary(
    chunks: BufferedObservationChunk[],
    input: SwapBufferedToActiveInput,
  ): number {
    const floor = input.messageTokensThreshold * (1 - input.activationRatio);
    const target = Math.max(0, input.currentPendingTokens - floor);
    let cumulative = 0;
    let over = 0;
    let overTokens = 0;
    let under = 0;
    let underTokens = 0;
    for (let index = 0; index < chunks.length; index++) {
      cumulative += chunks[index]!.messageTokens ?? 0;
      if (cumulative >= target && (!over || cumulative < overTokens))
        [over, overTokens] = [index + 1, cumulative];
      if (cumulative < target && cumulative > underTokens)
        [under, underTokens] = [index + 1, cumulative];
    }
    const minRemaining = Math.min(1000, floor);
    if (input.forceMaxActivation && over && input.currentPendingTokens - overTokens >= minRemaining)
      return over;
    if (
      over &&
      overTokens - target <= floor * 0.95 &&
      input.currentPendingTokens - overTokens >= minRemaining
    )
      return over;
    if (under && input.currentPendingTokens - underTokens >= minRemaining) return under;
    return over || 1;
  }

  #emptySwap(): SwapBufferedToActiveResult {
    return {
      chunksActivated: 0,
      messageTokensActivated: 0,
      observationTokensActivated: 0,
      messagesActivated: 0,
      activatedCycleIds: [],
      activatedMessageIds: [],
    };
  }
}

import { MastraServerCache } from '@mastra/core/cache';
import type { DoSqliteStorage } from './do-workflows';

export type SqliteValue = string | number | null | ArrayBuffer;
export type SqliteRow = Record<string, unknown>;
export interface SqliteStatement {
  sql: string;
  args?: SqliteValue[];
}
/** batch must execute and commit all statements atomically, or roll them all back. */
export interface SqliteCacheDriver {
  execute(sql: string, args?: SqliteValue[]): Promise<SqliteRow[]>;
  batch(statements: SqliteStatement[]): Promise<SqliteRow[][]>;
}
export function createDoSqliteCacheDriver(storage: DoSqliteStorage): SqliteCacheDriver {
  const execute = ({ sql, args = [] }: SqliteStatement): SqliteRow[] => [
    ...storage.sql.exec(sql, ...args),
  ];
  return {
    async execute(sql, args) {
      return execute({ sql, args });
    },
    async batch(statements) {
      return storage.transactionSync(() => statements.map(execute));
    },
  };
}

/** Persisted values, list streams, counters and expirations in a single SQLite table. */
export class SqliteCache extends MastraServerCache {
  private readonly driver: SqliteCacheDriver;
  private readonly ttlMs: number;
  private readonly ready: Promise<unknown>;
  constructor({ driver, ttlMs = 5 * 60 * 1000 }: { driver: SqliteCacheDriver; ttlMs?: number }) {
    super({ name: 'SqliteCache' });
    this.driver = driver;
    this.ttlMs = ttlMs;
    this.ready = driver.execute(
      'CREATE TABLE IF NOT EXISTS execution_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)',
    );
  }
  private expiry(ttlMs = this.ttlMs) {
    return ttlMs > 0 ? Date.now() + ttlMs : null;
  }
  async get(key: string): Promise<unknown> {
    await this.ready;
    const rows = await this.driver.execute(
      'SELECT value FROM execution_cache WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)',
      [key, Date.now()],
    );
    return rows[0] ? JSON.parse(rows[0].value as string).value : undefined;
  }
  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    await this.ready;
    // The envelope preserves an explicitly undefined value across process restarts.
    await this.driver.execute(
      `INSERT INTO execution_cache VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at`,
      [key, JSON.stringify({ value }), this.expiry(ttlMs)],
    );
  }
  async listLength(key: string): Promise<number> {
    const value = await this.get(key);
    if (value === undefined) return 0;
    if (!Array.isArray(value)) throw new Error(`${key} exists but is not an array`);
    return value.length;
  }
  async listFromTo(key: string, from: number, to = -1): Promise<unknown[]> {
    const value = await this.get(key);
    return Array.isArray(value) ? value.slice(from, to === -1 ? undefined : to + 1) : [];
  }
  private incrementStatement(key: string): SqliteStatement {
    return {
      sql: `INSERT INTO execution_cache VALUES (?, '{"value":1}', ?)
        ON CONFLICT(key) DO UPDATE SET value = CASE
          WHEN execution_cache.expires_at IS NOT NULL AND execution_cache.expires_at <= ? THEN excluded.value
          WHEN json_type(execution_cache.value, '$.value') IN ('integer', 'real') THEN json_object('value', json_extract(execution_cache.value, '$.value') + 1)
          WHEN json_type(execution_cache.value, '$.value') IS NULL THEN excluded.value
          ELSE json('cache counter must be a number') END,
          expires_at=excluded.expires_at
        RETURNING json_extract(value, '$.value') AS count`,
      args: [key, this.expiry(), Date.now()],
    };
  }
  private pushStatement(key: string, value: unknown, counterKey?: string): SqliteStatement {
    const encoded = JSON.stringify({ value });
    const element =
      counterKey === undefined
        ? "json(? -> '$.value')"
        : "json_set(json(? -> '$.value'), '$.index', (SELECT json_extract(value, '$.value') - 1 FROM execution_cache WHERE key = ?))";
    return {
      sql: `INSERT INTO execution_cache VALUES (?, json_object('value', json_array(${element})), ?)
        ON CONFLICT(key) DO UPDATE SET value = CASE
          WHEN execution_cache.expires_at IS NOT NULL AND execution_cache.expires_at <= ? THEN excluded.value
          WHEN json_type(execution_cache.value, '$.value') = 'array' THEN json_set(execution_cache.value, '$.value', json_insert(json_extract(execution_cache.value, '$.value'), '$[#]', json(excluded.value -> '$.value[0]')))
          WHEN json_type(execution_cache.value, '$.value') IS NULL THEN excluded.value
          ELSE json('cache list must be an array') END,
          expires_at = CASE WHEN execution_cache.expires_at <= ? OR ? > 0 THEN excluded.expires_at ELSE execution_cache.expires_at END`,
      args: [
        key,
        encoded,
        ...(counterKey === undefined ? [] : [counterKey]),
        this.expiry(),
        Date.now(),
        Date.now(),
        this.ttlMs,
      ],
    };
  }
  async listPush(key: string, value: unknown): Promise<void> {
    await this.ready;
    const statement = this.pushStatement(key, value);
    await this.driver.execute(statement.sql, statement.args);
  }
  async increment(key: string): Promise<number> {
    await this.ready;
    const statement = this.incrementStatement(key);
    return (await this.driver.execute(statement.sql, statement.args))[0]!.count as number;
  }
  async listPushIndexed(
    listKey: string,
    counterKey: string,
    value: Record<string, unknown>,
  ): Promise<number> {
    await this.ready;
    const rows = await this.driver.batch([
      this.incrementStatement(counterKey),
      this.pushStatement(listKey, value, counterKey),
    ]);
    return (rows[0]![0]!.count as number) - 1;
  }
  async delete(key: string): Promise<void> {
    await this.ready;
    await this.driver.execute('DELETE FROM execution_cache WHERE key = ?', [key]);
  }
  /** Remove expired keys from disk; Node hosts call this from their retention sweep. */
  async prune(): Promise<number> {
    await this.ready;
    const rows = await this.driver.execute(
      'DELETE FROM execution_cache WHERE expires_at IS NOT NULL AND expires_at <= ? RETURNING key',
      [Date.now()],
    );
    return rows.length;
  }
  async clear(): Promise<void> {
    await this.ready;
    await this.driver.execute('DELETE FROM execution_cache');
  }
}
export class DoSqliteCache extends SqliteCache {
  constructor({ storage, ttlMs }: { storage: DoSqliteStorage; ttlMs?: number }) {
    super({ driver: createDoSqliteCacheDriver(storage), ttlMs });
  }
}

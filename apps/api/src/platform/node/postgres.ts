import type { Pool, PoolClient, QueryResult } from 'pg';
import type { AppDatabase, AppResult, AppStatement } from '../../db/database';
import { normalizeDatabaseError } from '../../db/database';

function quotedEnd(sql: string, start: number, delimiter: string, escapes: boolean) {
  let end = start + delimiter.length;
  while (end < sql.length) {
    if (escapes && sql[end] === '\\') {
      end += 2;
      continue;
    }
    if (!sql.startsWith(delimiter, end)) {
      end++;
      continue;
    }
    end += delimiter.length;
    if (delimiter.length === 1 && sql.startsWith(delimiter, end)) {
      end++;
      continue;
    }
    return end;
  }
  return end;
}
function commentEnd(sql: string, start: number) {
  let end = start + 2;
  let depth = 1;
  while (end < sql.length && depth) {
    if (sql.startsWith('/*', end)) {
      depth++;
      end += 2;
    } else if (sql.startsWith('*/', end)) {
      depth--;
      end += 2;
    } else end++;
  }
  return end;
}
function protectedEnd(sql: string, start: number): number | undefined {
  const rest = sql.slice(start);
  const dollar = rest.match(/^\$[a-zA-Z_][a-zA-Z_0-9]*\$|^\$\$/)?.[0];
  if (dollar) return quotedEnd(sql, start, dollar, false);
  if (sql[start] === "'" || sql[start] === '"') {
    const escapes = sql[start] === "'" && /(?:^|[^\w])[eE]$/.test(sql.slice(0, start));
    return quotedEnd(sql, start, sql[start]!, escapes);
  }
  if (rest.startsWith('/*')) return commentEnd(sql, start);
  if (rest.startsWith('--')) {
    const end = sql.indexOf('\n', start);
    return end < 0 ? sql.length : end;
  }
  return undefined;
}

/** Bind placeholders only. SQL dialect differences belong in explicit application queries. */
export function postgresParameters(sql: string, parameters: readonly unknown[]) {
  let text = '';
  let next = 0;
  const indexes = new Map<number, number>();
  const values: unknown[] = [];
  for (let i = 0; i < sql.length; ) {
    const end = protectedEnd(sql, i);
    if (end !== undefined) {
      text += sql.slice(i, end);
      i = end;
      continue;
    }
    if (sql[i] !== '?') {
      text += sql[i++];
      continue;
    }
    const digits = sql.slice(i + 1).match(/^\d+/)?.[0];
    const source = digits ? Number(digits) - 1 : next;
    next = Math.max(next, source + 1);
    if (source < 0 || source >= parameters.length) throw new Error('Missing SQL bind parameter');
    let target = indexes.get(source);
    if (target === undefined) {
      values.push(parameters[source]);
      target = values.length;
      indexes.set(source, target);
    }
    text += `$${target}`;
    i += 1 + (digits?.length ?? 0);
  }
  return { text, values };
}

function resultOf<T>(result: QueryResult): AppResult<T> {
  // PostgreSQL returns COUNT/SUM(bigint) as strings by default; the application uses numbers.
  for (const field of result.fields)
    if (field.dataTypeID === 20) {
      for (const row of result.rows)
        if (row[field.name] !== null) {
          const number = Number(row[field.name]);
          if (!Number.isSafeInteger(number))
            throw new Error(`SQL integer exceeds safe range: ${field.name}`);
          row[field.name] = number;
        }
    }
  return {
    success: true,
    results: result.rows as T[],
    meta: { changes: result.command === 'SELECT' ? 0 : (result.rowCount ?? 0) },
  };
}

class PostgresStatement implements AppStatement {
  constructor(
    readonly database: PostgresDatabase,
    readonly sql: string,
    readonly values: readonly unknown[] = [],
  ) {}
  bind(...values: unknown[]) {
    return new PostgresStatement(this.database, this.sql, values);
  }
  async all<T = Record<string, unknown>>() {
    return this.database.query<T>(this.sql, this.values);
  }
  async run<T = Record<string, unknown>>() {
    return this.all<T>();
  }
  async first<T = Record<string, unknown>>(columnName?: string): Promise<T | null> {
    const row = (await this.all<Record<string, unknown>>()).results[0];
    if (!row) return null;
    if (columnName !== undefined && !(columnName in row))
      throw new Error(`Unknown result column: ${columnName}`);
    return (columnName === undefined ? row : row[columnName]) as T;
  }
  async raw<T = unknown[]>() {
    return (await this.all<Record<string, unknown>>()).results.map(
      (row) => Object.values(row) as T,
    );
  }
}

export class PostgresDatabase implements AppDatabase {
  readonly dialect = 'postgres' as const;
  get identity(): object {
    return this.pool;
  }
  private savepoint = 0;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    readonly pool: Pool,
    private readonly client?: PoolClient,
  ) {}
  prepare(sql: string) {
    return new PostgresStatement(this, sql);
  }
  async query<T>(sql: string, values: readonly unknown[]) {
    const bound = postgresParameters(sql, values);
    try {
      return resultOf<T>(await this.execute(bound.text, bound.values));
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }
  async exec(sql: string) {
    const start = Date.now();
    await this.execute(sql);
    return { count: 1, duration: Date.now() - start };
  }
  async batch<T = Record<string, unknown>>(statements: AppStatement[]): Promise<AppResult<T>[]> {
    return this.transaction(async (db) => {
      const results: AppResult<T>[] = [];
      for (const statement of statements) {
        if (!(statement instanceof PostgresStatement) || statement.database.pool !== this.pool)
          throw new Error('Cannot batch a statement from another database');
        results.push(await (db as PostgresDatabase).query<T>(statement.sql, statement.values));
      }
      return results;
    });
  }
  async transaction<T>(
    callback: (db: AppDatabase) => Promise<T>,
    locks: string[] = [],
  ): Promise<T> {
    if (this.client) {
      const savepoint = `walden_${++this.savepoint}`;
      await this.execute(`SAVEPOINT ${savepoint}`);
      try {
        await this.lock(locks);
        const result = await callback(this);
        await this.execute(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        await this.execute(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await this.execute(`RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      }
    }
    const client = await this.pool.connect();
    const db = new PostgresDatabase(this.pool, client);
    try {
      await client.query('BEGIN');
      await db.lock(locks);
      const result = await callback(db);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  private execute(sql: string, values?: unknown[]): Promise<QueryResult> {
    if (!this.client) return this.pool.query(sql, values);
    // Application reads use Promise.all; a PostgreSQL connection executes one query at a time.
    const result = this.pending.then(() => this.client!.query(sql, values));
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private async lock(keys: string[]) {
    for (const key of [...new Set(keys)].sort())
      await this.execute('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
  }
}

export const createPostgresDatabase = (pool: Pool): AppDatabase => new PostgresDatabase(pool);

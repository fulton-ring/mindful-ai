import { closeSync, openSync, rmSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  type AppDatabase,
  type AppResult,
  type AppStatement,
  normalizeDatabaseError,
} from '../../db/database';

const parameters = (values: unknown[]): SQLInputValue[] =>
  values.map((value) => {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      value instanceof Uint8Array
    )
      return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    throw new TypeError('SQL parameters must be strings, numbers, bigints, byte arrays or null');
  });

export interface SqliteDatabase extends AppDatabase {
  readonly dialect: 'sqlite';
  readonly native: DatabaseSync;
  close(): void;
  backup(destination: string): Promise<void>;
  integrityCheck(): Promise<void>;
}

const numberParameters = (sql: string) => {
  // Normalize placeholder numbering only; SQLite parses and binds the SQL itself.
  // node:sqlite otherwise overwrites numbered bindings when anonymous slots are mixed in.
  let slot = 0;
  const slots = new Set<number>();
  const numbered = sql.replace(
    /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|\?(\d+)?/g,
    (token, position?: string) => {
      if (!token.startsWith('?')) return token;
      const index = position ? Number(position) : slot + 1;
      slot = Math.max(slot, index);
      slots.add(index);
      return `?${index}`;
    },
  );
  return { numbered, slots, slot };
};

const createStatement = (
  native: DatabaseSync,
  owned: WeakMap<AppStatement, () => AppResult<unknown>>,
  sql: string,
): AppStatement => {
  const { numbered, slots, slot } = numberParameters(sql);
  const statement = native.prepare(numbered);
  let bound: unknown[] = [];
  const args = () => {
    const values = parameters(bound);
    if (values.length !== slot)
      throw new Error(`Expected ${slot} SQL parameters, received ${values.length}`);
    const named: Record<string, SQLInputValue> = {};
    for (const index of slots) named[`?${index}`] = values[index - 1];
    return named;
  };
  const guarded = <T>(operation: () => T): T => {
    try {
      return operation();
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  };
  const rows = () => guarded(() => statement.all(args()));
  const get = () => guarded(() => statement.get(args()));
  const execute = (): AppResult<unknown> => {
    const before = native.prepare('SELECT total_changes() AS value').get()!.value;
    const results = rows();
    const after = native.prepare('SELECT total_changes() AS value,changes() AS changes').get()!;
    return {
      success: true,
      results,
      meta: { changes: after.value === before ? 0 : Number(after.changes) },
    };
  };
  const wrapper: AppStatement = {
    bind(...values) {
      bound = values;
      return wrapper;
    },
    async first<T>(columnName?: string) {
      const row = get();
      if (!row) return null;
      if (columnName !== undefined && !(columnName in row))
        throw new Error(`Unknown result column: ${columnName}`);
      return (columnName === undefined ? row : row[columnName]) as T;
    },
    async all<T>() {
      return execute() as AppResult<T>;
    },
    async run<T>() {
      return execute() as AppResult<T>;
    },
    async raw<T>() {
      return rows().map((row) => Object.values(row)) as T[];
    },
  };
  owned.set(wrapper, execute);
  return wrapper;
};

/** SQLite/local-file mode is a single application process on local persistent storage. */
export const openSqliteDatabase = (path: string): SqliteDatabase => {
  const native = new DatabaseSync(path);
  native.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
  const owned = new WeakMap<AppStatement, () => AppResult<unknown>>();

  return {
    dialect: 'sqlite',
    identity: native,
    native,
    prepare: (sql) => createStatement(native, owned, sql),
    async batch<T>(statements: AppStatement[]) {
      const execute = statements.map((statement) => {
        const run = owned.get(statement);
        if (!run) throw new Error('Cannot batch statements from a different database');
        return run;
      });
      native.exec('BEGIN IMMEDIATE');
      try {
        const results = execute.map((run) => run() as AppResult<T>);
        native.exec('COMMIT');
        return results;
      } catch (error) {
        native.exec('ROLLBACK');
        throw error;
      }
    },
    async exec(sql) {
      const started = performance.now();
      native.exec(sql);
      return { count: 0, duration: performance.now() - started };
    },
    close() {
      native.close();
    },
    // VACUUM INTO is supported on Node 22.13 and captures WAL pages consistently.
    async backup(destination) {
      const descriptor = openSync(destination, 'wx', 0o600);
      closeSync(descriptor);
      try {
        native.prepare('VACUUM INTO ?').run(destination);
      } catch (error) {
        rmSync(destination, { force: true });
        throw error;
      }
    },
    async integrityCheck() {
      const rows = native.prepare('PRAGMA integrity_check').all();
      if (rows.length !== 1 || rows[0].integrity_check !== 'ok')
        throw new Error('SQLite integrity check failed');
      if (native.prepare('PRAGMA foreign_key_check').all().length)
        throw new Error('SQLite foreign key check failed');
    },
  };
};

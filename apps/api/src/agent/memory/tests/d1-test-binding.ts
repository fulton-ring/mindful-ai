import { execFileSync } from 'node:child_process';

const sqlValue = (value: unknown): string => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
};

/** Binds `?` in order and `?NNN` by position, as D1 does. */
const interpolate = (sql: string, values: unknown[]): string => {
  let index = 0;
  const used = new Set<number>();
  const rendered = sql.replace(/\?(\d+)?/g, (_match, position?: string) => {
    const at = position ? Number(position) - 1 : index++;
    used.add(at);
    return sqlValue(values[at]);
  });
  if (used.size !== values.length)
    throw new Error(`Unused SQL parameters: ${values.length - used.size}`);
  return rendered;
};

type TestStatement = {
  bind(...values: unknown[]): TestStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ success: true; results: T[] }>;
  run(): Promise<{ success: true; meta: { changes: number }; results: never[] }>;
  raw(): Promise<never[]>;
  rendered(): string;
};

/** Minimal D1 binding backed by real SQLite, including atomic D1 batch semantics. */
export const sqliteD1Binding = (file: string): D1Database => {
  const query = (sql: string): Record<string, unknown>[] => {
    const output = execFileSync('sqlite3', ['-json', file, `PRAGMA foreign_keys=ON; ${sql}`], {
      encoding: 'utf8',
    }).trim();
    return output ? (JSON.parse(output) as Record<string, unknown>[]) : [];
  };
  const prepare = (sql: string): TestStatement => {
    let values: unknown[] = [];
    const statement: TestStatement = {
      bind: (...next: unknown[]) => {
        values = next;
        return statement;
      },
      first: async <T>() => query(statement.rendered())[0] as T | null,
      all: async <T>() => ({ success: true, results: query(statement.rendered()) as T[] }),
      run: async () => {
        const rows = query(`${statement.rendered()}; SELECT changes() AS changes;`);
        return { success: true, meta: { changes: Number(rows.at(-1)?.changes ?? 0) }, results: [] };
      },
      raw: async () => [],
      rendered: () => interpolate(sql, values),
    };
    return statement;
  };
  return {
    prepare,
    batch: async (statements: TestStatement[]) => {
      const body = statements
        .map(
          (statement, index) =>
            `${statement.rendered()}; SELECT changes() AS changes, ${index} AS batchIndex;`,
        )
        .join('\n');
      const output = execFileSync(
        'sqlite3',
        ['-json', file, `PRAGMA foreign_keys=ON;\nBEGIN IMMEDIATE;\n${body}\nCOMMIT;`],
        {
          encoding: 'utf8',
        },
      ).trim();
      const rows = output
        ? output
            .split('\n')
            .flatMap((line) => JSON.parse(line) as Array<{ changes: number; batchIndex: number }>)
        : [];
      return statements.map((_, index) => ({
        success: true,
        meta: { changes: rows.find((row) => row.batchIndex === index)?.changes ?? 0 },
        results: [],
      }));
    },
    exec: async (sql: string) => {
      query(sql);
      return { count: 0, duration: 0 };
    },
    dump: async () => new ArrayBuffer(0),
    withSession() {
      return this as unknown as D1DatabaseSession;
    },
  } as unknown as D1Database;
};

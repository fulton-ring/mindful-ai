import { DatabaseSync } from 'node:sqlite';

export function sqliteStorage(db = new DatabaseSync(':memory:')) {
  return {
    sql: {
      exec(query: string, ...args: (string | number | null | ArrayBuffer)[]) {
        return db
          .prepare(query)
          .all(
            ...args.map((value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value)),
          );
      },
    },
    transactionSync<T>(fn: () => T): T {
      db.exec('BEGIN IMMEDIATE');
      try {
        const value = fn();
        db.exec('COMMIT');
        return value;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

/** Normalized SQL execution; dialect-specific SQL is selected explicitly at its caller. */
export type SqlDialect = 'sqlite' | 'postgres';
export type AppQuery = string | { sqlite: string; postgres: string };
export type AppResult<T = Record<string, unknown>> = {
  success: boolean;
  results: T[];
  meta: { changes: number };
  error?: string;
};
export interface AppStatement {
  bind(...values: unknown[]): AppStatement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<AppResult<T>>;
  run<T = Record<string, unknown>>(): Promise<AppResult<T>>;
  raw<T = unknown[]>(): Promise<T[]>;
}
export interface AppDatabase {
  /** Stable host identity across transaction-bound views of the same database. */
  readonly identity?: object;
  /** Absent on native D1 bindings, whose SQL dialect is SQLite. */
  readonly dialect?: SqlDialect;
  prepare(sql: string): AppStatement;
  /** All statements commit together, or none commit. */
  batch<T = Record<string, unknown>>(statements: AppStatement[]): Promise<AppResult<T>[]>;
  exec(sql: string): Promise<{ count: number; duration: number }>;
  /** Interactive transactions are only available on adapters that can safely own a connection. */
  transaction?<T>(callback: (db: AppDatabase) => Promise<T>, locks?: string[]): Promise<T>;
}
export const prepareQuery = (db: AppDatabase, query: AppQuery): AppStatement =>
  db.prepare(typeof query === 'string' ? query : query[db.dialect ?? 'sqlite']);

export class DatabaseConstraintError extends Error {
  readonly code = 'constraint';
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DatabaseConstraintError';
  }
}

export const isConstraintError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  if (error instanceof DatabaseConstraintError) return true;
  const databaseError = error as Error & { code?: string; errcode?: number };
  return (
    /^23\d{3}$/.test(databaseError.code ?? '') ||
    (typeof databaseError.errcode === 'number' && (databaseError.errcode & 255) === 19) ||
    /(?:UNIQUE|NOT NULL|CHECK|FOREIGN KEY) constraint failed|Turn cancelled before admission|A turn is already in progress for this branch/.test(
      error.message,
    )
  );
};

/** Keep constraint text stable for existing admission/validation responses across hosts. */
export const normalizeDatabaseError = (error: unknown): unknown =>
  isConstraintError(error) && !(error instanceof DatabaseConstraintError)
    ? new DatabaseConstraintError((error as Error).message, { cause: error })
    : error;

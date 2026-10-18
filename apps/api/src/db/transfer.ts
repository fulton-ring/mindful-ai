import { type AppDatabase, type AppStatement, prepareQuery } from './database';

/** Application-only logical format; Mastra/native execution stores require their own backup. */
export const APPLICATION_SCHEMA_VERSION = 2;
const tables = [
  'users',
  'app_settings',
  'account_privacy',
  'notes',
  'conversations',
  'conversation_branches',
  'turns',
  'messages',
  'interventions',
  'message_highlights',
  'note_edits',
  'note_history_requests',
  'note_suggestions',
  'note_suggestion_cancellations',
  'personas',
  'hidden_personas',
  'telemetry_deletions',
  'message_windows',
  'turn_cancellations',
  'turn_events',
  'turn_execution_state',
  'auth_user',
  'auth_session',
  'auth_account',
  'auth_verification',
  'research_sources',
  'research_chunks',
  'research_indexing_jobs',
] as const;
type Table = (typeof tables)[number];
type Scalar = string | number | null;
type Row = Record<string, Scalar>;
export type ApplicationSnapshot = {
  format: 'walden-application-snapshot';
  version: 1;
  schemaVersion: number;
  createdAt: string;
  /** Contains sessions and credentials; store this operator artifact privately. */
  tables: Record<Table, Row[]>;
};

const scalar = (value: unknown): Scalar => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return Number(value);
  if (
    value === null ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value;
  throw new Error('Unsupported application snapshot value');
};

const requireSettledTurns = (rows: Record<Table, Row[]>): void => {
  if (rows.conversations.some((row) => row.status === 'purging'))
    throw new Error('Logical application transfer requires completed retention cleanup');
  if (rows.turns.some((turn) => turn.status === 'streaming'))
    throw new Error(
      'Logical application transfer requires settled turns; finish or cancel active turns before exporting or importing',
    );
};

export async function exportApplicationSnapshot(db: AppDatabase): Promise<ApplicationSnapshot> {
  // A repeatable-read snapshot on PG; SQLite batch owns a single transaction already.
  const results = await db.batch([
    prepareQuery(db, {
      sqlite: 'SELECT 1',
      postgres: 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    }),
    ...tables.map((table) => db.prepare(`SELECT * FROM "${table}"`)),
  ]);
  const rows = Object.fromEntries(
    tables.map((table, index) => [
      table,
      results[index + 1].results.map((row) =>
        Object.fromEntries(Object.entries(row).map(([column, value]) => [column, scalar(value)])),
      ),
    ]),
  ) as Record<Table, Row[]>;
  // Logical transfers omit native workflow checkpoints, so an active turn cannot safely resume.
  requireSettledTurns(rows);
  return {
    format: 'walden-application-snapshot',
    version: 1,
    schemaVersion: APPLICATION_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    tables: rows,
  };
}

const validate = (value: unknown): ApplicationSnapshot => {
  if (!value || typeof value !== 'object') throw new Error('Invalid application snapshot');
  const snapshot = value as ApplicationSnapshot;
  if (
    snapshot.format !== 'walden-application-snapshot' ||
    snapshot.version !== 1 ||
    ![1, APPLICATION_SCHEMA_VERSION].includes(snapshot.schemaVersion)
  )
    throw new Error('Unsupported application snapshot schema version');
  if (!snapshot.tables || Object.keys(snapshot.tables).sort().join() !== [...tables].sort().join())
    throw new Error('Snapshot tables do not match application schema');
  for (const table of tables) {
    if (!Array.isArray(snapshot.tables[table])) throw new Error(`Invalid snapshot table ${table}`);
    for (const row of snapshot.tables[table]) {
      if (!row || typeof row !== 'object' || Array.isArray(row))
        throw new Error(`Invalid snapshot row in ${table}`);
      for (const value of Object.values(row)) scalar(value);
    }
  }
  if (snapshot.schemaVersion === 1)
    return {
      ...snapshot,
      schemaVersion: APPLICATION_SCHEMA_VERSION,
      tables: {
        ...snapshot.tables,
        conversations: snapshot.tables.conversations.map((row) => ({
          ...row,
          retention_disabled: 0,
          purge_started_at: null,
          purge_token: null,
        })),
      },
    };
  return snapshot;
};

const insert = (db: AppDatabase, table: Table, row: Row): AppStatement => {
  const columns = Object.keys(row);
  const values = columns.map((column) =>
    table === 'auth_user' && column === 'email_verified' && db.dialect === 'postgres'
      ? Boolean(row[column])
      : row[column],
  );
  return db
    .prepare(
      `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
    )
    .bind(...values);
};

const countSql = tables.map((table) => `(SELECT count(*) FROM "${table}")`).join('+');
const cyclicColumns: Partial<Record<Table, string[]>> = {
  conversation_branches: ['head_message_id', 'forked_from_message_id'],
  messages: ['parent_message_id'],
};

async function importStatements(
  db: AppDatabase,
  snapshot: ApplicationSnapshot,
): Promise<AppStatement[]> {
  const statements: AppStatement[] = [];
  const links: AppStatement[] = [];
  for (const table of tables) {
    const columns = (
      await prepareQuery(db, {
        sqlite: `PRAGMA table_info("${table}")`,
        postgres: `SELECT column_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='${table}'`,
      }).all<{ name: string }>()
    ).results
      .map((column) => column.name)
      .sort();
    for (const original of snapshot.tables[table]) {
      if (Object.keys(original).sort().join() !== columns.join())
        throw new Error(`Snapshot columns do not match schema for ${table}`);
      const row = { ...original };
      for (const column of cyclicColumns[table] ?? []) {
        if (row[column] !== null)
          links.push(
            db.prepare(`UPDATE "${table}" SET "${column}"=? WHERE id=?`).bind(row[column], row.id),
          );
        row[column] = null;
      }
      statements.push(insert(db, table, row));
    }
  }
  return [...statements, ...links];
}

/** Operator-only, quiescent import into a migrated empty database. The full import is atomic. */
export async function importApplicationSnapshot(db: AppDatabase, input: unknown): Promise<void> {
  const snapshot = validate(input);
  requireSettledTurns(snapshot.tables);
  const current = await db.prepare(`SELECT (${countSql}) AS total`).first<{ total: number }>();
  if (Number(current?.total) !== 0)
    throw new Error('Application snapshot import requires an empty target');
  const statements = await importStatements(db, snapshot);
  const emptyGuard = prepareQuery(db, {
    sqlite: `SELECT json(CASE WHEN (${countSql})=0 THEN '{}' ELSE 'Target must be empty' END)`,
    postgres: `SELECT 1 / CASE WHEN (${countSql})=0 THEN 1 ELSE 0 END`,
  });
  await db.batch([
    prepareQuery(db, {
      sqlite: 'SELECT 1',
      postgres: `LOCK TABLE ${tables.map((table) => `"${table}"`).join(',')} IN ACCESS EXCLUSIVE MODE`,
    }),
    emptyGuard,
    ...statements,
    prepareQuery(db, { sqlite: 'DELETE FROM research_chunks_fts', postgres: 'SELECT 1' }),
    prepareQuery(db, {
      sqlite:
        'INSERT INTO research_chunks_fts(chunk_id,owner_scope,text) SELECT id,owner_scope,text FROM research_chunks',
      // PostgreSQL lexical search uses its native expression index rather than a side table.
      postgres: 'SELECT 1',
    }),
  ]);
}

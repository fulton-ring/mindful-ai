import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

/** Versioned, checksummed migrations: no implicit destructive schema synchronization. */
export async function migratePostgres(
  pool: Pool,
  directory = fileURLToPath(new URL('../../../postgres-migrations/', import.meta.url)),
) {
  const files = (await readdir(directory)).filter((file) => /^\d+.*\.sql$/.test(file)).sort();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('walden:migrations',0))");
    await client.query(
      'CREATE TABLE IF NOT EXISTS walden_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const applied = await client.query('SELECT version FROM walden_migrations');
    for (const row of applied.rows)
      if (!files.includes(row.version))
        throw new Error(`Applied migration is missing: ${row.version}`);
    for (const version of files) {
      const sql = await readFile(`${directory}/${version}`, 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query(
        'SELECT checksum FROM walden_migrations WHERE version=$1',
        [version],
      );
      if (existing.rows.length) {
        if (existing.rows[0].checksum !== checksum)
          throw new Error(`Applied migration changed: ${version}`);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO walden_migrations(version,checksum) VALUES($1,$2)', [
        version,
        checksum,
      ]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

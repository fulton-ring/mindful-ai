import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppDatabase } from '../../db/database';

/** HTTP and worker processes never upgrade schemas while serving traffic. */
export async function requireCompatibleSchema(db: AppDatabase, directory: string | URL) {
  const files = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  let applied: { name: string; checksum: string }[];
  try {
    applied = (
      await db
        .prepare(
          db.dialect === 'postgres'
            ? 'SELECT version AS name,checksum FROM walden_migrations'
            : 'SELECT name,checksum FROM app_migrations',
        )
        .all<{ name: string; checksum: string }>()
    ).results;
  } catch {
    throw new Error(
      'Database schema is missing; run the migrate command before starting this role.',
    );
  }
  const expected = await Promise.all(
    files.map(async (name) => ({
      name,
      checksum: createHash('sha256')
        .update(
          await readFile(
            directory instanceof URL ? new URL(name, directory) : join(directory, name),
          ),
        )
        .digest('hex'),
    })),
  );
  if (
    applied.length !== expected.length ||
    applied.some(
      (row) => !expected.some((file) => file.name === row.name && file.checksum === row.checksum),
    )
  )
    throw new Error(
      'Database migration version or checksum differs; stop traffic and run migrate with the matching release.',
    );
}

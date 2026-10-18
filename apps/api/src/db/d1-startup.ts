import baseline from '../../migrations/0000_baseline.sql';
import selfHosting from '../../migrations/0001_self_hosting.sql';
import retention from '../../migrations/0002_retention_policy.sql';
import { applyD1Migrations } from './d1-migrations';
import type { AppDatabase } from './database';

export const D1_STARTUP_MIGRATIONS = [
  { name: '0000_baseline.sql', sql: baseline },
  { name: '0001_self_hosting.sql', sql: selfHosting },
  { name: '0002_retention_policy.sql', sql: retention },
] as const;
const startup = new WeakMap<object, Promise<void>>();

/** Each isolate waits once per binding; a failed startup remains retryable. */
export function ensureD1Schema(db: AppDatabase): Promise<void> {
  const key = db.identity ?? db;
  const existing = startup.get(key);
  if (existing) return existing;
  const ready = applyD1Migrations(db, D1_STARTUP_MIGRATIONS).catch((error) => {
    startup.delete(key);
    throw error;
  });
  startup.set(key, ready);
  return ready;
}

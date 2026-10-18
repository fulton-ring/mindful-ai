import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { AppDatabase } from '../../db/database';
import { exportApplicationSnapshot, importApplicationSnapshot } from '../../db/transfer';
import type { Bindings } from '../../types';
import { readNodeConfig } from './config';
import type { SqliteDatabase } from './sqlite';
import { restoreSqliteBackup } from './sqlite-maintenance';

const usage =
  'Usage: cli migrate | auth < command.json | export FILE | import FILE | backup FILE | restore FILE | check | config';
const validateArguments = (args: string[]) => {
  if (['migrate', 'auth', 'check', 'config'].includes(args[0]) && args.length === 1) return;
  if (['export', 'import', 'backup', 'restore'].includes(args[0]) && args.length === 2 && args[1])
    return;
  throw new Error(usage);
};

type MaintenanceRuntime = {
  db: AppDatabase;
  env: Bindings;
  sqlite?: SqliteDatabase;
  close(): Promise<void> | void;
};
const stdin = async () => {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > 64 * 1024) throw new Error('Authentication command exceeds 64 KiB');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
};
const argument = (args: string[]) => {
  if (args.length !== 2 || !args[1]) throw new Error(`${args[0]} requires exactly one file path`);
  return args[1];
};

/** No HTTP transport: these commands run with the operator's database credentials. */
export async function runMaintenanceCommand(
  runtime: MaintenanceRuntime,
  args: string[],
): Promise<unknown> {
  validateArguments(args);
  switch (args[0]) {
    case 'migrate':
      return { migrated: true };
    case 'auth': {
      if (args.length !== 1) throw new Error('Pass authentication command JSON on stdin');
      const { runAuthAdminCommand } = await import('../../auth/admin');
      return runAuthAdminCommand(runtime.env, JSON.parse(await stdin()));
    }
    case 'export': {
      const destination = argument(args);
      const snapshot = await exportApplicationSnapshot(runtime.db);
      await writeFile(destination, JSON.stringify(snapshot), { flag: 'wx', mode: 0o600 });
      return { file: destination, scope: 'application-only', containsPrivateCredentials: true };
    }
    case 'import': {
      const source = argument(args);
      await importApplicationSnapshot(runtime.db, JSON.parse(await readFile(source, 'utf8')));
      return { imported: true, scope: 'application-only' };
    }
    case 'backup': {
      const destination = argument(args);
      if (!runtime.sqlite)
        throw new Error(
          'Physical PostgreSQL backups require pg_dump; use export for application-only JSON',
        );
      await runtime.sqlite.integrityCheck();
      await runtime.sqlite.backup(destination);
      return {
        file: destination,
        scope: 'sqlite-application-database',
        attachmentsIncluded: false,
        externalMastraStoresIncluded: false,
      };
    }
    case 'check': {
      if (runtime.sqlite) await runtime.sqlite.integrityCheck();
      else await runtime.db.prepare('SELECT 1').first();
      return { database: 'ok' };
    }
    default:
      throw new Error(usage);
  }
}

export async function runNodeCli(args = process.argv.slice(2)): Promise<unknown> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === 'help')) return { usage };
  validateArguments(args);
  const config = readNodeConfig({ ...process.env, APP_ROLE: 'migrate' });
  if (args[0] === 'config')
    return {
      role: config.role,
      appUrl: config.appUrl,
      dataDir: config.dataDir,
      database: config.databaseUrl ? 'postgres' : 'sqlite',
      fileStorage: config.fileStorage,
      embeddingModelDir: config.embeddingModelDir,
      embeddingRevision: config.embeddingRevision,
    };
  if (args[0] === 'restore') {
    if (config.databaseUrl) throw new Error('Physical PostgreSQL restore requires pg_restore');
    await restoreSqliteBackup(argument(args), config.sqlitePath);
    return {
      restored: true,
      file: config.sqlitePath,
      attachmentsIncluded: false,
      externalMastraStoresIncluded: false,
    };
  }
  // Keep research models, Chromium and execution hosts out of maintenance startup.
  const { createNodeRuntime } = await import('./runtime');
  const runtime = await createNodeRuntime(config, { migrate: true, maintenance: true });
  try {
    return await runMaintenanceCommand(runtime, args);
  } finally {
    await runtime.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runNodeCli()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'Command failed'}\n`);
      process.exitCode = 1;
    });
}

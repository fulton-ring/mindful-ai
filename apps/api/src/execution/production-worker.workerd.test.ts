import { access, readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const test = process.env.WALDEN_TEST_WORKER_BUNDLE === '1' ? it : it.skip;
const migrations = new URL('../../migrations/', import.meta.url);
const migrationNames = async () =>
  (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort();

/** Consume the exact Worker and SQL/Wasm modules emitted by Wrangler, without test bootstrap. */
async function worker() {
  const bundle = join(dirname(fileURLToPath(import.meta.url)), '../../dist/worker.js');
  await access(bundle);
  const modules: Array<{ type: string; path: string; contents: string | Uint8Array }> = [
    { type: 'ESModule', path: bundle, contents: await readFile(bundle, 'utf8') },
  ];
  for (const name of await readdir(dirname(bundle))) {
    if (!name.endsWith('.wasm') && !name.endsWith('.sql')) continue;
    modules.push({
      type: name.endsWith('.wasm') ? 'CompiledWasm' : 'Text',
      path: join(dirname(bundle), name),
      contents: await readFile(
        join(dirname(bundle), name),
        name.endsWith('.sql') ? 'utf8' : undefined,
      ),
    });
  }
  return new Miniflare(
    convertV4MiniflareOptions({
      name: 'production-worker-gate',
      modules,
      modulesRoot: dirname(bundle),
      compatibilityDate: '2026-09-18',
      compatibilityFlags: ['nodejs_compat'],
      bindings: { AUTH_MODE: 'none' },
      d1Databases: { DB: 'production-worker-fixture' },
      durableObjects: { CHAT_TURN: { className: 'ChatTurn', useSQLite: true } },
    }),
  );
}

async function expectMigrated(db: D1Database) {
  const expected = await migrationNames();
  const ledger = await db
    .prepare('SELECT name,checksum FROM app_migrations ORDER BY name')
    .all<{ name: string; checksum: string }>();
  expect(ledger.results.map((row) => row.name)).toEqual(expected);
  for (const row of ledger.results) expect(row.checksum).toMatch(/^[a-f0-9]{64}$/);
  expect(
    (
      await db.prepare('SELECT name FROM d1_migrations ORDER BY name').all<{ name: string }>()
    ).results.map((row) => row.name),
  ).toEqual(expected);
  expect(
    (await db.prepare('PRAGMA table_info(conversations)').all<{ name: string }>()).results.map(
      (row) => row.name,
    ),
  ).toEqual(expect.arrayContaining(['retention_disabled', 'purge_started_at', 'purge_token']));
}

/** Opt in after `pnpm --filter @walden/api build`; these tests use real workerd/D1/DO. */
test('first emitted Worker request migrates empty D1 before serving and initializes ChatTurn', async () => {
  const mf = await worker();
  try {
    const db = (await mf.getD1Database('DB')) as D1Database;
    expect(
      await db.prepare("SELECT name FROM sqlite_master WHERE name='users'").first(),
    ).toBeNull();
    const config = await mf.dispatchFetch('http://local/api/config');
    expect(config.status).toBe(200);
    expect(await config.json()).toMatchObject({ auth: { mode: 'none' }, turnProtocolVersion: 2 });
    await expectMigrated(db);
    const namespace = await mf.getDurableObjectNamespace('CHAT_TURN');
    const stub = namespace.get(namespace.idFromName('nonexistent'));
    await stub.start('nonexistent');
    expect((await stub.stream('nonexistent', 0)).status).toBe(204);
    await stub.purge('nonexistent');
    await stub.purge('nonexistent');
    expect((await stub.stream('nonexistent', 0)).status).toBe(204);
  } finally {
    await mf.dispose();
  }
}, 30000);

test('concurrent cold Worker requests migrate once before account admission', async () => {
  const mf = await worker();
  try {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => mf.dispatchFetch('http://local/api/account')),
    );
    for (const response of responses) expect(response.status).toBe(200);
    const accounts = await Promise.all(
      responses.map((response) => response.json() as Promise<{ id: string }>),
    );
    expect(new Set(accounts.map((account) => account.id)).size).toBe(1);
    const db = (await mf.getD1Database('DB')) as D1Database;
    await expectMigrated(db);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM users').first()).toEqual({ n: 1 });
  } finally {
    await mf.dispose();
  }
}, 30000);

test('a cold ChatTurn event initializes D1 without an earlier HTTP request', async () => {
  const mf = await worker();
  try {
    const namespace = await mf.getDurableObjectNamespace('CHAT_TURN');
    const stub = namespace.get(namespace.idFromName('cold-nonexistent'));
    await stub.start('cold-nonexistent');
    await expectMigrated((await mf.getD1Database('DB')) as D1Database);
    expect((await stub.stream('cold-nonexistent', 0)).status).toBe(204);
  } finally {
    await mf.dispose();
  }
}, 30000);

async function legacyFixture(db: D1Database) {
  const baseline = await readFile(new URL('0000_baseline.sql', migrations), 'utf8');
  for (const sql of baseline.split('--> statement-breakpoint').filter((part) => part.trim()))
    await db.prepare(sql).run();
  // Exact migration table shape used by the installed Wrangler; only the old release was applied.
  await db
    .prepare(
      'CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
    )
    .run();
  await db
    .prepare(
      "INSERT INTO d1_migrations(name,applied_at) VALUES('0000_baseline.sql','2026-09-17 12:00:00')",
    )
    .run();
  const message = JSON.stringify({
    id: 'legacy-message',
    role: 'user',
    parts: [{ type: 'text', text: 'Preserve my existing conversation.' }],
  });
  await db.batch([
    db.prepare(
      "INSERT INTO users(id,auth_subject,created_at,updated_at) VALUES('legacy-owner','legacy-clerk','2026-09-17','2026-09-17')",
    ),
    db.prepare(
      "INSERT INTO notes(id,owner_id,markdown,created_at,updated_at) VALUES('legacy-note','legacy-owner','Original private note','2026-09-17','2026-09-17')",
    ),
    db.prepare(
      "INSERT INTO conversations(id,owner_id,note_id,last_user_activity_at,expires_at,created_at) VALUES('legacy-chat','legacy-owner','legacy-note','2026-09-17','2999-01-01','2026-09-17')",
    ),
    db.prepare(
      "INSERT INTO conversation_branches(id,conversation_id,owner_id,is_default,created_at) VALUES('legacy-branch','legacy-chat','legacy-owner',1,'2026-09-17')",
    ),
    db
      .prepare(
        "INSERT INTO messages(id,conversation_id,owner_id,role,origin_branch_id,created_at,ui_message) VALUES('legacy-message','legacy-chat','legacy-owner','user','legacy-branch','2026-09-17',?)",
      )
      .bind(message),
    db.prepare(
      "UPDATE conversation_branches SET head_message_id='legacy-message' WHERE id='legacy-branch'",
    ),
  ]);
  return message;
}

test('first Worker request upgrades a populated Wrangler baseline without resetting user data', async () => {
  const mf = await worker();
  try {
    const db = (await mf.getD1Database('DB')) as D1Database;
    const message = await legacyFixture(db);
    const response = await mf.dispatchFetch('http://local/api/config');
    expect(response.status).toBe(200);
    await expectMigrated(db);
    expect(
      await db
        .prepare("SELECT id,auth_subject,auth_provider FROM users WHERE id='legacy-owner'")
        .first(),
    ).toEqual({ id: 'legacy-owner', auth_subject: 'legacy-clerk', auth_provider: 'clerk' });
    expect(
      await db.prepare("SELECT ui_message FROM messages WHERE id='legacy-message'").first(),
    ).toEqual({ ui_message: message });
    expect(await db.prepare("SELECT markdown FROM notes WHERE id='legacy-note'").first()).toEqual({
      markdown: 'Original private note',
    });
    expect(
      await db
        .prepare("SELECT head_message_id FROM conversation_branches WHERE id='legacy-branch'")
        .first(),
    ).toEqual({ head_message_id: 'legacy-message' });
    expect(
      await db
        .prepare("SELECT applied_at FROM d1_migrations WHERE name='0000_baseline.sql'")
        .first(),
    ).toEqual({ applied_at: '2026-09-17 12:00:00' });
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    expect((await mf.dispatchFetch('http://local/api/config')).status).toBe(200);
    await expectMigrated(db);
  } finally {
    await mf.dispose();
  }
}, 30000);

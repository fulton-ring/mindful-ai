import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PERSONAS, uiMessageText } from '@walden/contracts';
import { build } from 'esbuild';
import { afterEach, expect, it } from 'vitest';
import type { Bindings } from '../../types';
import { createNodeExecutionHost } from './execution-host';
import { openSqliteDatabase, type SqliteDatabase } from './sqlite';
import { applySqliteMigrations } from './sqlite-migrations';
import { createNodeTurnRouter } from './turns';

const test = process.env.WALDEN_TEST_TURN_CRASH === '1' ? it : it.skip;
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function providerFixture() {
  let hold = true;
  let calls = 0;
  const requests = new Set<ServerResponse>();
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* Consume the real compatible request. */
    }
    calls++;
    requests.add(response);
    response.on('close', () => requests.delete(response));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: object, finish_reason: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    chunk({ role: 'assistant', content: hold ? 'Partial ' : 'Native answer.' });
    if (!hold) {
      chunk({}, 'stop');
      response.end('data: [DONE]\n\n');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    for (const response of requests) response.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address() as import('node:net').AddressInfo;
  return {
    env: {
      AI_PROVIDER: 'openai-compatible',
      AI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      AI_API_KEY: 'fixture-only',
      AI_MODEL: 'fixture-model',
    },
    answer() {
      hold = false;
    },
    calls: () => calls,
  };
}

async function seedTurn(db: SqliteDatabase) {
  const now = new Date().toISOString();
  const input = {
    ownerId: 'owner',
    turnId: 'turn',
    requestId: 'request',
    userMessageId: 'user',
    forked: false,
    conversation: {
      id: 'conversation',
      title: 'Crash fixture',
      noteId: null,
      messages: [],
      expiresAt: '2999-01-01',
      learningChecksEnabled: false,
      branchId: 'branch',
      branches: [],
    },
    note: null,
    persona: DEFAULT_PERSONAS[0],
    message: 'Answer.',
    action: 'message',
  };
  await db
    .prepare('INSERT INTO users(id,auth_subject,created_at,updated_at) VALUES(?,?,?,?)')
    .bind('owner', 'fixture', now, now)
    .run();
  await db
    .prepare(
      "INSERT INTO conversations(id,owner_id,title,last_user_activity_at,expires_at,status,created_at) VALUES('conversation','owner','Crash fixture',?,'2999-01-01','active',?)",
    )
    .bind(now, now)
    .run();
  await db
    .prepare(
      "INSERT INTO conversation_branches(id,conversation_id,owner_id,is_default,created_at) VALUES('branch','conversation','owner',1,?)",
    )
    .bind(now)
    .run();
  await db
    .prepare(
      "INSERT INTO turns(id,request_id,conversation_id,owner_id,status,created_at,branch_id,source_branch_id,input_json,user_message_id) VALUES('turn','request','conversation','owner','streaming',?,'branch','branch',?,'user')",
    )
    .bind(now, JSON.stringify(input))
    .run();
  await db
    .prepare(
      "INSERT INTO messages(id,conversation_id,turn_id,owner_id,role,created_at,origin_branch_id,ui_message) VALUES('user','conversation','turn','owner','user',?,'branch',?)",
    )
    .bind(
      now,
      JSON.stringify({
        id: 'user',
        role: 'user',
        parts: [{ type: 'text', text: 'Answer.' }],
        metadata: { createdAt: now },
      }),
    )
    .run();
}

async function startCrashChild(directory: string, env: object) {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  // Keep external package resolution beside the app's node_modules, then remove the bundle.
  const bundleDirectory = await mkdtemp(join(sourceDirectory, '.turn-crash-child-'));
  cleanup.push(() => rm(bundleDirectory, { recursive: true, force: true }));
  const bundle = join(bundleDirectory, 'owner.mjs');
  await build({
    stdin: {
      contents: `
    import { join } from 'node:path';
    import { openSqliteDatabase } from './sqlite';
    import { createNodeExecutionHost } from './execution-host';
    import { createNodeTurnRouter } from './turns';
    const directory = process.argv[2];
    const db = openSqliteDatabase(join(directory, 'application.sqlite'));
    const host = await createNodeExecutionHost({ database: db, dataDir: directory });
    const env = { DB: db, ...JSON.parse(process.argv[3]) };
    const turns = createNodeTurnRouter(env, host.host, { execute: true, pollMs: 5 });
    env.TURNS = turns.router;
    await turns.router.get('turn').start('turn');
    process.send?.({ ready: true });
    setInterval(() => {}, 1000);
  `,
      resolveDir: sourceDirectory,
      loader: 'ts',
    },
    outfile: bundle,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    packages: 'external',
    alias: {
      '@walden/domain': fileURLToPath(
        new URL('../../../../../packages/domain/src/index.ts', import.meta.url),
      ),
      '@walden/contracts': fileURLToPath(
        new URL('../../../../../packages/contracts/src/index.ts', import.meta.url),
      ),
    },
  });
  const child = spawn(process.execPath, [bundle, directory, JSON.stringify(env)], {
    cwd: sourceDirectory,
    env: { PATH: process.env.PATH },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout?.on('data', (data) => {
    output = (output + String(data)).slice(-16000);
  });
  child.stderr?.on('data', (data) => {
    output = (output + String(data)).slice(-16000);
  });
  cleanup.push(() => killOwner(child));
  return { child, output: () => output };
}

async function killOwner(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  const [, signal] = await exited;
  expect(signal).toBe('SIGKILL');
}

async function crashFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'walden-turn-sigkill-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const db = openSqliteDatabase(join(directory, 'application.sqlite'));
  cleanup.push(() => db.close());
  await applySqliteMigrations(db, new URL('../../../migrations/', import.meta.url));
  await seedTurn(db);
  const provider = await providerFixture();
  const owner = await startCrashChild(directory, provider.env);
  await expect
    .poll(
      async () => {
        if (owner.child.exitCode !== null) throw new Error(owner.output());
        return (
          await db
            .prepare("SELECT event_json FROM turn_events WHERE turn_id='turn' ORDER BY sequence")
            .all<{ event_json: string }>()
        ).results.some((row) => JSON.parse(row.event_json).delta === 'Partial ');
      },
      { timeout: 15000 },
    )
    .toBe(true);
  await killOwner(owner.child);
  expect(provider.calls()).toBe(1);
  expect(
    await db.prepare("SELECT status,execution_generation FROM turns WHERE id='turn'").first(),
  ).toEqual({ status: 'streaming', execution_generation: 1 });
  return { directory, db, provider };
}

test('recovers the full shared Node turn runner after SIGKILL without duplicating partial text', async () => {
  const { directory, db, provider } = await crashFixture();
  const host = await createNodeExecutionHost({ database: db, dataDir: directory });
  cleanup.push(() => host.close());
  const workflows = (await host.host.storage.getStore('workflows'))!;
  expect(
    await workflows.loadWorkflowSnapshot({ workflowName: 'durable-agentic-loop', runId: 'turn' }),
  ).toMatchObject({ status: 'running' });
  const ownership = (await workflows.getRunOwnership({ runId: 'turn' }))!;
  expect(ownership).not.toBeNull();
  // The owner is confirmed dead above; release its persisted lease to avoid a 30s wait.
  expect(
    await workflows.releaseRunOwnership({
      runId: 'turn',
      ownerId: ownership.ownerId,
      generation: ownership.generation,
    }),
  ).toBe(true);
  provider.answer();
  const env = { DB: db, ...provider.env } as Bindings;
  const router = createNodeTurnRouter(env, host.host, { execute: true, pollMs: 5 });
  cleanup.push(() => router.close());
  env.TURNS = router.router;
  const response = await router.router.get('turn').stream('turn', 0);
  const events = await response.text();
  expect(events).toContain('data-turn-replace');
  expect(events).toContain('Native answer.');
  expect(events).toContain('[DONE]');
  expect(provider.calls()).toBe(2);
  expect(
    await db.prepare("SELECT status,execution_generation FROM turns WHERE id='turn'").first(),
  ).toEqual({ status: 'completed', execution_generation: 2 });
  const message = await db
    .prepare("SELECT ui_message FROM messages WHERE id='turn'")
    .first<{ ui_message: string }>();
  expect(uiMessageText(JSON.parse(message!.ui_message))).toBe('Native answer.');
}, 60000);

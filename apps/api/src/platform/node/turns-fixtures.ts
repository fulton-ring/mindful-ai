import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERSONAS } from '@walden/contracts';
import { expect } from 'vitest';
import type { AppDatabase } from '../../db/database';
import type { Bindings } from '../../types';
import { createNodeExecutionHost } from './execution-host';
import { openSqliteDatabase } from './sqlite';
import { applySqliteMigrations } from './sqlite-migrations';
import { createNodeTurnRouter } from './turns';
export type Cleanup = () => unknown | Promise<unknown>;

export async function waitForPartial(db: AppDatabase) {
  await expect
    .poll(
      async () =>
        (
          await db
            .prepare("SELECT event_json FROM turn_events WHERE turn_id='turn' ORDER BY sequence")
            .all<{ event_json: string }>()
        ).results.some((row) => JSON.parse(row.event_json).delta === 'Partial '),
      { timeout: 20000 },
    )
    .toBe(true);
}

async function compatibleProvider(cleanup: Cleanup[]) {
  let mode: 'answer' | 'hold' = 'answer';
  let calls = 0;
  const requests = new Set<import('node:http').ServerResponse>();
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* Consume the actual compatible-provider request. */
    }
    calls++;
    requests.add(response);
    response.on('close', () => requests.delete(response));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: object, finish_reason: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    chunk({ role: 'assistant', content: mode === 'hold' ? 'Partial ' : 'Native answer.' });
    if (mode === 'answer') {
      chunk({}, 'stop');
      response.end('data: [DONE]\n\n');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    for (const response of requests) response.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address() as import('node:net').AddressInfo;
  const env = {
    AI_PROVIDER: 'openai-compatible',
    AI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    AI_API_KEY: 'fixture-only',
    AI_MODEL: 'fixture-model',
  };
  return {
    env,
    setMode(next: typeof mode) {
      mode = next;
    },
    calls: () => calls,
  };
}

async function seedTurn(db: AppDatabase) {
  const now = new Date().toISOString();
  const conversation = {
    id: 'conversation',
    title: 'Fixture',
    noteId: null,
    messages: [],
    expiresAt: '2999-01-01',
    learningChecksEnabled: false,
    branchId: 'branch',
    branches: [],
  };
  const input = {
    ownerId: 'owner',
    turnId: 'turn',
    requestId: 'request',
    userMessageId: 'user',
    forked: false,
    conversation,
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
      "INSERT INTO conversations(id,owner_id,title,last_user_activity_at,expires_at,status,created_at) VALUES('conversation','owner','Fixture',?,'2999-01-01','active',?)",
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

export async function createTurnFixture(
  cleanup: Cleanup[],
  runtime?: { database: AppDatabase; databaseUrl: string; valkeyUrl?: string },
) {
  const directory = await mkdtemp(join(tmpdir(), 'walden-real-turn-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const local = runtime ? undefined : openSqliteDatabase(join(directory, 'app.sqlite'));
  const db = runtime?.database ?? local!;
  if (local) {
    cleanup.push(() => local.close());
    await applySqliteMigrations(local, new URL('../../../migrations/', import.meta.url));
  }
  const provider = await compatibleProvider(cleanup);
  const env = { DB: db, ...provider.env } as Bindings;
  const execution = await createNodeExecutionHost({
    database: db,
    dataDir: directory,
    databaseUrl: runtime?.databaseUrl,
    valkeyUrl: runtime?.valkeyUrl,
  });
  cleanup.push(() => execution.close());
  await seedTurn(db);
  const router = createNodeTurnRouter(env, execution.host, { execute: true, pollMs: 5 });
  cleanup.push(() => router.close());
  env.TURNS = router.router;
  return {
    db,
    env,
    directory,
    execution,
    router,
    setMode: provider.setMode,
    calls: provider.calls,
  };
}

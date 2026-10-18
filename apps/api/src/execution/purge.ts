import { syncRetentionPolicies } from '../chat/conversations/retention';
import type { AppDatabase } from '../db/database';
import type { Bindings } from '../types';
import type { NativeExecutionHost } from './native-agent';

export type NativeRunDescriptor = {
  version: 1;
  runId: string;
  ownerId: string;
  conversationId: string;
  branchId: string;
  deadlineAt: number;
  replayUntil?: number;
};
const RETENTION_MS = 60 * 60_000;
const INDEX_PREFIX = 'native-run:';
const CURSOR_KEY = 'native-sweep:node';

/** Independent of account/turn foreign keys, so deletion cleanup survives a restart. */
export async function trackNativeRun(
  db: AppDatabase,
  descriptor: Omit<NativeRunDescriptor, 'version'> & { version?: 1 },
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    )
    .bind(`${INDEX_PREFIX}${descriptor.runId}`, JSON.stringify({ ...descriptor, version: 1 }))
    .run();
}

export async function finishNativeRun(
  db: AppDatabase,
  runId: string,
  replayUntil: number,
): Promise<void> {
  const key = `${INDEX_PREFIX}${runId}`;
  const row = await db
    .prepare('SELECT value FROM app_settings WHERE key=?')
    .bind(key)
    .first<{ value: string }>();
  if (!row) return;
  const descriptor = parseDescriptor(key, row.value);
  await db
    .prepare('UPDATE app_settings SET value=? WHERE key=? AND value=?')
    .bind(JSON.stringify({ ...descriptor, replayUntil }), key, row.value)
    .run();
}

/** Clear native transport/cache copies through Mastra's public replay API. */
export async function purgeNativeReplay(host: NativeExecutionHost, runId: string): Promise<void> {
  const workflows = await host.storage.getStore('workflows');
  if ((await workflows?.getRunOwnership({ runId }))?.live)
    throw new Error('Native run is still owned');
  // Keep framework initialization inside a Worker event's CPU budget.
  const { CachingPubSub, EventEmitterPubSub } = await import('@mastra/core/events');
  const { AGENT_CONTROL_TOPIC, AGENT_STREAM_TOPIC, DurableStepIds } = await import(
    '@mastra/core/agent/durable'
  );
  const local = host.pubsub ? undefined : new EventEmitterPubSub();
  const inner = host.pubsub ?? local!;
  const replay = inner instanceof CachingPubSub ? inner : new CachingPubSub(inner, host.cache);
  try {
    for (const topic of [AGENT_STREAM_TOPIC(runId), AGENT_CONTROL_TOPIC(runId)]) {
      await replay.clearTopic(topic);
      // clearTopic logs and swallows errors in Mastra 1.78. Verify the cache and
      // await the raw transport too, so a failed purge keeps its durable index.
      await replay.getInner().clearTopic(topic);
      if ((await replay.getHistory(topic)).length)
        throw new Error('Native replay cleanup did not finish');
    }
    await host.cache.delete(`walden:turn:${runId}:closures:v1`);
    for (const workflowName of [DurableStepIds.AGENTIC_LOOP, DurableStepIds.AGENTIC_EXECUTION]) {
      await workflows?.deleteWorkflowRunById({ runId, workflowName });
    }
  } finally {
    await local?.close();
  }
}

function parseDescriptor(key: string, value: string): NativeRunDescriptor {
  const item = JSON.parse(value) as Partial<NativeRunDescriptor>;
  if (
    item.version !== 1 ||
    typeof item.runId !== 'string' ||
    key !== `${INDEX_PREFIX}${item.runId}` ||
    typeof item.ownerId !== 'string' ||
    typeof item.conversationId !== 'string' ||
    typeof item.branchId !== 'string' ||
    typeof item.deadlineAt !== 'number' ||
    !Number.isFinite(item.deadlineAt) ||
    (item.replayUntil !== undefined &&
      (typeof item.replayUntil !== 'number' || !Number.isFinite(item.replayUntil)))
  ) {
    throw new Error('Invalid native run cleanup descriptor');
  }
  return item as NativeRunDescriptor;
}

async function privacyDeleted(db: AppDatabase, item: NativeRunDescriptor): Promise<boolean> {
  const owner = await db
    .prepare('SELECT deletion_pending FROM users WHERE id=?')
    .bind(item.ownerId)
    .first<{ deletion_pending: number }>();
  if (!owner || Number(owner.deletion_pending) !== 0) return true;
  const conversation = await db
    .prepare(
      'SELECT status,expires_at,retention_disabled FROM conversations WHERE id=? AND owner_id=?',
    )
    .bind(item.conversationId, item.ownerId)
    .first<{ status: string; expires_at: string; retention_disabled: number }>();
  if (
    !conversation ||
    conversation.status !== 'active' ||
    (conversation.retention_disabled !== 1 && Date.parse(conversation.expires_at) <= Date.now())
  )
    return true;
  const branch = await db
    .prepare(
      'SELECT status FROM conversation_branches WHERE id=? AND conversation_id=? AND owner_id=?',
    )
    .bind(item.branchId, item.conversationId, item.ownerId)
    .first<{ status: string }>();
  return !branch || branch.status !== 'active';
}

export type NativeRunIdentity = Pick<
  NativeRunDescriptor,
  'runId' | 'ownerId' | 'conversationId' | 'branchId'
>;

/** Use for direct deletion/retention hooks as well as the durable index sweeper. */
export async function purgeNativeRun(
  host: NativeExecutionHost,
  item: NativeRunIdentity,
  privacy: boolean,
): Promise<void> {
  await purgeNativeReplay(host, item.runId);
  await purgeThread(host, item, privacy);
}

async function purgeThread(
  host: NativeExecutionHost,
  item: NativeRunIdentity,
  privacy: boolean,
): Promise<void> {
  const threadId = `conversation:${item.ownerId}:${item.conversationId}:branch:${item.branchId}`;
  const resourceId = `user:${item.ownerId}`;
  // Mastra 1.78 thread-stream-runtime uses resourceId + NUL + threadId.
  // Retention trims only this run; privacy deletion removes the deleted thread.
  const topic = `agent.thread-stream.${encodeURIComponent(`${resourceId}\0${threadId}`)}`;
  if (privacy) await host.pubsub?.clearTopic(topic);
  else await host.pubsub?.trimTopic(topic, { runId: item.runId });
  if (!privacy) return;
  const domain = await host.storage.getStore('memory');
  if (!domain) return;
  const { Memory } = await import('@mastra/memory');
  const memory = new Memory({ storage: host.storage });
  try {
    await memory.deleteThread(threadId);
  } finally {
    await memory.settled();
  }
  // deleteThread cannot infer resourceId when an earlier attempt already removed
  // its thread row. Explicit cleanup also covers orphaned OM generations.
  if (domain.supportsObservationalMemory)
    await domain.clearObservationalMemory(threadId, resourceId);
}

async function sweepItem(
  db: AppDatabase,
  host: NativeExecutionHost,
  key: string,
  value: string,
): Promise<'purged' | 'deferred'> {
  const item = parseDescriptor(key, value);
  const privacy = await privacyDeleted(db, item);
  const turn = await db
    .prepare('SELECT status FROM turns WHERE id=?')
    .bind(item.runId)
    .first<{ status: string }>();
  if (!privacy && turn && Date.now() < (item.replayUntil ?? item.deadlineAt + RETENTION_MS))
    return 'deferred';
  const workflows = await host.storage.getStore('workflows');
  if ((await workflows?.getRunOwnership({ runId: item.runId }))?.live) return 'deferred';
  await purgeNativeRun(host, item, privacy);
  await db.prepare('DELETE FROM app_settings WHERE key=? AND value=?').bind(key, value).run();
  return 'purged';
}

/** Bounded, restart-safe cleanup with a persisted cursor so active prefixes cannot starve deletion. */
export async function sweepNativeRuns(db: AppDatabase, host: NativeExecutionHost, env?: Bindings) {
  if (env) await syncRetentionPolicies(env);
  const cursor = await db
    .prepare('SELECT value FROM app_settings WHERE key=?')
    .bind(CURSOR_KEY)
    .first<{ value: string }>();
  const page = (after: string) =>
    db
      .prepare(
        "SELECT key,value FROM app_settings WHERE key LIKE 'native-run:%' AND key>? ORDER BY key LIMIT 100",
      )
      .bind(after)
      .all<{ key: string; value: string }>();
  let rows = (await page(cursor?.value ?? '')).results;
  if (!rows.length && cursor?.value) rows = (await page('')).results;
  const result = { scanned: rows.length, purged: 0, deferred: 0, failed: 0 };
  for (const row of rows) {
    try {
      result[await sweepItem(db, host, row.key, row.value)]++;
    } catch {
      result.failed++;
    }
  }
  await db
    .prepare(
      'INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    )
    .bind(CURSOR_KEY, rows.at(-1)?.key ?? '')
    .run();
  return result;
}

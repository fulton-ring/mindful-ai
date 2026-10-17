import { deleteAgentMemoryThread } from '../agent/memory/memory';
import { turnObject } from '../chat/turns/turn-session';
import { loadTurn, recordTurnCancellation, type TurnRow } from '../chat/turns/turn-store';
import { HttpError } from '../http';
import type { Bindings } from '../types';
import { purgeNativeRun } from './purge';

async function purgeTurn(env: Bindings, row: TurnRow) {
  if (row.status === 'streaming') await recordTurnCancellation(env.DB, row);
  if (env.TURNS || env.CHAT_TURN) {
    const handle = turnObject(env, row.id);
    if (row.status === 'streaming') await handle.stop(row.id);
    await handle.purge?.(row.id);
  }
  if (env.EXECUTION) {
    const workflows = await env.EXECUTION.storage.getStore('workflows');
    const owner = await workflows?.getRunOwnership({ runId: row.id });
    if (owner?.live)
      throw new HttpError(503, 'Deletion is waiting for a running turn to stop. Please retry.');
    await purgeNativeRun(
      env.EXECUTION,
      {
        runId: row.id,
        ownerId: row.owner_id,
        conversationId: row.conversation_id,
        branchId: row.branch_id,
      },
      true,
    );
  }
}

/** Called before cascades, while turn and branch identities remain available. */
export async function purgeConversationExecution(
  env: Bindings,
  ownerId: string,
  conversationId: string,
) {
  const rows = (
    await env.DB.prepare('SELECT * FROM turns WHERE owner_id=? AND conversation_id=?')
      .bind(ownerId, conversationId)
      .all<TurnRow>()
  ).results;
  for (const row of rows) await purgeTurn(env, row);
  await deleteAgentMemoryThread(env.DB, ownerId, conversationId);
  for (const row of rows)
    await env.DB.prepare('DELETE FROM app_settings WHERE key=?').bind(`native-run:${row.id}`).run();
}

export async function purgeOwnerExecution(env: Bindings, ownerId: string) {
  const conversations = (
    await env.DB.prepare('SELECT id FROM conversations WHERE owner_id=?')
      .bind(ownerId)
      .all<{ id: string }>()
  ).results;
  for (const conversation of conversations)
    await purgeConversationExecution(env, ownerId, conversation.id);
}

/** Cloudflare's retained native state lives in per-turn SQLite objects. */
export async function sweepCloudflareExecutions(env: Bindings) {
  if (env.EXECUTION) return;
  const cursor =
    (
      await env.DB.prepare('SELECT value FROM app_settings WHERE key=?')
        .bind('native-sweep:cloudflare')
        .first<{ value: string }>()
    )?.value ?? '';
  const entries = (
    await env.DB.prepare(
      "SELECT key,value FROM app_settings WHERE key LIKE 'native-run:%' AND key>? ORDER BY key LIMIT 1000",
    )
      .bind(cursor)
      .all<{ key: string; value: string }>()
  ).results;
  for (const entry of entries) {
    const run = JSON.parse(entry.value) as {
      runId: string;
      ownerId: string;
      conversationId: string;
      branchId: string;
      deadlineAt: number;
      replayUntil?: number;
    };
    const live = await env.DB.prepare(
      "SELECT 1 FROM conversations c JOIN users u ON u.id=c.owner_id WHERE c.id=? AND c.owner_id=? AND c.status='active' AND c.expires_at>? AND u.deletion_pending=0",
    )
      .bind(run.conversationId, run.ownerId, new Date().toISOString())
      .first();
    const turn = await loadTurn(env.DB, run.runId);
    if (live && Date.now() < (run.replayUntil ?? run.deadlineAt + 60 * 60_000)) continue;
    if (turn) await purgeTurn(env, turn);
    else if (env.CHAT_TURN) await turnObject(env, run.runId).purge?.(run.runId);
    if (!live) await deleteAgentMemoryThread(env.DB, run.ownerId, run.conversationId, run.branchId);
    await env.DB.prepare('DELETE FROM app_settings WHERE key=?').bind(entry.key).run();
  }
  await env.DB.prepare(
    'INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  )
    .bind('native-sweep:cloudflare', entries.at(-1)?.key ?? '')
    .run();
}

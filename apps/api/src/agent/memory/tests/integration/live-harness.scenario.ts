import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERSONAS, type WaldenUIMessage } from '@walden/contracts';
import { describe, expect, it } from 'vitest';

import { createAgentService } from '../../../../services/agent/agent';
import type { AgentTurnInput } from '../../../../services/types';
import { sqliteD1Binding } from '../d1-test-binding';

const liveAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const liveToken = process.env.CLOUDFLARE_API_TOKEN;
const runLive = process.env.RUN_LIVE_OM === '1' && Boolean(liveAccountId && liveToken);

const TOPICS = ['tidal energy barrages', 'harbor dredging', 'estuary salinity monitoring'];
const CODENAMES = ['Juniper', 'Cobalt', 'Heron', 'Maple', 'Quartz', 'Willow'];

/** One exchange of about 560 tokens (Mastra's estimate) carrying a checkable fact. */
function exchange(i: number): WaldenUIMessage[] {
  const topic = TOPICS[i % TOPICS.length]!;
  const point = (n: number) =>
    `For ${topic}, point ${n}: weigh stakeholder access, maintenance cycles, permitting lead time, sediment behaviour, tidal range variation, monitoring cost, and contractor availability against the budget cap. Phase the work so early measurements inform later commitments. `;
  const at = (k: number) => new Date(Date.UTC(2026, 8, 1, 0, i * 2 + k)).toISOString();
  return [
    {
      id: `u${i}`,
      role: 'user',
      parts: [
        {
          type: 'text',
          text: `Session ${i}: I am planning ${topic}. The codename is Project ${CODENAMES[i % CODENAMES.length]} ${i} and the budget cap is ${(i + 3) * 17} thousand dollars. What should I weigh first?`,
        },
      ],
      metadata: { createdAt: at(0) },
    },
    {
      id: `a${i}`,
      role: 'assistant',
      // Trailing whitespace: the memory store trims it, which must not read as an edit.
      parts: [
        {
          type: 'text',
          text: `${Array.from({ length: 11 }, (_, n) => point(n + 1)).join('\n\n')}\n`,
        },
      ],
      metadata: { createdAt: at(1), status: 'complete' },
    },
  ];
}

function database() {
  const file = join(mkdtempSync(join(tmpdir(), 'walden-live-harness-')), 'db.sqlite');
  const migrations = new URL('../../../../../migrations/', import.meta.url);
  execFileSync('sqlite3', [file], {
    input: readdirSync(migrations)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => readFileSync(new URL(name, migrations), 'utf8'))
      .join('\n'),
  });
  return sqliteD1Binding(file);
}

async function turn(db: D1Database, exchanges: number) {
  const agent = createAgentService({
    DB: db,
    CLOUDFLARE_ACCOUNT_ID: liveAccountId,
    CLOUDFLARE_API_TOKEN: liveToken,
  });
  const input = {
    ownerId: 'owner',
    turnId: `turn-${exchanges}`,
    requestId: `request-${exchanges}`,
    conversation: {
      id: 'conversation',
      title: 'Live harness',
      noteId: null,
      messages: Array.from({ length: exchanges }, (_, i) => exchange(i)).flat(),
      expiresAt: '2999-01-01',
      learningChecksEnabled: false,
      webSearchEnabled: false,
      branchId: 'branch',
      branches: [],
    },
    note: null,
    persona: DEFAULT_PERSONAS[0]!,
    message: 'What was the codename and budget cap from session 0? One sentence.',
  } as unknown as AgentTurnInput;
  const started = Date.now();
  const statuses: string[] = [];
  let compacted = false;
  let text = '';
  for await (const chunk of await agent.streamTurn(input)) {
    if (chunk.type === 'data-status') statuses.push(chunk.data.text);
    if (chunk.type === 'message-metadata' && chunk.messageMetadata?.contextCompacted)
      compacted = true;
    if (chunk.type === 'text-delta') text += chunk.delta;
  }
  return { statuses, compacted, text, ms: Date.now() - started };
}

describe.skipIf(!runLive)('live conversation compaction through the turn harness', () => {
  it('compacts a long conversation once, keeps its facts, and does not redo it next turn', async () => {
    const db = database();
    await db.batch([
      db.prepare("INSERT INTO users VALUES ('owner','subject','now','now',0)"),
      db.prepare(
        "INSERT INTO conversations (id,owner_id,title,last_user_activity_at,expires_at,status,created_at) VALUES ('conversation','owner','Live harness','now','2999-01-01','active','now')",
      ),
      db.prepare(
        "INSERT INTO conversation_branches (id,conversation_id,owner_id,head_message_id,is_default,created_at) VALUES ('branch','conversation','owner',NULL,1,'now')",
      ),
    ]);

    // About 67k tokens: past the 48k threshold plus the 12k kept word for word.
    const first = await turn(db, 120);
    expect(first.statuses).toContain('Compacting conversation context…');
    expect(first.statuses).toContain('Context compacted. Thinking…');
    expect(first.compacted).toBe(true);
    expect(first.text).toMatch(/Juniper 0/);
    const record = await db
      .prepare(
        'SELECT activeObservations,observationTokenCount FROM agent_mastra_observational_memory',
      )
      .first<{ activeObservations: string; observationTokenCount: number }>();
    // The summary's wording varies run to run; the reply above is the real check.
    expect(record?.activeObservations).toMatch(/Juniper/);
    expect(record?.observationTokenCount).toBeGreaterThan(0);

    // Unchanged history must not be summarized again.
    const second = await turn(db, 120);
    expect(second.compacted).toBe(false);
    expect(second.statuses).not.toContain('Compacting conversation context…');
    expect(second.text).toMatch(/Juniper 0/);
    console.info('Live compaction timings (ms)', { compacting: first.ms, unchanged: second.ms });
  }, 240_000);
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModelV3CallOptions } from '@ai-sdk/provider';
import type { Conversation } from '@walden/contracts';
import { describe, expect, it } from 'vitest';

import { compactAgentMemory, prepareAgentMemory } from '../../memory';
import { sqliteD1Binding } from '../d1-test-binding';
import { scriptedModel } from './fixtures';

const exchange = (index: number) =>
  `Session ${index}: the budget cap for codename ${index} is ${index * 1000} dollars. `.repeat(90);

/** Twenty long messages: about 40k tokens, past the retained recent floor but under the threshold. */
function conversation(): Conversation {
  return {
    id: 'conversation',
    title: 'Budgets',
    noteId: null,
    expiresAt: '2999-01-01T00:00:00.000Z',
    learningChecksEnabled: false,
    webSearchEnabled: false,
    branchId: 'branch',
    branches: [],
    messages: Array.from({ length: 20 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 ? ('assistant' as const) : ('user' as const),
      parts: [{ type: 'text' as const, text: exchange(index) }],
      metadata: { createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString() },
    })),
  } as Conversation;
}

const binding = () =>
  sqliteD1Binding(join(mkdtempSync(join(tmpdir(), 'walden-compaction-')), 'memory.sqlite'));

describe('compacting conversation memory on request', () => {
  it('summarizes older messages below the automatic threshold and shrinks the next context', async () => {
    const db = binding();
    const calls: LanguageModelV3CallOptions[] = [];
    const model = scriptedModel(
      ['<observations>\n- Budget caps rise by 1000 dollars per session.\n</observations>'],
      calls,
    );
    const signal = new AbortController().signal;
    const before = await prepareAgentMemory(db, 'owner', conversation(), { model, signal });
    expect(calls).toHaveLength(0);
    expect(before.contextTokens).toBeGreaterThan(30_000);

    const result = await compactAgentMemory(db, 'owner', conversation(), { model, signal });
    expect(result.compacted).toBe(true);
    expect(result.summaryTokens).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);

    const after = await prepareAgentMemory(db, 'owner', conversation(), { model, signal });
    // What is left is the retained recent messages (about 12k tokens) and the summary.
    expect(after.contextTokens).toBeLessThan(before.contextTokens! - 10_000);
    expect(after.contextTokens).toBeLessThan(16_000);
  });

  it('condenses the summary around a requested focus', async () => {
    const db = binding();
    const calls: LanguageModelV3CallOptions[] = [];
    const model = scriptedModel(
      [
        '<observations>\n- Codename 2 budget is 2000 dollars.\n- Codename 4 budget is 4000 dollars.\n</observations>',
        '<observations>\n- Codename 4 budget is 4000 dollars.\n</observations>',
      ],
      calls,
    );
    const signal = new AbortController().signal;
    await prepareAgentMemory(db, 'owner', conversation(), { model, signal });
    const result = await compactAgentMemory(db, 'owner', conversation(), {
      model,
      signal,
      focus: 'Keep only codename 4',
    });
    expect(result.compacted).toBe(true);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1]?.prompt)).toContain('Keep only codename 4');
  });
});

describe('recalling summarized messages', () => {
  it('links summaries to their source messages, which the recall tool reads back', async () => {
    const db = binding();
    const signal = new AbortController().signal;
    const model = scriptedModel(
      ['<observations>\n- Budget caps rise by 1000 dollars per session.\n</observations>'],
      [],
    );
    await prepareAgentMemory(db, 'owner', conversation(), { model, signal });
    await compactAgentMemory(db, 'owner', conversation(), { model, signal });
    const record = await db
      .prepare('SELECT activeObservations FROM agent_mastra_observational_memory')
      .first<{ activeObservations: string }>();
    expect(record?.activeObservations).toMatch(/<observation-group [^>]*range="message-0:/);

    const prepared = await prepareAgentMemory(db, 'owner', conversation(), { model, signal });
    const recall = prepared.memory.listTools().recall as unknown as {
      execute(input: unknown, context: unknown): Promise<unknown>;
    };
    expect(recall).toBeDefined();
    const result = await recall.execute(
      { mode: 'messages', anchor: 'start', limit: 1, detail: 'low' },
      {
        agent: { threadId: prepared.threadId, resourceId: prepared.resourceId },
        memory: prepared.memory,
      },
    );
    expect(JSON.stringify(result)).toContain('codename 0');
  });
});

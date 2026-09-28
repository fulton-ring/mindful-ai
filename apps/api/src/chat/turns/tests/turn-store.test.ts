import type { Intervention, WaldenUIMessage, WaldenUIMessageChunk } from '@walden/contracts';
import { describe, expect, it } from 'vitest';
import { buildUIMessage } from '../../messages';
import { completeTurn, finishTurn, loadTurn, type TurnRow } from '../turn-store';
import { turnFixture } from './turn-fixture';

const text = (id: string, value: string): WaldenUIMessageChunk[] => [
  { type: 'text-start', id },
  { type: 'text-delta', id, delta: value },
  { type: 'text-end', id },
];
const check: Intervention = {
  id: 'check_1',
  kind: 'learning_check',
  questions: [{ id: 'q1', header: 'Q1', format: 'short_answer', question: 'Why?' }],
};
/** A reply exercising every persisted part kind. */
const reply: WaldenUIMessageChunk[] = [
  { type: 'start', messageId: 'turn', messageMetadata: { createdAt: 't0', personaName: 'Mentor' } },
  { type: 'data-turn', transient: true, data: { conversationId: 'c', branchId: 'b' } },
  { type: 'data-status', transient: true, data: { text: 'Thinking…' } },
  { type: 'start-step' },
  { type: 'reasoning-start', id: 'r' },
  { type: 'reasoning-delta', id: 'r', delta: 'Consider.' },
  { type: 'reasoning-end', id: 'r' },
  { type: 'finish-step' },
  {
    type: 'tool-input-available',
    toolCallId: 'call',
    toolName: 'searchWeb',
    input: { query: 'ice' },
  },
  { type: 'source-url', sourceId: 'call:0', url: 'https://example.com/ice', title: 'Ice' },
  {
    type: 'tool-output-available',
    toolCallId: 'call',
    output: { sources: [{ url: 'https://example.com/ice', title: 'Ice' }] },
  },
  { type: 'start-step' },
  ...text('t', 'Ice floats.'),
  { type: 'finish-step' },
  { type: 'data-intervention', id: check.id, data: check },
];

const turnRow = async (db: D1Database) => (await loadTurn(db, 'turn')) as TurnRow;
const stop = async (db: D1Database, chunks: WaldenUIMessageChunk[] = []) =>
  finishTurn(db, await turnRow(db), chunks, 'cancelled', 'Turn cancelled', 'cancelled');
const assistantRow = async (db: D1Database) => {
  const row = await db
    .prepare("SELECT ui_message FROM messages WHERE role='assistant'")
    .first<{ ui_message: string }>();
  return row && (JSON.parse(row.ui_message) as WaldenUIMessage);
};

describe('stored chunks replay into the persisted message', () => {
  it('rebuilds text, reasoning, a tool part, a source, and an intervention', async () => {
    // Stored as JSON, so compare the JSON shape.
    const message = JSON.parse(JSON.stringify(await buildUIMessage('turn', reply)));
    expect(message).toEqual({
      id: 'turn',
      role: 'assistant',
      metadata: { createdAt: 't0', personaName: 'Mentor' },
      parts: [
        { type: 'step-start' },
        { type: 'reasoning', id: 'r', text: 'Consider.', state: 'done' },
        {
          type: 'tool-searchWeb',
          toolCallId: 'call',
          state: 'output-available',
          input: { query: 'ice' },
          output: { sources: [{ url: 'https://example.com/ice', title: 'Ice' }] },
        },
        { type: 'source-url', sourceId: 'call:0', url: 'https://example.com/ice', title: 'Ice' },
        { type: 'step-start' },
        { type: 'text', text: 'Ice floats.', state: 'done' },
        { type: 'data-intervention', id: check.id, data: check },
      ],
    });
  });
});

describe('turn completion', () => {
  it('commits the streamed reply once, with its intervention, and ignores a late Stop', async () => {
    const db = await turnFixture();
    const row = await turnRow(db);
    const end = await completeTurn(db, row, reply);
    expect(await completeTurn(db, row, reply)).toBeNull();
    expect(await stop(db)).toBeNull();
    expect(await db.prepare('SELECT status,input_json FROM turns').first()).toEqual({
      status: 'completed',
      input_json: null,
    });
    const message = await assistantRow(db);
    expect(message?.metadata).toEqual({
      createdAt: 't0',
      personaName: 'Mentor',
      status: 'complete',
    });
    expect(message?.parts.map(({ type }) => type)).toEqual([
      'step-start',
      'reasoning',
      'tool-searchWeb',
      'source-url',
      'step-start',
      'text',
      'data-intervention',
    ]);
    expect(await db.prepare('SELECT id,kind,status FROM interventions').first()).toEqual({
      id: 'check_1',
      kind: 'learning_check',
      status: 'pending',
    });
    expect(await db.prepare('SELECT head_message_id FROM conversation_branches').first()).toEqual({
      head_message_id: 'turn',
    });
    expect(end).toEqual([
      {
        type: 'data-turn',
        transient: true,
        data: {
          conversationId: 'conversation',
          branchId: 'branch',
          userMessageId: 'user',
          title: 'Title',
          expiresAt: '2999-01-01',
        },
      },
      { type: 'finish', finishReason: 'stop', messageMetadata: { status: 'complete' } },
    ]);
  });

  it('drops the text of a reply that was only a quiz once it became a learning check', async () => {
    const db = await turnFixture();
    const question = 'Which way does ice move in water?\nA) It floats\nB) It sinks';
    const { standaloneLearningCheck } = await import('../../../agent/learning-checks');
    const quiz = standaloneLearningCheck(question, 'turn')!;
    const chunks: WaldenUIMessageChunk[] = [
      { type: 'start', messageId: 'turn', messageMetadata: { createdAt: 't0' } },
      ...text('t', question),
      { type: 'data-intervention', id: quiz.id, data: quiz },
    ];
    expect(await completeTurn(db, await turnRow(db), chunks)).not.toBeNull();
    expect((await assistantRow(db))?.parts.map(({ type }) => type)).toEqual(['data-intervention']);
  });
});

describe('turn Stop', () => {
  it('keeps partial parts as an interrupted reply and blocks a later completion', async () => {
    const db = await turnFixture();
    const row = await turnRow(db);
    const partial: WaldenUIMessageChunk[] = [
      { type: 'start', messageId: 'turn', messageMetadata: { createdAt: 't0' } },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'Partial' },
      { type: 'tool-input-available', toolCallId: 'call', toolName: 'readWebPage', input: {} },
    ];
    const end = await stop(db, partial);
    expect(await completeTurn(db, row, [...partial, ...text('late', 'Too late')])).toBeNull();
    expect(await db.prepare('SELECT status FROM turns').first()).toEqual({ status: 'cancelled' });
    expect(await assistantRow(db)).toEqual({
      id: 'turn',
      role: 'assistant',
      metadata: { createdAt: 't0', status: 'interrupted' },
      parts: [
        { type: 'text', text: 'Partial', state: 'done' },
        {
          type: 'tool-readWebPage',
          toolCallId: 'call',
          state: 'output-error',
          input: {},
          errorText: 'Stopped',
        },
      ],
    });
    expect(end).toEqual([
      {
        type: 'data-turn',
        transient: true,
        data: {
          conversationId: 'conversation',
          branchId: 'branch',
          userMessageId: 'user',
          failureCode: 'cancelled',
        },
      },
      { type: 'message-metadata', messageMetadata: { status: 'interrupted' } },
      { type: 'error', errorText: 'Turn cancelled' },
      { type: 'finish', finishReason: 'error', messageMetadata: { status: 'interrupted' } },
    ]);
  });

  it('opens a failed turn that never streamed with a start chunk', async () => {
    const db = await turnFixture();
    const chunks = (await stop(db))!;
    expect(chunks[0]).toMatchObject({ type: 'start', messageId: 'turn' });
    expect(chunks.at(-1)?.type).toBe('finish');
    expect((await assistantRow(db))?.parts).toEqual([]);
  });
});

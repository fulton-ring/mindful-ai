import type { Intervention, WaldenUIMessage, WaldenUIMessageChunk } from '@walden/contracts';
import { describe, expect, it } from 'vitest';
import { buildUIMessage } from '../../messages';
import {
  appendTurnChunks,
  beginTurnExecution,
  cancelTurn,
  completeTurn,
  readTurnChunks,
  restartTurnChunks,
} from '../durable-store';
import { turnFixture } from './turn-fixture';

const TURN = { id: 'turn', conversation_id: 'conversation', branch_id: 'branch' };
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

const stored = async (db: D1Database) =>
  (await readTurnChunks(db, 'turn')).map(({ chunk }) => chunk);
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

describe('durable turn progress', () => {
  it('starts each execution epoch from a reset and rejects writes from an obsolete one', async () => {
    const db = await turnFixture();
    const firstEpoch = (await beginTurnExecution(db, TURN))!;
    expect(firstEpoch).toBe(1);
    await appendTurnChunks(db, 'turn', firstEpoch, text('a', 'first'));
    expect(await stored(db)).toEqual(text('a', 'first'));

    const secondEpoch = (await beginTurnExecution(db, TURN))!;
    expect(secondEpoch).toBe(2);
    await appendTurnChunks(db, 'turn', firstEpoch, text('a', 'stale'));
    await appendTurnChunks(db, 'turn', secondEpoch, text('b', 'second'));

    expect(await stored(db)).toEqual([
      {
        type: 'data-turn',
        transient: true,
        data: { conversationId: 'conversation', branchId: 'branch', reset: true },
      },
      ...text('b', 'second'),
    ]);
  });

  it('rewinds a retried model call to the chunks written before it', async () => {
    const db = await turnFixture();
    const epoch = (await beginTurnExecution(db, TURN))!;
    await appendTurnChunks(db, 'turn', epoch, [{ type: 'start', messageId: 'turn' }]);
    await appendTurnChunks(db, 'turn', epoch, [
      { type: 'text-start', id: 'x' },
      { type: 'text-delta', id: 'x', delta: 'half' },
    ]);
    await restartTurnChunks(db, TURN, epoch, [{ type: 'start', messageId: 'turn' }]);
    await appendTurnChunks(db, 'turn', epoch, text('y', 'whole'));
    const chunks = await stored(db);
    expect(chunks.slice(1)).toEqual([{ type: 'start', messageId: 'turn' }, ...text('y', 'whole')]);
    expect(chunks[0]).toMatchObject({ type: 'data-turn', data: { reset: true } });
  });
});

describe('durable completion', () => {
  it('commits the streamed reply once, with its intervention, and ignores a late Stop', async () => {
    const db = await turnFixture();
    const epoch = (await beginTurnExecution(db, TURN))!;
    await appendTurnChunks(db, 'turn', epoch, reply);
    expect(await completeTurn(db, 'turn', epoch)).toBe(true);
    expect(await completeTurn(db, 'turn', epoch)).toBe(false);
    await cancelTurn(db, 'turn', 'owner');
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
    expect((await stored(db)).slice(-2)).toEqual([
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
    const epoch = (await beginTurnExecution(db, TURN))!;
    const question = 'Which way does ice move in water?\nA) It floats\nB) It sinks';
    const { standaloneLearningCheck } = await import('../../../agent/learning-checks');
    const quiz = standaloneLearningCheck(question, 'turn')!;
    await appendTurnChunks(db, 'turn', epoch, [
      { type: 'start', messageId: 'turn', messageMetadata: { createdAt: 't0' } },
      ...text('t', question),
      { type: 'data-intervention', id: quiz.id, data: quiz },
    ]);
    expect(await completeTurn(db, 'turn', epoch)).toBe(true);
    expect((await assistantRow(db))?.parts.map(({ type }) => type)).toEqual(['data-intervention']);
  });
});

describe('durable Stop', () => {
  it('keeps partial parts as an interrupted reply and blocks an obsolete executor', async () => {
    const db = await turnFixture();
    const epoch = (await beginTurnExecution(db, TURN))!;
    await appendTurnChunks(db, 'turn', epoch, [
      { type: 'start', messageId: 'turn', messageMetadata: { createdAt: 't0' } },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'Partial' },
      { type: 'tool-input-available', toolCallId: 'call', toolName: 'readWebPage', input: {} },
    ]);
    expect(await cancelTurn(db, 'turn', 'owner')).toBe(true);
    await appendTurnChunks(db, 'turn', epoch, text('late', 'Too late'));
    expect(await completeTurn(db, 'turn', epoch)).toBe(false);
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
    expect((await stored(db)).slice(-4)).toEqual([
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
    await cancelTurn(db, 'turn', 'owner');
    const chunks = await stored(db);
    expect(chunks[0]).toMatchObject({ type: 'start', messageId: 'turn' });
    expect(chunks.at(-1)?.type).toBe('finish');
    expect((await assistantRow(db))?.parts).toEqual([]);
  });
});

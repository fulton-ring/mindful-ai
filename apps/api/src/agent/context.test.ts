import { type MastraDBMessage, MessageList } from '@mastra/core/agent/message-list';
import type { ProcessInputStepArgs } from '@mastra/core/processors';
import type { Message, Note } from '@walden/contracts';
import { expect, it } from 'vitest';
import { buildTurnContext, contextBudgetProcessor } from './context';

const message = (id: string, role: Message['role'], content: string): Message => ({
  id,
  role,
  content,
  reasoning: `private reasoning for ${id}`,
  createdAt: '2026-09-18T12:00:00.000Z',
});

const note = (markdown: string): Note => ({
  id: 'note-1',
  title: 'Plan',
  markdown,
  revision: 4,
  provenance: [],
  createdAt: '2026-09-18T12:00:00.000Z',
  updatedAt: '2026-09-18T12:00:00.000Z',
});

it('delegates transcript loading to native memory without duplicating supplied history', () => {
  const result = buildTurnContext({
    note: note('Approved note'),
    messages: [message('old', 'user', 'history loaded by memory')],
    currentMessage: 'current question',
    requestId: 'current',
    dynamicContext: '',
    memoryManaged: true,
  });
  expect(result.messages.map((entry) => entry.id)).toEqual(['current']);
  expect(result.context[0]?.content).toContain('Approved note');
  expect(result.context[1]?.content).toContain('memory');
});

it('keeps the full note, newest complete turns, and current user message within a bound', () => {
  const result = buildTurnContext({
    note: note('FULL NOTE'),
    messages: [
      message('u1', 'user', `old ${'x'.repeat(80)}`),
      message('a1', 'assistant', `old answer ${'x'.repeat(80)}`),
      message('u2', 'user', 'new question'),
      message('a2', 'assistant', 'new answer'),
    ],
    currentMessage: 'current question verbatim',
    requestId: 'request-1',
    dynamicContext: 'Posture: consuming.',
    maxChars: 140,
    maxNoteChars: 100,
  });

  expect(result.context[0]?.content).toContain('revision 4');
  expect(result.context[0]?.content).toContain('FULL NOTE');
  expect(result.messages.at(-1)?.content).toBe('current question verbatim');
  expect(result.messages.map((item) => item.id)).toEqual(['u2', 'a2', 'request-1']);
  expect(JSON.stringify(result)).not.toContain('private reasoning');
  expect(result.context.map((item) => item.content).join('\n')).toContain(
    '2 earlier messages are unavailable',
  );
});

it('never includes half of an older turn when the whole turn does not fit', () => {
  const result = buildTurnContext({
    note: null,
    messages: [
      message('u1', 'user', 'older question'),
      message('a1', 'assistant', 'older answer'),
      message('u2', 'user', 'newest question'),
      message('a2', 'assistant', 'newest answer'),
    ],
    currentMessage: 'now',
    requestId: 'request-1',
    dynamicContext: 'Posture: consuming.',
    maxChars: 45,
    maxNoteChars: 100,
  });

  expect(result.messages.map((item) => item.id)).toEqual(['u2', 'a2', 'request-1']);
});

it('retains a recent user-only turn but ignores an orphan assistant message', () => {
  const result = buildTurnContext({
    note: null,
    messages: [
      message('orphan', 'assistant', 'orphaned answer'),
      message('u1', 'user', 'an interrupted request'),
    ],
    currentMessage: 'continue',
    requestId: 'request-1',
    dynamicContext: 'Posture: producing.',
    maxChars: 100,
    maxNoteChars: 100,
  });

  expect(result.messages.map((item) => item.id)).toEqual(['u1', 'request-1']);
});

it('marks interrupted assistant history without changing stored text or the current request', () => {
  const interrupted = { ...message('a1', 'assistant', 'The next step is'), incomplete: true };
  const result = buildTurnContext({
    note: null,
    messages: [message('u1', 'user', 'Explain the steps'), interrupted],
    currentMessage: 'Continue',
    requestId: 'request-2',
    dynamicContext: '',
  });
  expect(result.messages[1]?.content).toContain('[Interrupted response; not a completed answer]');
  expect(interrupted.content).toBe('The next step is');
  expect(result.messages.at(-1)?.content).toBe('Continue');
  expect(result.context.map((item) => item.content).join('\n')).not.toContain(
    'earlier messages are unavailable',
  );
});

it('supplies an outline for an oversized note and directs the model to read the needed text', () => {
  const result = buildTurnContext({
    note: note('n'.repeat(101)),
    messages: [],
    currentMessage: 'Edit the ending exactly.',
    requestId: 'request-1',
    dynamicContext: 'Posture: producing.',
    maxChars: 500,
    maxNoteChars: 100,
  });

  expect(result.context[0]?.content).toContain('Note outline');
  expect(result.context[0]?.content).toContain('readNote');
  expect(result.context[0]?.content).not.toContain('Exact note edits are unavailable');
  expect(JSON.stringify(result)).not.toContain('nnnnnnnnnn');
  expect(result.messages.at(-1)?.content).toBe('Edit the ending exactly.');
});

it('keeps the maximum application-bounded note and current request under the native guard', async () => {
  const context = buildTurnContext({
    note: note('n'.repeat(48_000)),
    messages: [
      message('history-user', 'user', 'u'.repeat(16_000)),
      message('history-assistant', 'assistant', 'a'.repeat(16_000)),
    ],
    currentMessage: 'q'.repeat(16_000),
    requestId: 'request-1',
    dynamicContext: 'Posture: producing.',
  });
  let generated = 0;
  const list = new MessageList({ generateMessageId: () => `context-${generated++}` })
    .addSystem('instructions')
    .add(context.context, 'context')
    .add(context.messages, 'user');

  await contextBudgetProcessor().processInputStep(processorArgs(list));

  const remaining = list.get.all.db();
  expect(remaining.some((item) => item.id === 'request-1')).toBe(true);
  expect(JSON.stringify(remaining)).toContain('nnnnnnnnnn');
});

it('lets the native limiter evict old supplied history while protecting the current request', async () => {
  const list = new MessageList().add(
    [
      {
        id: 'old-user',
        role: 'user',
        content: 'old history '.repeat(200),
        createdAt: new Date(),
        type: 'text',
      },
      {
        id: 'old-assistant',
        role: 'assistant',
        content: 'old answer '.repeat(200),
        createdAt: new Date(),
        type: 'text',
      },
      {
        id: 'current',
        role: 'user',
        content: 'current request',
        createdAt: new Date(),
        type: 'text',
      },
    ],
    'user',
  );
  await contextBudgetProcessor(100).processInputStep(processorArgs(list));
  const remaining = list.get.all.db();
  expect(remaining.some((item) => item.id === 'current')).toBe(true);
  expect(remaining.some((item) => item.id === 'old-user')).toBe(false);
});

it('aborts before a large tool result can displace required context or leave an orphan pair', async () => {
  // Explicit, ordered timestamps. With `new Date()` these three messages
  // landed in the same millisecond or not depending on machine load, which
  // left the trim order — and therefore which message survived — undefined.
  // That is what made this test fail only under the parallel workspace run.
  const contextAt = new Date('2026-09-19T00:00:00.000Z');
  const requestedAt = new Date('2026-09-19T00:00:01.000Z');
  const respondedAt = new Date('2026-09-19T00:00:02.000Z');
  let generated = 0;
  const list = new MessageList({ generateMessageId: () => `context-${generated++}` })
    // Required context that cannot fit the budget on its own. Trimming has no
    // way to satisfy the limit without dropping it, which is precisely when
    // the processor must abort rather than quietly answer without it.
    .add([{ role: 'user', content: 'x'.repeat(800), createdAt: contextAt }], 'context')
    .add(
      [
        {
          id: 'request-1',
          role: 'user',
          content: 'current request',
          createdAt: requestedAt,
          type: 'text',
        },
      ],
      'user',
    )
    .add(
      [
        {
          id: 'tool-result',
          role: 'assistant',
          createdAt: respondedAt,
          content: {
            format: 2,
            parts: [
              {
                type: 'tool-invocation',
                toolInvocation: {
                  state: 'result',
                  toolCallId: 'call-1',
                  toolName: 'lookup',
                  args: {},
                  result: 'x'.repeat(800),
                },
              },
            ],
          },
        } satisfies MastraDBMessage,
      ],
      'response',
    );

  await expect(contextBudgetProcessor(100).processInputStep(processorArgs(list))).rejects.toThrow(
    'Required note or current request exceeds the safe context budget.',
  );
});
function processorArgs(messageList: MessageList): ProcessInputStepArgs {
  return {
    messageList,
    messages: messageList.get.all.db(),
    systemMessages: messageList.getAllSystemMessages(),
    stepNumber: 0,
    steps: [],
    state: {},
    retryCount: 0,
    model: {} as ProcessInputStepArgs['model'],
    abort(reason) {
      throw new Error(reason);
    },
  };
}

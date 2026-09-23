import { describe, expect, it } from 'vitest';
import { batchIfAny, editContext, regenerationContext } from '../routes';

const message = (id: string, role: 'user' | 'assistant', content: string, incomplete = false) => ({
  id,
  role,
  content,
  incomplete,
  createdAt: '2026-01-01',
});

describe('assistant response regeneration', () => {
  it('does not call D1 batch when regeneration has no pre-stream statements', async () => {
    const db = {
      batch: () => {
        throw new Error('No SQL statements detected');
      },
    } as unknown as D1Database;

    await expect(batchIfAny(db, [])).resolves.toBeUndefined();
  });
});

describe('regeneration context', () => {
  it('uses any completed assistant and its preceding user prompt', () => {
    const messages = [
      message('u1', 'user', 'Earlier'),
      message('a1', 'assistant', 'Earlier answer'),
      message('u2', 'user', 'Try this again'),
      message('a2', 'assistant', 'Original answer'),
    ];
    expect(regenerationContext(messages, 'a2')).toEqual({
      assistant: messages[3],
      user: messages[2],
      history: messages.slice(0, 2),
    });
    expect(regenerationContext(messages, 'a1')).toEqual({
      assistant: messages[1],
      user: messages[0],
      history: [],
    });
    expect(
      regenerationContext([...messages.slice(0, 3), message('a2', 'assistant', '', true)], 'a2'),
    ).toBeNull();
  });

  it('forks an edited user prompt before the original prompt', () => {
    const messages = [
      message('u1', 'user', 'Earlier'),
      message('a1', 'assistant', 'Earlier answer'),
      message('u2', 'user', 'Broken prompt'),
      message('a2', 'assistant', '', true),
    ];
    expect(editContext(messages, 'u2')).toEqual({
      user: messages[2],
      history: messages.slice(0, 2),
      replacedAssistant: messages[3],
    });
    expect(editContext(messages, 'a2')).toBeNull();
  });
});

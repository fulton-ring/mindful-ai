import type { MessageBudget } from '@walden/contracts';
import { describe, expect, it } from 'vitest';
import { messageLimitNotice } from '../message-limit-notice';

const now = Date.parse('2026-09-28T12:00:00Z');
const budget = (used: number): MessageBudget => ({
  used,
  limit: 20,
  windowHours: 4,
  resetsAt: '2026-09-28T14:00:00Z',
});
const glm = { name: 'Mentor', model: '@cf/zai-org/glm-5.3-flash' as const };
const qwen = { name: 'Deep thinker', model: '@cf/qwen/qwen3.8-27b' as const };

describe('message limit notice', () => {
  it('appears once the budget is used up, but not while a reply is still coming in', () => {
    expect(messageLimitNotice(budget(20), glm, false, now)).toMatch(/reached your message limit/);
    expect(messageLimitNotice(budget(20), glm, true, now)).toBeNull();
  });

  it('asks for another persona when what is left cannot pay for this model', () => {
    expect(messageLimitNotice(budget(19), glm, false, now)).toBeNull();
    expect(messageLimitNotice(budget(19), qwen, false, now)).toMatch(
      /Not enough messages left for Deep thinker/,
    );
  });

  it('clears once the window has reset, and before any budget is known', () => {
    expect(
      messageLimitNotice(budget(20), glm, false, Date.parse('2026-09-28T14:00:01Z')),
    ).toBeNull();
    expect(messageLimitNotice(null, glm, false, now)).toBeNull();
  });
});

it('never blocks an explicitly unlimited message budget', () => {
  expect(
    messageLimitNotice(
      {
        used: 1000,
        limit: null,
        windowHours: 4,
        resetsAt: new Date(Date.now() + 60_000).toISOString(),
      },
      undefined,
      false,
    ),
  ).toBeNull();
});

it('explains an account with no message allowance before its first window exists', () => {
  expect(
    messageLimitNotice({ used: 0, limit: 0, windowHours: 4, resetsAt: null }, undefined, false),
  ).toBe('Messages are disabled for this account.');
});

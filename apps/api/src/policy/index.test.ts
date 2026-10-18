import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../http';
import { getAccountPolicy, validatePolicyConfig } from './index';

const defaults = {
  messages: { limit: 20, windowHours: 4 },
  uploads: { maxBytes: 1_000_000, maxFiles: 5 },
  retention: { idleDays: 7 },
  features: { mcp: true, documentExtraction: true, webResearch: true, webSearch: true },
};

describe('account policy resolution', () => {
  it('provides the existing self-host defaults without any provider', async () => {
    expect(await getAccountPolicy({}, 'owner-a')).toEqual({ planId: 'default', policy: defaults });
    expect(() => validatePolicyConfig({})).not.toThrow();
  });

  it('deeply merges legacy defaults, operator defaults, then the selected partial plan', async () => {
    const env = {
      MESSAGE_LIMIT: '8',
      MESSAGE_WINDOW_HOURS: '2',
      APP_POLICY_JSON: JSON.stringify({ messages: { limit: 12 }, uploads: { maxFiles: 2 } }),
      APP_PLANS_JSON: JSON.stringify({
        team: { messages: { windowHours: 6 }, features: { mcp: false } },
      }),
      APP_DEFAULT_PLAN: 'team',
    };
    expect(await getAccountPolicy(env, 'owner-a')).toEqual({
      planId: 'team',
      policy: {
        ...defaults,
        messages: { limit: 12, windowHours: 6 },
        uploads: { maxBytes: 1_000_000, maxFiles: 2 },
        features: { ...defaults.features, mcp: false },
      },
    });
  });

  it('accepts explicit unlimited legacy limits and nullable size/count/retention overrides', async () => {
    const env = {
      MESSAGE_LIMIT: 'unlimited',
      APP_POLICY_JSON: JSON.stringify({
        uploads: { maxBytes: null, maxFiles: null },
        retention: { idleDays: null },
      }),
    };
    expect((await getAccountPolicy(env, 'owner-a')).policy).toEqual({
      ...defaults,
      messages: { ...defaults.messages, limit: null },
      uploads: { maxBytes: null, maxFiles: null },
      retention: { idleDays: null },
    });
  });

  it('uses operator assignments before a provider, then provider before the configured default', async () => {
    const getPlan = vi.fn().mockResolvedValue('team');
    const env = {
      APP_PLANS_JSON: JSON.stringify({
        team: { messages: { limit: 100 } },
        operator: { messages: { limit: 200 } },
      }),
      APP_ACCOUNT_PLANS_JSON: JSON.stringify({ 'owner-a': 'operator' }),
      ENTITLEMENTS: { getPlan },
    };
    expect((await getAccountPolicy(env, 'owner-a')).planId).toBe('operator');
    expect(getPlan).not.toHaveBeenCalled();
    expect((await getAccountPolicy(env, 'owner-b')).planId).toBe('team');
    expect(getPlan).toHaveBeenCalledWith('owner-b');
    getPlan.mockResolvedValueOnce(null);
    expect((await getAccountPolicy(env, 'owner-c')).planId).toBe('default');
  });

  it('keeps each plan based on the global defaults rather than inheriting the selected default plan', async () => {
    const env = {
      APP_DEFAULT_PLAN: 'team',
      APP_PLANS_JSON: JSON.stringify({
        team: { messages: { limit: 100 } },
        small: { uploads: { maxFiles: 1 } },
      }),
      APP_ACCOUNT_PLANS_JSON: JSON.stringify({ 'owner-a': 'small' }),
    };
    expect((await getAccountPolicy(env, 'owner-a')).policy.messages.limit).toBe(20);
  });
});

describe('policy value boundaries and isolation', () => {
  it('supports disabled quotas and finite fractional windows/retention', async () => {
    const policy = {
      ...defaults,
      messages: { limit: 0, windowHours: 0.5 },
      uploads: { maxBytes: 0, maxFiles: 0 },
      retention: { idleDays: 0.5 },
    };
    expect(
      (await getAccountPolicy({ APP_POLICY_JSON: JSON.stringify(policy) }, 'owner-a')).policy,
    ).toEqual(policy);
  });

  it('allows a configured override of the implicit default plan', async () => {
    const env = { APP_PLANS_JSON: JSON.stringify({ default: { messages: { limit: null } } }) };
    expect((await getAccountPolicy(env, 'owner-a')).policy.messages.limit).toBeNull();
  });

  it('does not treat inherited object properties as configured plans or account assignments', async () => {
    const getPlan = vi.fn().mockResolvedValue('toString');
    await expect(
      getAccountPolicy({ ENTITLEMENTS: { getPlan } }, 'constructor'),
    ).rejects.toMatchObject({ status: 503 });
    const env = {
      APP_PLANS_JSON: '{"__proto__":{"messages":{"limit":123}}}',
      APP_ACCOUNT_PLANS_JSON: '{"constructor":"__proto__"}',
    };
    expect((await getAccountPolicy(env, 'constructor')).policy.messages.limit).toBe(123);
    expect((await getAccountPolicy(env, 'other-owner')).planId).toBe('default');
  });

  it('returns independent account policies without mutating shared defaults', async () => {
    const first = await getAccountPolicy({}, 'owner-a');
    first.policy.features.mcp = false;
    first.policy.messages.limit = 1;
    expect(await getAccountPolicy({}, 'owner-b')).toEqual({ planId: 'default', policy: defaults });
  });
});

describe('policy configuration fails closed', () => {
  it.each([
    { APP_POLICY_JSON: '{"secret":"do-not-expose"' },
    { APP_POLICY_JSON: JSON.stringify({ messages: { limit: -1 } }) },
    { APP_POLICY_JSON: JSON.stringify({ messages: { limit: 1.5 } }) },
    { APP_POLICY_JSON: JSON.stringify({ uploads: { maxBytes: Number.MAX_SAFE_INTEGER + 1 } }) },
    { APP_POLICY_JSON: JSON.stringify({ retention: { idleDays: 0 } }) },
    { APP_POLICY_JSON: JSON.stringify({ features: { mcp: 'false' } }) },
    { APP_POLICY_JSON: JSON.stringify({ uploads: { unexpected: 1 } }) },
    { APP_POLICY_JSON: JSON.stringify({ unknown: true }) },
    { APP_PLANS_JSON: JSON.stringify({ broken: { retention: { idleDays: -1 } } }) },
    { APP_PLANS_JSON: '[]' },
    { APP_PLANS_JSON: '{"plan":null}' },
    { APP_PLANS_JSON: '{" ":{}}' },
    { APP_DEFAULT_PLAN: 'unknown' },
    { APP_ACCOUNT_PLANS_JSON: JSON.stringify({ 'owner-a': 'unknown' }) },
    { APP_ACCOUNT_PLANS_JSON: JSON.stringify({ 'owner-a': 4 }) },
    { APP_ACCOUNT_PLANS_JSON: 'null' },
    { MESSAGE_LIMIT: '' },
    { MESSAGE_LIMIT: 'bad' },
    { MESSAGE_WINDOW_HOURS: '-1' },
  ])('rejects invalid configuration before resolving any account: %j', async (env) => {
    expect(() => validatePolicyConfig(env)).toThrow(HttpError);
    await expect(getAccountPolicy(env, 'owner-a')).rejects.toMatchObject({ status: 503 });
    try {
      validatePolicyConfig(env);
    } catch (error) {
      expect(String(error)).not.toContain('do-not-expose');
    }
  });

  it('rejects unknown provider plans and provider failures without exposing provider details', async () => {
    const getPlan = vi.fn().mockResolvedValue('unknown');
    await expect(getAccountPolicy({ ENTITLEMENTS: { getPlan } }, 'owner-a')).rejects.toMatchObject({
      status: 503,
    });
    getPlan.mockRejectedValueOnce(new Error('private-provider-token'));
    await expect(getAccountPolicy({ ENTITLEMENTS: { getPlan } }, 'owner-a')).rejects.toMatchObject({
      status: 503,
    });
    getPlan.mockRejectedValueOnce(new Error('private-provider-token'));
    await expect(getAccountPolicy({ ENTITLEMENTS: { getPlan } }, 'owner-a')).rejects.not.toThrow(
      'private-provider-token',
    );
  });

  it('does not call entitlement providers when any configured plan is malformed', async () => {
    const getPlan = vi.fn().mockResolvedValue(null);
    await expect(
      getAccountPolicy(
        { APP_PLANS_JSON: '{"unused":{"messages":{"limit":-1}}}', ENTITLEMENTS: { getPlan } },
        'owner-a',
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(getPlan).not.toHaveBeenCalled();
  });
});

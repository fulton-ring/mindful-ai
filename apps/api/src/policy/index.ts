import {
  type AccountPolicy,
  type AppPolicy,
  appPolicySchema,
  DEFAULT_APP_POLICY,
} from '@walden/contracts';
import { z } from 'zod';
import { HttpError } from '../http';
import type { Bindings } from '../types';

export interface EntitlementsProvider {
  getPlan(ownerId: string): Promise<string | null>;
}

type PolicyEnvironment = Pick<
  Bindings,
  | 'APP_POLICY_JSON'
  | 'APP_PLANS_JSON'
  | 'APP_DEFAULT_PLAN'
  | 'APP_ACCOUNT_PLANS_JSON'
  | 'MESSAGE_LIMIT'
  | 'MESSAGE_WINDOW_HOURS'
  | 'ENTITLEMENTS'
>;

const partialPolicySchema = z
  .object({
    messages: appPolicySchema.shape.messages.partial(),
    uploads: appPolicySchema.shape.uploads.partial(),
    retention: appPolicySchema.shape.retention.partial(),
    features: appPolicySchema.shape.features.partial(),
  })
  .partial()
  .strict();
type PartialPolicy = z.infer<typeof partialPolicySchema>;
const planIdSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value);

export type PolicyConfig = {
  defaultPlanId: string;
  plans: ReadonlyMap<string, AppPolicy>;
  accountPlans: ReadonlyMap<string, string>;
};

function invalid(name: string): never {
  throw new HttpError(503, `Invalid ${name}. Check the account policy configuration.`);
}

function objectJson(value: string | undefined, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    invalid(name);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid(name);
  return parsed as Record<string, unknown>;
}

function mergePolicy(base: AppPolicy, partial: PartialPolicy, name: string): AppPolicy {
  const result = appPolicySchema.safeParse({
    messages: { ...base.messages, ...partial.messages },
    uploads: { ...base.uploads, ...partial.uploads },
    retention: { ...base.retention, ...partial.retention },
    features: { ...base.features, ...partial.features },
  });
  if (!result.success) invalid(name);
  return result.data;
}

function partialPolicy(value: unknown, name: string): PartialPolicy {
  const result = partialPolicySchema.safeParse(value);
  if (!result.success) invalid(name);
  return result.data;
}

function legacyDefaults(env: PolicyEnvironment): AppPolicy {
  const limit = env.MESSAGE_LIMIT;
  const hours = env.MESSAGE_WINDOW_HOURS;
  if (limit !== undefined && !limit.trim()) invalid('MESSAGE_LIMIT');
  if (hours !== undefined && !hours.trim()) invalid('MESSAGE_WINDOW_HOURS');
  const messages = {
    limit:
      limit === undefined
        ? DEFAULT_APP_POLICY.messages.limit
        : limit.trim() === 'unlimited'
          ? null
          : Number(limit),
    windowHours: hours === undefined ? DEFAULT_APP_POLICY.messages.windowHours : Number(hours),
  };
  const result = appPolicySchema.shape.messages.safeParse(messages);
  if (!result.success) invalid('MESSAGE_LIMIT or MESSAGE_WINDOW_HOURS');
  return mergePolicy(DEFAULT_APP_POLICY, { messages: result.data }, 'message policy');
}

/** Validates every configured plan and assignment before any entitlement lookup. */
export function validatePolicyConfig(env: PolicyEnvironment): PolicyConfig {
  const defaults = mergePolicy(
    legacyDefaults(env),
    partialPolicy(objectJson(env.APP_POLICY_JSON, 'APP_POLICY_JSON'), 'APP_POLICY_JSON'),
    'APP_POLICY_JSON',
  );
  const plans = new Map<string, AppPolicy>([['default', defaults]]);
  for (const [id, value] of Object.entries(objectJson(env.APP_PLANS_JSON, 'APP_PLANS_JSON'))) {
    if (!planIdSchema.safeParse(id).success) invalid('APP_PLANS_JSON plan ID');
    plans.set(id, mergePolicy(defaults, partialPolicy(value, 'APP_PLANS_JSON'), 'APP_PLANS_JSON'));
  }
  const defaultPlanId = env.APP_DEFAULT_PLAN ?? 'default';
  if (!plans.has(defaultPlanId)) invalid('APP_DEFAULT_PLAN');
  const accountPlans = new Map<string, string>();
  for (const [ownerId, id] of Object.entries(
    objectJson(env.APP_ACCOUNT_PLANS_JSON, 'APP_ACCOUNT_PLANS_JSON'),
  )) {
    if (!ownerId || typeof id !== 'string' || !plans.has(id)) invalid('APP_ACCOUNT_PLANS_JSON');
    accountPlans.set(ownerId, id);
  }
  return { defaultPlanId, plans, accountPlans };
}

async function providerPlan(env: PolicyEnvironment, ownerId: string): Promise<string | null> {
  if (!env.ENTITLEMENTS) return null;
  try {
    const id = await env.ENTITLEMENTS.getPlan(ownerId);
    if (id !== null && !planIdSchema.safeParse(id).success) throw new Error('Invalid plan ID');
    return id;
  } catch {
    throw new HttpError(
      503,
      'Account entitlements are unavailable. Check the entitlement provider.',
    );
  }
}

/** Operator assignments override the optional provider, followed by the configured default. */
export async function getAccountPolicy(
  env: PolicyEnvironment,
  ownerId: string,
): Promise<AccountPolicy> {
  const config = validatePolicyConfig(env);
  const planId =
    config.accountPlans.get(ownerId) ?? (await providerPlan(env, ownerId)) ?? config.defaultPlanId;
  const policy = config.plans.get(planId);
  if (!policy)
    throw new HttpError(
      503,
      'Account policy references an unknown plan. Check configured plans and entitlements.',
    );
  return { planId, policy };
}

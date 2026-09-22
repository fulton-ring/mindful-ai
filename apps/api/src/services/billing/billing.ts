import type { Usage } from '@walden/contracts';
import type { ServiceEnv, StoredUsage } from '../types';

export class ServiceUnavailableError extends Error {
  readonly status = 503;
}
export type EntitlementUpdate = {
  eventId: string;
  customerId: string;
  subscriptionId?: string;
  plan: 'free' | 'personal';
  active: boolean;
  periodEnd?: string;
};

function requireStripe(env: ServiceEnv): string {
  if (!env.STRIPE_SECRET_KEY) throw new ServiceUnavailableError('Billing is not configured.');
  return env.STRIPE_SECRET_KEY;
}
async function stripePost(env: ServiceEnv, path: string, body: URLSearchParams) {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requireStripe(env)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const result = (await response.json()) as { url?: string; error?: { message?: string } };
  if (!response.ok) throw new Error(result.error?.message ?? 'Stripe request failed.');
  return result;
}
export async function createCheckoutSession(
  env: ServiceEnv,
  input: { userId: string; customerId?: string; email?: string },
): Promise<{ url: string }> {
  if (!env.STRIPE_PRICE_ID || !env.APP_URL)
    throw new ServiceUnavailableError('Billing is not configured.');
  const body = new URLSearchParams({
    mode: 'subscription',
    'line_items[0][price]': env.STRIPE_PRICE_ID,
    'line_items[0][quantity]': '1',
    success_url: `${env.APP_URL}/settings?billing=success`,
    cancel_url: `${env.APP_URL}/settings?billing=cancelled`,
    client_reference_id: input.userId,
    'metadata[userId]': input.userId,
  });
  if (input.customerId) body.set('customer', input.customerId);
  else if (input.email) body.set('customer_email', input.email);
  const result = await stripePost(env, 'checkout/sessions', body);
  if (!result.url) throw new Error('Stripe returned no checkout URL.');
  return { url: result.url };
}
export async function createPortalSession(
  env: ServiceEnv,
  customerId: string,
): Promise<{ url: string }> {
  if (!env.APP_URL) throw new ServiceUnavailableError('Billing is not configured.');
  const result = await stripePost(
    env,
    'billing_portal/sessions',
    new URLSearchParams({ customer: customerId, return_url: `${env.APP_URL}/settings` }),
  );
  if (!result.url) throw new Error('Stripe returned no portal URL.');
  return { url: result.url };
}

function bytes(value: string): ArrayBuffer {
  return new TextEncoder().encode(value).slice().buffer as ArrayBuffer;
}
function hex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let value = 0;
  for (let i = 0; i < a.length; i++) value |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return value === 0;
}
export async function verifyStripeWebhook(
  rawBody: string,
  signature: string | null,
  secret?: string,
  toleranceSeconds = 300,
): Promise<Record<string, unknown>> {
  if (!secret) throw new ServiceUnavailableError('Stripe webhook is not configured.');
  const parts = (signature ?? '').split(',').map((part) => part.split('=', 2) as [string, string]);
  const timestamp = Number(parts.find(([key]) => key === 't')?.[1]);
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (
    !timestamp ||
    signatures.length === 0 ||
    Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds
  )
    throw new Error('Invalid Stripe webhook signature.');
  const key = await crypto.subtle.importKey(
    'raw',
    bytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expected = hex(await crypto.subtle.sign('HMAC', key, bytes(`${timestamp}.${rawBody}`)));
  if (!signatures.some((candidate) => safeEqual(expected, candidate)))
    throw new Error('Invalid Stripe webhook signature.');
  return JSON.parse(rawBody) as Record<string, unknown>;
}

export function stripeEventObject(event: Record<string, unknown>): Record<string, unknown> | null {
  const data = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const object = (data as Record<string, unknown>).object;
  return object && typeof object === 'object' && !Array.isArray(object)
    ? (object as Record<string, unknown>)
    : null;
}

export function eventToEntitlement(event: Record<string, unknown>): EntitlementUpdate | undefined {
  const object = stripeEventObject(event);
  if (!object || typeof event.id !== 'string') return undefined;
  if (event.type === 'checkout.session.completed')
    return {
      eventId: event.id,
      customerId: String(object.customer),
      subscriptionId: object.subscription ? String(object.subscription) : undefined,
      plan: 'personal',
      active: object.payment_status !== 'unpaid',
    };
  if (
    event.type === 'customer.subscription.deleted' ||
    event.type === 'customer.subscription.updated'
  )
    return {
      eventId: event.id,
      customerId: String(object.customer),
      subscriptionId: String(object.id),
      plan: object.status === 'active' || object.status === 'trialing' ? 'personal' : 'free',
      active: object.status === 'active' || object.status === 'trialing',
      periodEnd:
        typeof object.current_period_end === 'number' && object.current_period_end > 0
          ? new Date(object.current_period_end * 1000).toISOString()
          : undefined,
    };
  return undefined;
}
export function createBillingService(env: ServiceEnv) {
  return {
    configured: Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_ID && env.STRIPE_WEBHOOK_SECRET),
    async usageFor(
      _userId: string,
      stored: StoredUsage,
      // Activity counts are not part of the billing period record; the usage
      // endpoint queries them directly and passes them through here.
      activity: Pick<Usage, 'messagesSent' | 'favoritePersona'> = {
        messagesSent: 0,
        favoritePersona: null,
      },
    ): Promise<Usage> {
      return {
        ...stored,
        ...activity,
        provider: env.AI ? 'cloudflare-workers-ai' : 'unconfigured',
        model: env.AI_MODEL ?? (env.AI ? '@cf/google/gemma-4-26b-a4b-it' : 'local'),
      };
    },
  };
}

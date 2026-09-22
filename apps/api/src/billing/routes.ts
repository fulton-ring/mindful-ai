import { Hono } from 'hono';
import { first } from '../db/client';
import { HttpError, nowIso } from '../http';
import {
  createCheckoutSession,
  createPortalSession,
  eventToEntitlement,
  stripeEventObject,
  verifyStripeWebhook,
} from '../services/billing/billing';
import type { Bindings, Variables } from '../types';

const requireBilling = (enabled: string | undefined) => {
  if (enabled !== 'true') throw new HttpError(404, 'Billing is not enabled');
};

export const billingRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();
billingRoutes.post('/checkout', async (c) => {
  requireBilling(c.env.BILLING_ENABLED);
  const customer = await first<{ customer_id: string }>(
    c.env.DB.prepare('SELECT customer_id FROM billing_customers WHERE owner_id=?').bind(
      c.get('userId'),
    ),
  );
  return c.json(
    await createCheckoutSession(c.env, {
      userId: c.get('userId'),
      customerId: customer?.customer_id,
    }),
  );
});
billingRoutes.post('/portal', async (c) => {
  requireBilling(c.env.BILLING_ENABLED);
  const customer = await first<{ customer_id: string }>(
    c.env.DB.prepare('SELECT customer_id FROM billing_customers WHERE owner_id=?').bind(
      c.get('userId'),
    ),
  );
  if (!customer) throw new HttpError(404, 'Billing customer not found');
  return c.json(await createPortalSession(c.env, customer.customer_id));
});

export const billingWebhookRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();
billingWebhookRoutes.post('/', async (c) => {
  requireBilling(c.env.BILLING_ENABLED);
  const rawBody = await c.req.text();
  let event: Record<string, unknown>;
  try {
    event = await verifyStripeWebhook(
      rawBody,
      c.req.header('stripe-signature') ?? null,
      c.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch {
    throw new HttpError(400, 'Invalid Stripe webhook');
  }
  const eventId = typeof event.id === 'string' ? event.id : '';
  if (!eventId) throw new HttpError(400, 'Invalid Stripe event');
  if (await first(c.env.DB.prepare('SELECT id FROM billing_events WHERE id=?').bind(eventId)))
    return c.json({ received: true });
  const update = eventToEntitlement(event);
  if (!update) {
    await c.env.DB.prepare('INSERT INTO billing_events (id,processed_at) VALUES (?,?)')
      .bind(eventId, nowIso())
      .run();
    return c.json({ received: true });
  }
  const object = stripeEventObject(event) ?? {};
  const ownerId =
    typeof object.client_reference_id === 'string'
      ? object.client_reference_id
      : (
          await first<{ owner_id: string }>(
            c.env.DB.prepare('SELECT owner_id FROM billing_customers WHERE customer_id=?').bind(
              update.customerId,
            ),
          )
        )?.owner_id;
  if (!ownerId) throw new HttpError(400, 'Billing event has no account mapping');
  const resetsAt =
    update.periodEnd ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO billing_customers (owner_id,customer_id,subscription_id,updated_at) VALUES (?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET customer_id=excluded.customer_id,subscription_id=excluded.subscription_id,updated_at=excluded.updated_at',
    ).bind(ownerId, update.customerId, update.subscriptionId ?? null, nowIso()),
    c.env.DB.prepare(
      'INSERT INTO usage_periods (owner_id,plan,used,unit_limit,resets_at,input_tokens,output_tokens) VALUES (?,?,0,?,?,0,0) ON CONFLICT(owner_id) DO UPDATE SET plan=excluded.plan,unit_limit=excluded.unit_limit,resets_at=excluded.resets_at',
    ).bind(ownerId, update.active ? update.plan : 'free', update.active ? 500 : 10, resetsAt),
    c.env.DB.prepare('INSERT INTO billing_events (id,processed_at) VALUES (?,?)').bind(
      eventId,
      nowIso(),
    ),
  ]);
  return c.json({ received: true });
});

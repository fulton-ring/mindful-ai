import { Hono } from 'hono';
import { accountRoutes } from './account';
import { authMiddleware } from './auth';
import { billingRoutes, billingWebhookRoutes } from './billing/routes';
import { capturePlacementRoutes } from './chat/capture-placement';
import { conversationRoutes, purgeExpiredConversations } from './chat/conversations';
import { followupRoutes } from './chat/followups';
import { highlightRoutes } from './chat/highlights';
import { chatRoutes } from './chat/routes';
import { HttpError } from './http';
import { metricsRoutes } from './metrics/routes';
import { notesRoutes } from './notes/routes';
import { personaRoutes } from './personas/routes';
import type { Bindings, Variables } from './types';

export const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
app.get('/api/config', (c) =>
  c.json({
    billingEnabled: c.env.BILLING_ENABLED === 'true',
    authConfigured: Boolean(c.env.CLERK_SECRET_KEY && c.env.CLERK_PUBLISHABLE_KEY),
    billingConfigured:
      c.env.BILLING_ENABLED === 'true' &&
      Boolean(c.env.STRIPE_SECRET_KEY && c.env.STRIPE_WEBHOOK_SECRET && c.env.STRIPE_PRICE_ID),
    modelConfigured: Boolean(
      c.env.AI || (c.env.CLOUDFLARE_ACCOUNT_ID && c.env.CLOUDFLARE_API_TOKEN),
    ),
    ...(c.env.CLERK_PUBLISHABLE_KEY ? { clerkPublishableKey: c.env.CLERK_PUBLISHABLE_KEY } : {}),
  }),
);
app.route('/api/billing/webhook', billingWebhookRoutes);
app.use('/api/*', authMiddleware);
app.route('/api/notes', notesRoutes);
app.route('/api', conversationRoutes);
app.route('/api', capturePlacementRoutes);
app.route('/api/chat', chatRoutes);
app.route('/api/chat', followupRoutes);
app.route('/api/chat', highlightRoutes);
app.route('/api/personas', personaRoutes);
app.route('/api', metricsRoutes);
app.route('/api', accountRoutes);
app.route('/api/billing', billingRoutes);
app.notFound((c) => c.json({ error: 'Not found' }, 404));
app.onError((error, c) => {
  if (error instanceof HttpError)
    return c.json(
      { error: error.message, ...(error.details === undefined ? {} : { details: error.details }) },
      error.status,
    );
  console.error('Request failed', { name: error.name, message: error.message });
  return c.json({ error: 'Internal server error' }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(purgeExpiredConversations(env.DB));
  },
};

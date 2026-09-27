import { Hono } from 'hono';
import { authMiddleware } from './auth';
import { capturePlacementRoutes } from './chat/capture/capture-placement';
import { conversationRoutes } from './chat/conversations/conversations';
import { purgeExpiredConversations } from './chat/conversations/deletion';
import { followupRoutes } from './chat/followups/followups';
import { highlightRoutes } from './chat/highlights/highlights';
import { chatRoutes } from './chat/turns/routes';
import { reconcileTurns } from './chat/turns/scheduling';
import { HttpError } from './http';
import { metricsRoutes } from './metrics/routes';
import { notesRoutes } from './notes/routes';
import { personaRoutes } from './personas/routes';
import { accountRoutes } from './privacy/account';
import { purgeTelemetry } from './privacy/content-telemetry';
import type { Bindings, Variables } from './types';

export const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
app.get('/api/config', (c) =>
  c.json({
    authConfigured: Boolean(c.env.CLERK_SECRET_KEY && c.env.CLERK_PUBLISHABLE_KEY),
    modelConfigured: Boolean(
      c.env.AI || (c.env.CLOUDFLARE_ACCOUNT_ID && c.env.CLOUDFLARE_API_TOKEN),
    ),
    ...(c.env.CLERK_PUBLISHABLE_KEY ? { clerkPublishableKey: c.env.CLERK_PUBLISHABLE_KEY } : {}),
    ...(c.env.POSTHOG_API_KEY?.startsWith('phc_')
      ? {
          telemetry: {
            key: c.env.POSTHOG_API_KEY,
            host: c.env.POSTHOG_HOST || 'https://us.i.posthog.com',
          },
        }
      : {}),
  }),
);
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
app.notFound((c) => c.json({ error: 'Not found' }, 404));
app.onError((error, c) => {
  if (error instanceof HttpError)
    return c.json(
      { error: error.message, ...(error.details === undefined ? {} : { details: error.details }) },
      error.status,
    );
  console.error('Request failed', { name: error.name, status: 500 });
  return c.json({ error: 'Internal server error' }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(reconcileTurns(env));
    if (controller.cron !== '17 * * * *') return;
    ctx.waitUntil(purgeExpiredConversations(env.DB, env.FILES));
    ctx.waitUntil(purgeTelemetry(env));
  },
};

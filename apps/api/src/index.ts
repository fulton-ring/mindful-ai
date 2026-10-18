import type { AppConfig } from '@walden/contracts';
import { Hono } from 'hono';
import { authMiddleware, getAccountIdentity, readAuthMode } from './auth';
import { mountAuthRoutes } from './auth/routes';
import { capturePlacementRoutes } from './chat/capture/capture-placement';
import { conversationRoutes } from './chat/conversations/conversations';
import { purgeExpiredConversations } from './chat/conversations/deletion';
import { syncOwnerRetention, syncRetentionPolicies } from './chat/conversations/retention';
import { followupRoutes } from './chat/followups/followups';
import { highlightRoutes } from './chat/highlights/highlights';
import { chatRoutes } from './chat/turns/routes';
import { reconcileTurns } from './chat/turns/scheduling';
import { purgeConversationExecution, sweepCloudflareExecutions } from './execution/privacy';
import { HttpError } from './http';
import { getPublicInferenceConfig } from './inference/config';
import { metricsRoutes } from './metrics/routes';
import { notesRoutes } from './notes/routes';
import { personaRoutes } from './personas/routes';
import { getRequestAccountPolicy } from './policy/request';
import { accountRoutes } from './privacy/account';
import { purgeTelemetry } from './privacy/content-telemetry';
import type { Bindings, Variables } from './types';

export const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
app.get('/api/config', async (c) => {
  const mode = readAuthMode(c.env);
  const inference = await getPublicInferenceConfig(c.env);
  const browser = Boolean(
    c.env.RESEARCH_BROWSER ||
      c.env.BROWSER ||
      (c.env.CLOUDFLARE_ACCOUNT_ID && c.env.CLOUDFLARE_API_TOKEN),
  );
  const extraction = Boolean(c.env.DOCUMENT_EXTRACTOR || c.env.AI);
  return c.json({
    auth: mode === 'clerk' ? { mode, publishableKey: c.env.CLERK_PUBLISHABLE_KEY! } : { mode },
    inference,
    capabilities: {
      documentExtraction: extraction,
      documentTypes: extraction
        ? [
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          ]
        : [],
      renderedPageRead: browser,
      pageLinks: browser,
      pageScreenshot: browser,
      savedSourceSearch: Boolean(
        c.env.SAVED_SOURCES ||
          (browser &&
            c.env.AI_SEARCH_INSTANCE &&
            (c.env.AI_SEARCH || (c.env.CLOUDFLARE_ACCOUNT_ID && c.env.CLOUDFLARE_API_TOKEN))),
      ),
      webSearch: Boolean(c.env.OPENROUTER_API_KEY),
    },
    turnProtocolVersion: 2,
    authConfigured: mode !== 'none',
    modelConfigured: inference.configured,
    ...(c.env.CLERK_PUBLISHABLE_KEY ? { clerkPublishableKey: c.env.CLERK_PUBLISHABLE_KEY } : {}),
    ...(c.env.POSTHOG_API_KEY?.startsWith('phc_')
      ? {
          telemetry: {
            key: c.env.POSTHOG_API_KEY,
            host: c.env.POSTHOG_HOST || 'https://us.i.posthog.com',
          },
        }
      : {}),
  } satisfies AppConfig);
});
mountAuthRoutes(app);
app.use('/api/*', authMiddleware);
app.use('/api/*', async (c, next) => {
  const account = await getRequestAccountPolicy(c);
  await syncOwnerRetention(c.env.DB, c.get('userId'), account.policy.retention.idleDays);
  await next();
});
app.get('/api/account', (c) => c.json(getAccountIdentity(c)));
app.get('/api/account/policy', async (c) => c.json(await getRequestAccountPolicy(c)));
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
    ctx.waitUntil(
      (async () => {
        // Rebase old deadlines before recovery or cleanup can interpret them as deletion.
        await syncRetentionPolicies(env);
        await Promise.all([reconcileTurns(env), sweepCloudflareExecutions(env)]);
        if (controller.cron !== '17 * * * *') return;
        await Promise.all([
          purgeExpiredConversations(env.DB, env.FILES, (owner, id) =>
            purgeConversationExecution(env, owner, id),
          ),
          purgeTelemetry(env),
        ]);
      })(),
    );
  },
};

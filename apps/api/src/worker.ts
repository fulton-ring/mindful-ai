import { ensureD1Schema } from './db/d1-startup';
import type { Bindings } from './types';

export { ChatTurn } from './chat/turns/turn-object';

// Keep the agent framework's initialization inside an event's CPU budget.
export default {
  async fetch(request, env, ctx) {
    try {
      await ensureD1Schema(env.DB);
    } catch (error) {
      console.error('Database startup failed', {
        name: error instanceof Error ? error.name : 'Error',
      });
      return Response.json({ error: 'Database initialization failed' }, { status: 503 });
    }
    const { default: handler } = await import('./index');
    return handler.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    await ensureD1Schema(env.DB);
    const { default: handler } = await import('./index');
    return handler.scheduled(controller, env, ctx);
  },
} satisfies ExportedHandler<Bindings>;

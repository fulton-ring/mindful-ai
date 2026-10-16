import type { Bindings } from './types';

export { ChatTurn } from './chat/turns/turn-object';

// Keep the agent framework's initialization inside an event's CPU budget.
export default {
  async fetch(request, env, ctx) {
    const { default: handler } = await import('./index');
    return handler.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    const { default: handler } = await import('./index');
    return handler.scheduled(controller, env, ctx);
  },
} satisfies ExportedHandler<Bindings>;

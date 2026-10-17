import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../../http';
import type { Bindings, Variables } from '../../types';
import { personaRoutes } from '../routes';

function database() {
  const hidden = new Set<string>();
  const custom = new Map([
    [
      'custom',
      {
        id: 'custom',
        name: 'Custom',
        prompt: 'Prompt',
        brevity: 'brief',
        challenge: 'gentle',
        tone: 'warm',
      },
    ],
  ]);
  return {
    hidden,
    custom,
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          args = values;
          return statement;
        },
        async all<T>() {
          if (sql.includes('FROM hidden_personas'))
            return { results: [...hidden].map((persona_id) => ({ persona_id })) as T[] };
          return { results: [...custom.values()] as T[] };
        },
        async run() {
          if (sql.startsWith('INSERT INTO hidden_personas')) hidden.add(args[1] as string);
          if (sql.startsWith('DELETE FROM personas')) {
            const removed = custom.delete(args[0] as string);
            return { success: true, meta: { changes: removed ? 1 : 0 } };
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database & { hidden: Set<string>; custom: Map<string, unknown> };
}

function request(db: D1Database, path: string, init?: RequestInit, env: Partial<Bindings> = {}) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'owner');
    await next();
  });
  app.route('/api/personas', personaRoutes);
  app.onError((error, c) =>
    error instanceof HttpError ? c.json({ error: error.message }, error.status) : c.json({}, 500),
  );
  return app.fetch(new Request(`https://walden.test${path}`, init), { DB: db, ...env } as Bindings);
}

describe('persona deletion', () => {
  it('hides a built-in persona for its owner and omits it from subsequent lists', async () => {
    const db = database();
    const deleted = await request(db, '/api/personas/critical-reader', { method: 'DELETE' });
    expect(deleted.status).toBe(204);

    const listed = await request(db, '/api/personas');
    const ids = (await listed.json<Array<{ id: string }>>()).map(({ id }) => id);
    expect(ids).not.toContain('critical-reader');
    expect(ids).toContain('thinking-partner');
    expect(db.hidden).toContain('critical-reader');
  });

  it('deletes an owner-created persona', async () => {
    const db = database();
    const deleted = await request(db, '/api/personas/custom', { method: 'DELETE' });

    expect(deleted.status).toBe(204);
    expect(db.custom.has('custom')).toBe(false);
  });
});

it('rejects persona model changes outside the runtime catalog', async () => {
  const result = await request(
    database(),
    '/api/personas',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Custom',
        prompt: 'Prompt',
        brevity: 'brief',
        challenge: 'gentle',
        tone: 'warm',
        model: '@cf/qwen/qwen3.8-27b',
      }),
    },
    { AI: {} as Ai, AI_MODELS_JSON: '["@cf/zai-org/glm-5.3-flash"]' },
  );
  expect(result.status).toBe(422);
  expect(await result.json()).toMatchObject({ error: expect.stringMatching(/not available/) });
});
it('keeps a stored unavailable model readable so it can be repaired', async () => {
  const db = database();
  db.custom.set('old-model', {
    id: 'old-model',
    name: 'Old',
    prompt: '',
    brevity: 'brief',
    challenge: 'gentle',
    tone: 'warm',
    model: 'retired-provider/model',
  });
  const response = await request(db, '/api/personas');
  expect(response.status).toBe(200);
  expect(await response.json()).toContainEqual(
    expect.objectContaining({ id: 'old-model', model: 'retired-provider/model' }),
  );
});

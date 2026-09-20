import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { accountRoutes } from './account';
import { sqliteD1Binding } from './agent/d1-test-binding';
import { contentPreference, PRIVACY_VERSION, purgeTelemetry } from './content-telemetry';
import type { Bindings, Variables } from './types';

it('enforces per-account preferences and keeps retryable deletion requests after account removal', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'walden-privacy-'));
  try {
    const file = join(directory, 'test.sqlite');
    const migrations = new URL('../migrations/', import.meta.url);
    execFileSync('sqlite3', [file], {
      input: readdirSync(migrations)
        .filter((n) => n.endsWith('.sql'))
        .sort()
        .map((n) => readFileSync(new URL(n, migrations), 'utf8'))
        .join('\n'),
    });
    const DB = sqliteD1Binding(file);
    await DB.prepare(
      "INSERT INTO users VALUES ('owner','subject','now','now',0),('other','other','now','now',0)",
    ).run();
    const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set('userId', 'owner');
      c.set('authSubject', 'subject');
      await next();
    });
    app.route('/', accountRoutes);
    const env = { DB } as Bindings;
    const initial = await app.request('/account/privacy', {}, env);
    expect(await initial.json()).toEqual({
      enabled: true,
      acknowledged: false,
      version: PRIVACY_VERSION,
    });
    expect(await contentPreference(DB, 'owner')).toBeFalsy();
    const save = (enabled: boolean) =>
      app.request(
        '/account/privacy',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled, version: PRIVACY_VERSION }),
        },
        env,
      );
    expect((await save(true)).status).toBe(200);
    const active = await contentPreference(DB, 'owner');
    expect(active?.enabled).toBe(1);
    expect(await contentPreference(DB, 'other')).toBeFalsy();
    await save(false);
    expect((await contentPreference(DB, 'owner'))?.enabled).toBe(0);
    await save(true);
    expect((await contentPreference(DB, 'owner'))?.revision).not.toBe(active?.revision);
    expect((await app.request('/account', { method: 'DELETE' }, env)).status).toBe(204);
    expect(await contentPreference(DB, 'owner')).toBeFalsy();
    expect(await DB.prepare('SELECT distinct_id FROM telemetry_deletions').first()).toEqual({
      distinct_id: 'subject',
    });
    await DB.prepare("UPDATE telemetry_deletions SET requested_at='2000-01-01'").run();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({ events_queued_for_deletion: true, deletion_errors: [] }),
      );
    vi.stubGlobal('fetch', fetch);
    const deletionEnv = { DB, POSTHOG_PERSONAL_API_KEY: 'test', POSTHOG_PROJECT_ID: '123' };
    await purgeTelemetry(deletionEnv);
    expect(await DB.prepare('SELECT distinct_id FROM telemetry_deletions').first()).not.toBeFalsy();
    await purgeTelemetry(deletionEnv);
    expect(await DB.prepare('SELECT distinct_id FROM telemetry_deletions').first()).toBeFalsy();
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({
      distinct_ids: ['subject'],
      delete_events: true,
      delete_recordings: true,
    });
  } finally {
    vi.unstubAllGlobals();
    rmSync(directory, { recursive: true, force: true });
  }
});

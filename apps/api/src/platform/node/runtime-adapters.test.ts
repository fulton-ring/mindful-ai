import { cp, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { afterEach, expect, it, vi } from 'vitest';
import { attachmentKey } from '../../chat/attachments/attachments';
import * as conversations from '../../chat/conversations/deletion';
import * as retention from '../../chat/conversations/retention';
import type { AppDatabase } from '../../db/database';
import { LocalObjectStore } from '../../storage/local';
import type { ObjectStore } from '../../storage/object-store';
import { readNodeConfig } from './config';
import { createNodeRuntime } from './runtime';
import {
  defaultNodeRuntimeAdapters,
  type NodeRuntimeAdapters,
  type NodeRuntimeService,
} from './runtime-adapters';
import * as turns from './turns';

const directories: string[] = [];
const runtimes: Awaited<ReturnType<typeof createNodeRuntime>>[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => {});
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

it.each([undefined, '/usr/bin/chromium'])(
  'launches the default research browser with the configured executable %s and its sandbox',
  async (executablePath) => {
    const config = readNodeConfig({ CHROMIUM_EXECUTABLE_PATH: executablePath });
    const unavailable = new Error('Browser unavailable');
    const launch = vi.spyOn(chromium, 'launch').mockRejectedValue(unavailable);
    const browser = await defaultNodeRuntimeAdapters.createResearchBrowser(config);
    await expect(
      browser.readMarkdown('https://fixture.example/', new AbortController().signal),
    ).rejects.toBe(unavailable);
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ executablePath, chromiumSandbox: true }),
    );
  },
);

function alternateProviders(closed: string[]) {
  return {
    extractor: {
      async extract() {
        return { markdown: 'Custom parser' };
      },
      close() {
        closed.push('extractor');
      },
    },
    browser: {
      async readMarkdown() {
        return 'Custom browser';
      },
      async listVisibleLinks() {
        return [];
      },
      async screenshot() {
        return { bytes: new Uint8Array(), mimeType: 'image/jpeg' as const };
      },
      close() {
        closed.push('browser');
      },
    },
    sources: {
      async upsert() {
        return { status: 'complete' };
      },
      async search(_owner: string, query: string) {
        return { query, results: [] };
      },
      async deleteOwner() {},
      close() {
        closed.push('sources');
      },
    },
  };
}

async function fixture(
  options: {
    closed?: string[];
    healthy?: boolean;
    fileReady?: boolean;
    overrides?: NodeRuntimeAdapters;
    environment?: NodeJS.ProcessEnv;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'walden-runtime-adapters-'));
  directories.push(root);
  await cp(resolve('migrations'), join(root, 'migrations'), { recursive: true });
  const config = readNodeConfig({ APP_ROOT: root, DATA_DIR: join(root, 'data') });
  const closed: string[] = options.closed ?? [];
  let healthy = options.healthy ?? true;
  let healthChecks = 0;
  let sourceDatabase: AppDatabase | undefined;
  const backend = new LocalObjectStore(join(root, 'external-provider'));
  const check = async () => {
    healthChecks++;
    if (!healthy) throw new Error('Custom storage is unavailable');
  };
  const files: NodeRuntimeService<ObjectStore> = {
    uploadMode: 'direct',
    get: backend.get.bind(backend),
    head: backend.head.bind(backend),
    put: backend.put.bind(backend),
    delete: backend.delete.bind(backend),
    async list(options) {
      await check();
      return backend.list(options);
    },
    ...(options.fileReady === false ? {} : { ready: check }),
    close() {
      closed.push('files');
    },
  };
  const { extractor, browser, sources } = alternateProviders(closed);
  const adapters: NodeRuntimeAdapters = {
    async createObjectStore(received) {
      expect(received).toBe(config);
      return files;
    },
    createDocumentExtractor: () => extractor,
    createResearchBrowser: () => browser,
    createSavedSources(_config, { db, blobs }) {
      sourceDatabase = db;
      expect(blobs).toBe(files);
      return sources;
    },
    ...options.overrides,
  };
  const runtime = await createNodeRuntime(config, {
    environment: options.environment ?? {},
    adapters,
  });
  runtimes.push(runtime);
  return {
    runtime,
    config,
    files,
    extractor,
    browser,
    sources,
    closed,
    sourceDatabase,
    healthChecks: () => healthChecks,
    failStorage: () => {
      healthy = false;
    },
  };
}

it('uses supplied providers for actual upload/read/delete without default parser or model assets', async () => {
  const context = await fixture();
  const { runtime, config, files } = context;
  const request = (path: string, init?: RequestInit) =>
    runtime.fetch(new Request(`http://localhost:3000${path}`, init));
  expect(runtime.env.FILES).toBe(files);
  expect(runtime.env.DOCUMENT_EXTRACTOR).toBe(context.extractor);
  expect(runtime.env.RESEARCH_BROWSER).toBe(context.browser);
  expect(runtime.env.SAVED_SOURCES).toBe(context.sources);
  expect(runtime.env.ENTITLEMENTS).toBeUndefined();
  expect(context.sourceDatabase).toBe(runtime.db);
  await expect(stat(join(config.appRoot, 'dist/node/document-worker.js'))).rejects.toThrow();
  await expect(stat(config.embeddingModelDir)).rejects.toThrow();
  await expect(stat(config.filesDir)).rejects.toThrow();
  expect((await request('/health/ready')).status).toBe(200);
  const owner = (await (await request('/api/account')).json()) as { id: string };
  const thread = (await (
    await request('/api/conversations', { method: 'POST', body: '{}' })
  ).json()) as { id: string };
  const body = new FormData();
  body.set('file', new File(['from supplied provider'], 'adapter.txt', { type: 'text/plain' }));
  const uploaded = await request(`/api/chat/attachments/${thread.id}`, { method: 'POST', body });
  expect(uploaded.status).toBe(200);
  const attachment = (await uploaded.json()) as { id: string };
  const key = attachmentKey(owner.id, thread.id, attachment.id);
  expect(await (await files.get(key))?.text()).toBe('from supplied provider');
  expect(await (await request(`/api/chat/attachments/${thread.id}/${attachment.id}`)).text()).toBe(
    'from supplied provider',
  );
  expect((await request(`/api/conversations/${thread.id}`, { method: 'DELETE' })).status).toBe(204);
  expect(await files.head(key)).toBeNull();
  await runtime.close();
  expect(context.closed).toEqual(['sources', 'browser', 'extractor', 'files']);
});

it('checks supplied provider health repeatedly even when local storage is configured', async () => {
  const context = await fixture();
  const request = () => context.runtime.fetch(new Request('http://localhost:3000/health/ready'));
  expect(context.config.fileStorage).toBe('local');
  expect((await request()).status).toBe(200);
  expect(context.healthChecks()).toBeGreaterThanOrEqual(2);
  context.failStorage();
  expect((await request()).status).toBe(503);
});

it('closes a supplied provider when its startup health check fails', async () => {
  const closed: string[] = [];
  await expect(fixture({ closed, healthy: false })).rejects.toThrow(
    'Custom storage is unavailable',
  );
  expect(closed).toEqual(['files']);
});

it('falls back to object listing for custom store readiness without a health hook', async () => {
  const context = await fixture({ fileReady: false });
  expect(context.files.ready).toBeUndefined();
  const checks = context.healthChecks();
  await context.runtime.ready();
  expect(context.healthChecks()).toBe(checks + 1);
  context.failStorage();
  await expect(context.runtime.ready()).rejects.toThrow('Custom storage is unavailable');
});

it('retains native asset checks when the default parser is selected', async () => {
  const closed: string[] = [];
  await expect(
    fixture({ closed, overrides: { createDocumentExtractor: undefined } }),
  ).rejects.toThrow('document-worker.js');
  expect(closed).toEqual(['files']);
});

it('retains native model checks when the default saved-source index is selected', async () => {
  const closed: string[] = [];
  await expect(fixture({ closed, overrides: { createSavedSources: undefined } })).rejects.toThrow(
    /config\.json|tokenizer\.json|model_quantized\.onnx/,
  );
  expect(closed).toEqual(['browser', 'extractor', 'files']);
});

it('composes optional entitlements with the application database and managed health and shutdown', async () => {
  const closed: string[] = [];
  let healthy = true;
  let checks = 0;
  let database: AppDatabase | undefined;
  let receivedConfig: ReturnType<typeof readNodeConfig> | undefined;
  const entitlements = {
    async getPlan(ownerId: string) {
      return ownerId === 'subscriber' ? 'paid' : null;
    },
    ready() {
      checks++;
      if (!healthy) throw new Error('Entitlements unavailable');
    },
    close() {
      closed.push('entitlements');
    },
  };
  const context = await fixture({
    closed,
    overrides: {
      createEntitlementsProvider(config, { db }) {
        receivedConfig = config;
        database = db;
        return entitlements;
      },
    },
  });
  expect(context.runtime.env.ENTITLEMENTS).toBe(entitlements);
  expect(database).toBe(context.runtime.db);
  expect(receivedConfig).toBe(context.config);
  expect(await context.runtime.env.ENTITLEMENTS?.getPlan('subscriber')).toBe('paid');
  expect(checks).toBe(1);
  await context.runtime.ready();
  expect(checks).toBe(2);
  healthy = false;
  expect((await context.runtime.fetch(new Request('http://localhost/health/ready'))).status).toBe(
    503,
  );
  await context.runtime.close();
  expect(closed).toEqual(['sources', 'browser', 'extractor', 'files', 'entitlements']);
});

it('closes optional entitlements after a failed startup health check', async () => {
  const closed: string[] = [];
  await expect(
    fixture({
      closed,
      overrides: {
        createEntitlementsProvider() {
          return {
            async getPlan() {
              return null;
            },
            ready() {
              throw new Error('Entitlements unavailable');
            },
            close() {
              closed.push('entitlements');
            },
          };
        },
      },
    }),
  ).rejects.toThrow('Entitlements unavailable');
  expect(closed).toEqual(['entitlements']);
});

it('rejects invalid policy configuration before composing services', async () => {
  let composed = false;
  await expect(
    fixture({
      environment: { APP_PLANS_JSON: '{' },
      overrides: {
        createEntitlementsProvider() {
          composed = true;
          return {
            async getPlan() {
              return null;
            },
          };
        },
      },
    }),
  ).rejects.toThrow();
  expect(composed).toBe(false);
});

it('synchronizes retention after composing entitlements and before native recovery starts', async () => {
  const events: string[] = [];
  const entitlements = {
    async getPlan() {
      return null;
    },
    ready() {
      events.push('provider-ready');
    },
  };
  vi.spyOn(retention, 'syncRetentionPolicies').mockImplementation(async (env) => {
    expect(env.ENTITLEMENTS).toBe(entitlements);
    events.push('sync');
  });
  const createRouter = turns.createNodeTurnRouter;
  vi.spyOn(turns, 'createNodeTurnRouter').mockImplementation((...args) => {
    expect(events).toEqual(['provider-ready', 'sync']);
    events.push('router');
    return createRouter(...args);
  });
  await fixture({ overrides: { createEntitlementsProvider: () => entitlements } });
  expect(events.slice(0, 3)).toEqual(['provider-ready', 'sync', 'router']);
});

it('fails startup before native recovery when retention synchronization is unavailable', async () => {
  vi.spyOn(retention, 'syncRetentionPolicies').mockRejectedValue(new Error('Policy unavailable'));
  const createRouter = vi.spyOn(turns, 'createNodeTurnRouter');
  await expect(fixture()).rejects.toThrow('Policy unavailable');
  expect(createRouter).not.toHaveBeenCalled();
});

it('waits for current retention policy synchronization before the scheduled purge', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sync = vi.spyOn(retention, 'syncRetentionPolicies').mockResolvedValue();
  const purge = vi.spyOn(conversations, 'purgeExpiredConversations').mockResolvedValue(0);
  const intervals = vi.spyOn(globalThis, 'setInterval');
  const context = await fixture();
  sync.mockClear().mockImplementation(() => gate);
  const hourly = intervals.mock.calls.filter(([, delay]) => delay === 60 * 60_000).at(-1)?.[0];
  expect(hourly).toBeTypeOf('function');
  hourly!();
  try {
    expect(sync).toHaveBeenCalledWith(context.runtime.env);
    expect(purge).not.toHaveBeenCalled();
  } finally {
    release();
  }
  await vi.waitFor(() => expect(purge).toHaveBeenCalledOnce());
});

it('skips the scheduled purge when entitlement synchronization fails', async () => {
  const sync = vi.spyOn(retention, 'syncRetentionPolicies').mockResolvedValue();
  const purge = vi.spyOn(conversations, 'purgeExpiredConversations').mockResolvedValue(0);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const intervals = vi.spyOn(globalThis, 'setInterval');
  await fixture();
  sync.mockRejectedValue(new Error('Provider unavailable'));
  const hourly = intervals.mock.calls.filter(([, delay]) => delay === 60 * 60_000).at(-1)?.[0];
  expect(hourly).toBeTypeOf('function');
  hourly!();
  await vi.waitFor(() => expect(warning).toHaveBeenCalledWith('Background task deferred'));
  expect(purge).not.toHaveBeenCalled();
});

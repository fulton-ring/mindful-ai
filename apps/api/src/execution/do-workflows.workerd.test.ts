import { mkdtemp, rm } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const { build } = wranglerRequire('esbuild');

async function buildWorker(): Promise<string> {
  const directory = dirname(fileURLToPath(import.meta.url));
  const { outputFiles } = await build({
    stdin: {
      contents: `
      import { Agent } from '@mastra/core/agent';
      import { MastraCompositeStore } from '@mastra/core/storage';
      import { nativeAgentStream } from './native-agent';
      import { streamMastraTurn } from '../agent/mastra-turn';
      import { deterministicModel } from './fixture-model';
      import { DoWorkflowsStorage } from './do-workflows';
      import { DoSqliteCache } from './sqlite-cache';
      export class TestObject {
        constructor(ctx) { this.ctx = ctx; this.workflows = new DoWorkflowsStorage({ storage: ctx.storage }); this.cache = new DoSqliteCache({ storage: ctx.storage, ttlMs: 0 }); }
        async fetch(req) {
          const path = new URL(req.url).pathname;
          if (path.startsWith('/app')) {
            const storage = new MastraCompositeStore({ id: 'app-native-test', domains: { workflows: this.workflows } });
            const input = { turnId: 'app-turn', requestId: 'app-request', conversation: { id: 'conversation', title: 'Native test', noteId: null, messages: [], expiresAt: new Date(Date.now() + 60000).toISOString(), learningChecksEnabled: false, branchId: 'branch', branches: [] }, note: null, persona: { id: 'mentor', name: 'Mentor', prompt: 'Help me think clearly.', tone: 'neutral', brevity: 'brief', challenge: 'gentle' }, message: 'Explain the result.' };
            const events = [];
            const model = deterministicModel();
            if (path === '/app-replay') model.doStream = async () => { throw new Error('Completed app replay must not call provider'); };
            for await (const event of streamMastraTurn({ input, model, signal: AbortSignal.timeout(10000), runtime: { execution: { host: { storage, cache: this.cache }, runId: 'app-turn', recover: path === '/app-replay', generation: 1 } } })) events.push(event);
            return Response.json({ text: events.filter(event => event.type === 'text-delta').map(event => event.delta).join(''), types: events.map(event => event.type) });
          }
          if (path.startsWith('/native')) {
            const storage = new MastraCompositeStore({ id: 'do-native-test', domains: { workflows: this.workflows } });
            const crash = path === '/native-crash';
            const model = deterministicModel();
            if (path === '/native-replay') model.doStream = async () => { throw new Error('Completed native replay must not call provider'); };
            if (crash) model.doStream = async () => ({ stream: new ReadableStream({ start(controller) { controller.enqueue({ type: 'stream-start', warnings: [] }); } }) });
            const agent = new Agent({ id: 'native-workerd-test', name: 'Native workerd test', instructions: 'Answer.', model });
            const runId = crash || path === '/native-recover' ? 'crash-turn' : 'native-turn';
            if (path === '/native-recover') this.ctx.storage.sql.exec('UPDATE execution_run_owners SET lease_expires_at = 0 WHERE run_id = ?', runId);
            const run = await nativeAgentStream(agent, 'Hello', {}, { host: { storage, cache: this.cache }, runId, recover: path === '/native-replay' || path === '/native-recover', generation: 1 });
            if (crash) {
              for (let i = 0; i < 50; i++) {
                const snapshot = await this.workflows.loadWorkflowSnapshot({ workflowName: 'durable-agentic-loop', runId });
                if (snapshot?.status === 'running' && snapshot.context?.input) return Response.json({ status: snapshot.status });
                await new Promise(resolve => setTimeout(resolve, 10));
              }
              throw new Error('Crash fixture never reached persisted running state');
            }
            const text = await run.output.text;
            await run.release();
            return Response.json({ text });
          }
          if (new URL(req.url).pathname === '/write') {
            const first = await this.workflows.claimRunOwnership({ runId: 'run', ownerId: 'first', leaseMs: 30000 });
            const fence = { runId: 'run', generation: first.record.generation, ownerId: 'first' };
            await this.workflows.persistWorkflowSnapshot({ workflowName: 'flow', runId: 'run', snapshot: { runId: 'run', status: 'running', context: {} }, fence });
            await this.workflows.updateWorkflowResults({ workflowName: 'flow', runId: 'run', stepId: 'step', result: { status: 'success', output: 42 }, requestContext: { tenant: 'user' }, state: { saved: true }, fence });
            await Promise.all(Array.from({ length: 12 }, (_, n) => this.cache.listPushIndexed('events', 'counter', { n })));
            await this.workflows.claimRunOwnership({ runId: 'run', ownerId: 'second', leaseMs: 30000, force: true });
            let conflict;
            try { await this.workflows.updateWorkflowState({ workflowName: 'flow', runId: 'run', opts: { status: 'failed' }, fence }); } catch (error) { conflict = error.id; }
            return Response.json({ conflict });
          }
          return Response.json({ snapshot: await this.workflows.loadWorkflowSnapshot({ workflowName: 'flow', runId: 'run' }), events: await this.cache.listFromTo('events', 0) });
        }
      }
      export default { fetch(req, env) { return env.TEST.get(env.TEST.idFromName('one')).fetch(req); } };
    `,
      resolveDir: directory,
      loader: 'ts',
    },
    plugins: [
      {
        name: 'node-builtins',
        setup(builder: {
          onResolve(
            options: { filter: RegExp },
            callback: (args: { path: string }) => { path: string; external: boolean } | undefined,
          ): void;
        }) {
          builder.onResolve({ filter: /.*/ }, (args: { path: string }) =>
            builtinModules.includes(args.path)
              ? { path: `node:${args.path}`, external: true }
              : undefined,
          );
        },
      },
    ],
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire('/bundle.mjs');",
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    external: ['node:*', 'cloudflare:*'],
  });
  return outputFiles[0].text;
}

it('runs fenced native SQLite workflows and atomic streams in workerd across restart', async () => {
  const script = await buildWorker();
  const persistence = await mkdtemp(join(tmpdir(), 'walden-execution-workerd-'));
  const options = convertV4MiniflareOptions({
    name: 'execution-storage-test',
    modules: true,
    script,
    compatibilityDate: '2026-09-01',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: { TEST: { className: 'TestObject', useSQLite: true } },
    durableObjectsPersist: persistence,
  });
  options.resourcePersistencePath = persistence;
  let mf = new Miniflare(options);
  try {
    const response = await mf.dispatchFetch('http://local/write');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ conflict: 'STORAGE_RUN_FENCE_CONFLICT' });
    const app = await mf.dispatchFetch('http://local/app');
    expect(app.status).toBe(200);
    expect(await app.json()).toMatchObject({
      text: 'Native answer.',
      types: expect.arrayContaining(['text-start', 'text-delta', 'text-end']),
    });
    const native = await mf.dispatchFetch('http://local/native');
    expect(native.status).toBe(200);
    expect(await native.json()).toEqual({ text: 'Native answer.' });
    const crash = await mf.dispatchFetch('http://local/native-crash');
    expect(crash.status).toBe(200);
    expect(await crash.json()).toEqual({ status: 'running' });
    await mf.dispose();
    mf = new Miniflare(options);
    const appReplay = await mf.dispatchFetch('http://local/app-replay');
    expect(appReplay.status).toBe(200);
    expect(await appReplay.json()).toMatchObject({ text: 'Native answer.' });
    // Advance the abandoned claim's persisted lease to expiry, then use native recover().
    const recovered = await mf.dispatchFetch('http://local/native-recover');
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ text: 'Native answer.' });
    const replay = await mf.dispatchFetch('http://local/native-replay');
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ text: 'Native answer.' });
    const read = await mf.dispatchFetch('http://local/read');
    const result = (await read.json()) as {
      snapshot: unknown;
      events: { index: number; n: number }[];
    };
    expect(result.snapshot).toMatchObject({
      status: 'running',
      context: { step: { output: 42 }, __state: { saved: true } },
      requestContext: { tenant: 'user' },
    });
    expect(result.events.map((event) => event.index)).toEqual(
      Array.from({ length: 12 }, (_, n) => n),
    );
  } finally {
    await mf.dispose();
    await rm(persistence, { recursive: true, force: true });
  }
}, 30000);

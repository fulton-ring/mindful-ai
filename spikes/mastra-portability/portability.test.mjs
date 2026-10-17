import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const children = new Set();
const directories = new Set();

afterEach(async () => {
  for (const child of children) child.kill('SIGKILL');
  await Promise.all([...children].map((child) => child.exited));
  children.clear();
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
});

async function until(check, label, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await delay(20);
  }
  throw new Error(`Timed out: ${label}`);
}

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'walden-mastra-spike-'));
  directories.add(path);
  return path;
}

async function processFixture(config) {
  const child = fork(new URL('./process.mjs', import.meta.url), [JSON.stringify(config)], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, DO_NOT_TRACK: '1' },
  });
  children.add(child);
  const messages = [];
  let diagnostics = '';
  child.stdout.on('data', (chunk) => {
    diagnostics += chunk;
  });
  child.stderr.on('data', (chunk) => {
    diagnostics += chunk;
  });
  child.on('message', (message) => messages.push(message));
  child.exited = new Promise((resolve) => child.once('exit', resolve));
  const wait = (predicate, label) =>
    until(() => {
      const message = messages.find(predicate);
      if (message) return message;
      if (child.exitCode !== null || child.signalCode) {
        throw new Error(`Child exited waiting for ${label}: ${diagnostics}`);
      }
      return false;
    }, `${label}\n${diagnostics}`);
  await wait((message) => message.event === 'ready', 'runtime ready');
  return {
    child,
    messages,
    wait,
    async command(action, payload = {}) {
      const id = crypto.randomUUID();
      child.send({ action, id, ...payload });
      const reply = await wait((message) => message.id === id, action);
      if (reply.error) throw new Error(`${reply.error}\n${diagnostics}`);
      return reply.value;
    },
    async kill() {
      child.kill('SIGKILL');
      await child.exited;
    },
  };
}

const deltas = (messages, channel) =>
  messages
    .filter((message) => message.event === 'chunk' && message.channel === channel)
    .filter((message) => message.chunk.type === 'text-delta')
    .map((message) => message.chunk.payload.text)
    .join('');

async function ledger(path) {
  return (await readFile(join(path, 'ledger.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
}

async function recover(replacement, runId) {
  await delay(Number(process.env.SPIKE_RECOVERY_WAIT_MS || 0));
  return replacement.command('recover', { runId, force: process.env.SPIKE_FORCE_RECOVERY === '1' });
}

for (const kind of ['durable', 'evented']) {
  test(`${kind}: disconnect detaches; another observer replays and follows the same run`, {
    timeout: 25_000,
  }, async () => {
    const dir = await directory();
    const owner = await processFixture({ dir, kind, hold: 'model' });
    const runId = await owner.command('start');
    await owner.wait(
      (message) => message.event === 'chunk' && message.chunk.type === 'text-delta',
      'first live text',
    );
    assert.equal(deltas(owner.messages, 'start'), 'Hello ');
    await owner.command('detach', { channel: 'start' });
    await owner.command('observe', { runId, channel: 'reconnect' });
    await owner.wait(
      (message) => message.channel === 'reconnect' && message.chunk?.type === 'text-delta',
      'replayed prefix',
    );
    await writeFile(join(dir, 'release'), 'yes');
    await owner.wait(
      (message) => message.event === 'done' && message.channel === 'reconnect',
      'reconnected completion',
    );
    assert.equal(deltas(owner.messages, 'reconnect'), 'Hello world.');
    assert.equal((await ledger(dir)).filter((entry) => entry.type === 'model-call').length, 1);
  });

  test(`${kind}: Stop aborts the model and preserves partial output`, {
    timeout: 25_000,
  }, async () => {
    const dir = await directory();
    const owner = await processFixture({ dir, kind, hold: 'model' });
    const runId = await owner.command('start');
    await owner.wait((message) => message.chunk?.type === 'text-delta', 'partial text');
    await owner.command('abort', { runId });
    await owner.wait((message) => message.event === 'done', 'aborted completion');
    assert.equal(deltas(owner.messages, 'start'), 'Hello ');
    assert((await ledger(dir)).some((entry) => entry.type === 'model-aborted'));
    assert(!owner.messages.some((message) => message.event === 'stream-error'));
  });

  test(`${kind}: Stop during a tool prevents a later write`, { timeout: 25_000 }, async () => {
    const dir = await directory();
    const owner = await processFixture({ dir, kind, mode: 'tool', hold: 'tool-before-write' });
    const runId = await owner.command('start');
    await owner.wait((message) => message.event === 'tool-enter', 'tool waiting before write');
    await owner.command('abort', { runId });
    await owner.wait((message) => message.event === 'done', 'stopped tool run');
    await writeFile(join(dir, 'release'), 'yes');
    await delay(100);
    assert.deepEqual(await owner.command('effects'), []);
    assert(!(await ledger(dir)).some((entry) => entry.type === 'tool-written'));
  });

  test(`${kind}: SIGKILL leaves a discoverable snapshot; recovery reissues the interrupted model call`, {
    timeout: 75_000,
  }, async () => {
    const dir = await directory();
    const owner = await processFixture({ dir, kind, hold: 'model' });
    const runId = await owner.command('start');
    await owner.wait(
      (message) => message.chunk?.type === 'text-delta',
      'partial output before SIGKILL',
    );
    await owner.kill();
    await writeFile(join(dir, 'release'), 'yes');
    const replacement = await processFixture({ dir, kind });
    const active = await replacement.command('active');
    assert(
      active.runs.some((run) => run.runId === runId),
      `Missing snapshot: ${JSON.stringify(active)}`,
    );
    assert.deepEqual(
      await replacement.command('history', { runId }),
      [],
      'Default replay cache does not survive restart',
    );
    await recover(replacement, runId);
    await replacement.wait((message) => message.event === 'done', 'recovered completion');
    assert.equal(
      deltas(replacement.messages, 'recover'),
      'Hello world.',
      JSON.stringify(replacement.messages),
    );
    assert.equal((await ledger(dir)).filter((entry) => entry.type === 'model-call').length, 2);
  });

  for (const deduplicate of [false, true]) {
    test(`${kind}: crash after a tool write ${deduplicate ? 'requires an idempotency key to avoid duplication' : 'can repeat an external effect'}`, {
      timeout: 75_000,
    }, async () => {
      const dir = await directory();
      const owner = await processFixture({
        dir,
        kind,
        mode: 'tool',
        hold: 'tool-after-write',
        deduplicate,
      });
      const runId = await owner.command('start');
      await owner.wait((message) => message.event === 'tool-written', 'durable tool write');
      await owner.kill();
      await writeFile(join(dir, 'release'), 'yes');
      const replacement = await processFixture({ dir, kind, mode: 'tool', deduplicate });
      await recover(replacement, runId);
      await replacement.wait((message) => message.event === 'done', 'tool recovery');
      const entries = await ledger(dir);
      assert.equal(entries.filter((entry) => entry.type === 'tool-enter').length, 2);
      const effects = await replacement.command('effects');
      assert.equal(effects.length, deduplicate ? 1 : 2);
      assert.equal(
        deltas(replacement.messages, 'recover'),
        'Saved.',
        JSON.stringify(replacement.messages),
      );
    });
  }

  test(`${kind}: recovery must not rerun a completed tool`, { timeout: 75_000 }, async () => {
    const dir = await directory();
    const owner = await processFixture({ dir, kind, mode: 'tool', hold: 'model' });
    const runId = await owner.command('start');
    await owner.wait(
      (message) => message.chunk?.type === 'text-delta',
      'model after completed tool',
    );
    await owner.kill();
    await writeFile(join(dir, 'release'), 'yes');
    const replacement = await processFixture({ dir, kind, mode: 'tool' });
    await recover(replacement, runId);
    await replacement.wait((message) => message.event === 'done', 'recovery after completed tool');
    assert.equal((await ledger(dir)).filter((entry) => entry.type === 'tool-enter').length, 1);
    assert.equal((await replacement.command('effects')).length, 1);
    assert.equal(
      deltas(replacement.messages, 'recover'),
      'Saved.',
      JSON.stringify(replacement.messages),
    );
  });
}

for (const kind of ['durable', 'evented']) {
  test(`${kind} distributed: a separate process replays, follows, and stops the owner through Valkey`, {
    timeout: 35_000,
    skip: !process.env.SPIKE_REDIS_URL,
  }, async () => {
    const dir = await directory();
    const config = { dir, kind, redisUrl: process.env.SPIKE_REDIS_URL };
    const owner = await processFixture({ ...config, hold: 'model' });
    const runId = await owner.command('start');
    await owner.wait((message) => message.chunk?.type === 'text-delta', 'owner partial text');
    const observer = await processFixture(config);
    await observer.command('observe', { runId, channel: 'remote' });
    await observer.wait((message) => message.chunk?.type === 'text-delta', 'remote replay');
    assert.equal(deltas(observer.messages, 'remote'), 'Hello ');
    await observer.command('abort', { runId });
    await owner.wait((message) => message.event === 'done', 'owner stopped remotely');
    await observer.wait((message) => message.event === 'done', 'observer sees terminal event');
    assert.equal(deltas(owner.messages, 'start'), 'Hello ');
    assert((await ledger(dir)).some((entry) => entry.type === 'model-aborted'));
  });

  test(`${kind} distributed: persistent stream history survives owner SIGKILL`, {
    timeout: 35_000,
    skip: !process.env.SPIKE_REDIS_URL,
  }, async () => {
    const dir = await directory();
    const config = { dir, kind, redisUrl: process.env.SPIKE_REDIS_URL };
    const owner = await processFixture({ ...config, hold: 'model' });
    const runId = await owner.command('start');
    await owner.wait((message) => message.chunk?.type === 'text-delta', 'owner prefix');
    await owner.kill();
    const observer = await processFixture(config);
    await observer.command('observe', { runId, channel: 'after-crash' });
    await observer.wait(
      (message) => message.chunk?.type === 'text-delta',
      'prefix replayed after owner crash',
    );
    assert.equal(deltas(observer.messages, 'after-crash'), 'Hello ');
    assert.equal((await ledger(dir)).filter((entry) => entry.type === 'model-call').length, 1);
  });

  test(`${kind} distributed: recovery must not take over a healthy owner`, {
    timeout: 35_000,
    skip: !process.env.SPIKE_REDIS_URL,
  }, async () => {
    const dir = await directory();
    const config = { dir, kind, redisUrl: process.env.SPIKE_REDIS_URL };
    const owner = await processFixture({ ...config, hold: 'model' });
    const runId = await owner.command('start');
    await owner.wait((message) => message.chunk?.type === 'text-delta', 'healthy owner prefix');
    const challenger = await processFixture(config);
    await assert.rejects(
      challenger.command('recover', { runId }),
      /still being executed|already recovering|execution conflict/,
    );
    assert.equal((await ledger(dir)).filter((entry) => entry.type === 'model-call').length, 1);
  });

  test(`${kind} distributed: recovered output must not append a replayed partial answer twice`, {
    timeout: 75_000,
    skip: !process.env.SPIKE_REDIS_URL,
  }, async () => {
    const dir = await directory();
    const config = { dir, kind, redisUrl: process.env.SPIKE_REDIS_URL };
    const owner = await processFixture({ ...config, hold: 'model' });
    const runId = await owner.command('start');
    await owner.wait((message) => message.chunk?.type === 'text-delta', 'prefix before crash');
    await owner.kill();
    await writeFile(join(dir, 'release'), 'yes');
    const replacement = await processFixture(config);
    await recover(replacement, runId);
    await replacement.wait(
      (message) => message.event === 'done',
      'recovery with persistent replay',
    );
    assert.equal(
      deltas(replacement.messages, 'recover'),
      'Hello world.',
      JSON.stringify(replacement.messages),
    );
  });
}

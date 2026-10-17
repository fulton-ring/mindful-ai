import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { Agent } from '@mastra/core/agent';
import { InMemoryServerCache } from '@mastra/core/cache';
import { LibSQLStore } from '@mastra/libsql';
import { expect, it, vi } from 'vitest';
import { nativeAgentStream } from './native-agent';

const fixtureResponse =
  [
    {
      id: 'fixture',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fixture',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: 'Native answer.' },
          finish_reason: null,
        },
      ],
    },
    {
      id: 'fixture',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fixture',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    },
  ]
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join('') + 'data: [DONE]\n\n';

it('uses the instance API key for inference without persisting it in the native workflow snapshot', async () => {
  const secret = 'sk-instance-private-native-snapshot-regression-123456789';
  let releaseAnswer!: () => void, enteredInference!: () => void;
  const answerGate = new Promise<void>((resolve) => {
    releaseAnswer = resolve;
  });
  const inferenceStarted = new Promise<void>((resolve) => {
    enteredInference = resolve;
  });
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${secret}`);
    enteredInference();
    await answerGate;
    return new Response(fixtureResponse, { headers: { 'content-type': 'text/event-stream' } });
  });
  const provider = createOpenAICompatible({
    name: 'snapshot-fixture',
    baseURL: 'https://inference.invalid/v1',
    apiKey: secret,
    fetch: fetcher,
  });
  const storage = new LibSQLStore({ id: 'native-secret-test', url: ':memory:' });
  await storage.init();
  try {
    const agent = new Agent({
      id: 'native-secret-test',
      name: 'Native secret test',
      instructions: 'Answer.',
      model: provider.chatModel('fixture'),
    });
    const running = nativeAgentStream(
      agent,
      'Hello',
      {},
      {
        host: { storage, cache: new InMemoryServerCache() },
        runId: 'private-config',
        recover: false,
        generation: 1,
      },
    );
    try {
      await inferenceStarted;
      const workflows = (await storage.getStore('workflows'))!;
      const snapshots = await workflows.listWorkflowRuns();
      expect(snapshots.runs.length).toBeGreaterThan(0);
      expect(JSON.stringify(snapshots)).not.toContain(secret);
    } finally {
      releaseAnswer();
    }
    const run = await running;
    expect(await run.output.text).toBe('Native answer.');
    await run.release();
    expect(fetcher).toHaveBeenCalled();
  } finally {
    releaseAnswer();
    await storage.close();
  }
}, 20_000);

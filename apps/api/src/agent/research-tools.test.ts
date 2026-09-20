import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';
import { createTool } from '@mastra/core/tools';
import { type ChatEvent, DEFAULT_PERSONAS } from '@walden/contracts';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createCloudflareModel, DEFAULT_AI_MODEL } from '../services/agent';
import { createResearchTools, type ResearchEnv } from '../services/research';
import type { AgentTurnInput } from '../services/types';
import { streamMastraTurn } from './index';

const usage: LanguageModelV3Usage = {
  inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

function researchModel(
  calls: LanguageModelV3CallOptions[],
  searchWeb = false,
  learningCheck = false,
): LanguageModelV3 {
  let step = 0;
  const stream = (parts: LanguageModelV3StreamPart[]) =>
    new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    });
  return {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'research-script',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('This test expects streaming generation');
    },
    async doStream(options) {
      calls.push(options);
      step += 1;
      if (step === 1) {
        return {
          stream: stream([
            {
              type: 'tool-call',
              toolCallId: 'read-1',
              toolName: learningCheck
                ? 'proposeLearningCheck'
                : searchWeb
                  ? 'searchWeb'
                  : 'readWebPage',
              input: JSON.stringify(
                learningCheck
                  ? { question: 'What does chlorophyll absorb?' }
                  : searchWeb
                    ? { query: 'OpenAI Hugging Face incident' }
                    : { url: 'https://example.com/research' },
              ),
            },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage },
          ]),
        };
      }
      if (step === 2) {
        return {
          stream: stream([
            {
              type: 'tool-call',
              toolCallId: 'search-1',
              toolName: 'searchSources',
              input: JSON.stringify({ query: 'deterministic research result' }),
            },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage },
          ]),
        };
      }
      if (step === 3) {
        const answer =
          'The retrieved source says deterministic tests avoid external dependencies ([Example research](https://example.com/research)).';
        return {
          stream: stream([
            {
              type: 'source',
              sourceType: 'url',
              id: 'native-source',
              url: 'https://docs.example.com/native',
              title: 'Native source',
            },
            { type: 'text-start', id: 'answer' },
            { type: 'text-delta', id: 'answer', delta: answer },
            { type: 'text-end', id: 'answer' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
          ]),
        };
      }
      throw new Error(`Unexpected model step ${step}`);
    },
  };
}

function researchTools(signal: AbortSignal) {
  const upload = vi.fn().mockResolvedValue({ id: 'indexed-source', status: 'ready' });
  const quickAction = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        success: true,
        result: '# Deterministic research\n\nDeterministic tests avoid external dependencies.',
      }),
      { headers: { 'content-type': 'application/json' } },
    ),
  );
  const search = vi.fn().mockResolvedValue({
    search_query: 'deterministic research result',
    chunks: [
      {
        id: 'chunk-1',
        type: 'text',
        score: 0.98,
        text: 'Deterministic tests avoid external dependencies.',
        item: {
          metadata: {
            // createResearchTools checks this value against its hashed owner scope;
            // the instance fills it from the upload metadata to model a private index.
            owner_scope: '',
            source_url: 'https://example.com/research',
          },
        },
      },
    ],
  });
  const instance = {
    items: { upload },
    search: vi.fn(async (...args: unknown[]) => {
      const ownerScope = (
        args[0] as { ai_search_options: { retrieval: { filters: { owner_scope: string } } } }
      ).ai_search_options.retrieval.filters.owner_scope;
      const result = await search(...args);
      result.chunks[0].item.metadata.owner_scope = ownerScope;
      return result;
    }),
  };
  const env = {
    BROWSER: { quickAction },
    AI_SEARCH: { get: vi.fn(() => instance) },
    AI_SEARCH_INSTANCE: 'research',
  } as unknown as ResearchEnv;
  return {
    tools: createResearchTools(env, 'owner-1', signal),
    quickAction,
    upload,
    search: instance.search,
  };
}

const turnInput = (): AgentTurnInput => ({
  ownerId: 'owner-1',
  turnId: 'turn-1',
  requestId: 'request-1',
  conversation: {
    id: 'conversation-1',
    title: 'Research',
    noteId: null,
    messages: [],
    expiresAt: '2999-01-01T00:00:00.000Z',
    learningChecksEnabled: false,
    branchId: 'branch',
    branches: [],
  },
  note: null,
  persona: DEFAULT_PERSONAS[0]!,
  message: 'Read https://example.com/research, search the saved source, and cite the answer.',
  action: 'message',
});

describe('research tools in a Mastra turn', () => {
  it('stops a failed web lookup before the model can turn it into an unsupported answer', async () => {
    const events: ChatEvent[] = [];
    const calls: LanguageModelV3CallOptions[] = [];
    const run = async () => {
      for await (const event of streamMastraTurn(
        { ...turnInput(), message: 'Explain the huggingface attack to me' },
        researchModel(calls, true),
        new AbortController().signal,
        {
          searchWeb: createTool({
            id: 'search_web',
            description: 'Search',
            inputSchema: z.object({ query: z.string() }),
            execute: async () => {
              throw new Error('Provider unavailable');
            },
          }),
        },
      ))
        events.push(event);
    };
    await expect(run()).rejects.toThrow('Web search failed');
    expect(calls[0]?.toolChoice).not.toEqual({ type: 'tool', toolName: 'searchWeb' });
    expect(events.some((event) => event.type === 'text')).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool',
        tool: expect.objectContaining({ name: 'searchWeb', state: 'error' }),
      }),
    );
  });
  it('keeps the source usable but exposes failed search indexing', async () => {
    const controller = new AbortController();
    const fixture = researchTools(controller.signal);
    fixture.upload.mockRejectedValueOnce(new Error('Index unavailable'));
    const events = [];
    for await (const event of streamMastraTurn(
      turnInput(),
      researchModel([]),
      controller.signal,
      fixture.tools,
    ))
      events.push(event);
    expect(events).toContainEqual({
      type: 'tool',
      tool: {
        id: 'read-1',
        name: 'readWebPage',
        state: 'complete',
        summary: 'Read, but not saved to search',
      },
    });
    expect(events).toContainEqual({
      type: 'source',
      source: { id: 'read-1:0', url: 'https://example.com/research' },
    });
  });

  it('reads, searches, exposes tool results to later model steps, and returns a cited answer', async () => {
    const controller = new AbortController();
    const calls: LanguageModelV3CallOptions[] = [];
    const fixture = researchTools(controller.signal);

    const events = [];
    for await (const event of streamMastraTurn(
      turnInput(),
      researchModel(calls),
      controller.signal,
      fixture.tools,
    ))
      events.push(event);

    expect(calls).toHaveLength(3);
    expect(JSON.stringify(calls[1]?.prompt)).toContain(
      'Deterministic tests avoid external dependencies.',
    );
    expect(JSON.stringify(calls[2]?.prompt)).toContain('https://example.com/research');
    expect(events).toEqual(
      expect.arrayContaining([
        { type: 'status', text: 'Reading source…' },
        { type: 'status', text: 'Searching sources…' },
        {
          type: 'tool',
          tool: {
            id: 'read-1',
            name: 'readWebPage',
            state: 'running',
            summary: 'Reading source…',
          },
        },
        {
          type: 'tool',
          tool: {
            id: 'read-1',
            name: 'readWebPage',
            state: 'complete',
            summary: '',
          },
        },
        {
          type: 'source',
          source: {
            id: 'read-1:0',
            url: 'https://example.com/research',
          },
        },
      ]),
    );
    expect(JSON.stringify(events.filter((event) => event.type === 'tool'))).not.toContain(
      'Deterministic tests avoid external dependencies.',
    );
    const done = events.find((event) => event.type === 'done');
    expect(done).toMatchObject({
      type: 'done',
      message: {
        content: expect.stringContaining('[Example research](https://example.com/research)'),
        tools: [
          expect.objectContaining({ id: 'read-1', state: 'complete' }),
          expect.objectContaining({ id: 'search-1', state: 'complete' }),
        ],
        sources: [
          { id: 'read-1:0', url: 'https://example.com/research' },
          {
            id: 'native-source',
            url: 'https://docs.example.com/native',
            title: 'Native source',
          },
        ],
      },
    });
  });
});

function silentModel(calls: LanguageModelV3CallOptions[]): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'silent',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('This test expects streaming generation');
    },
    async doStream(options) {
      calls.push(options);
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'a' });
            controller.enqueue({ type: 'text-delta', id: 'a', delta: 'Noted.' });
            controller.enqueue({ type: 'text-end', id: 'a' });
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage,
            });
            controller.close();
          },
        }),
      };
    },
  };
}

async function systemPrompt(tools: Parameters<typeof streamMastraTurn>[3]): Promise<string> {
  const controller = new AbortController();
  const calls: LanguageModelV3CallOptions[] = [];
  for await (const _event of streamMastraTurn(
    turnInput(),
    silentModel(calls),
    controller.signal,
    tools,
  ));
  return JSON.stringify(calls[0]?.prompt.filter((message) => message.role === 'system'));
}

describe('browsing instructions follow the registered tools', () => {
  it('describes readWebPage and searchSources when they are registered', async () => {
    const controller = new AbortController();
    const prompt = await systemPrompt(researchTools(controller.signal).tools);

    expect(prompt).toContain('readWebPage');
    expect(prompt).toContain('searchSources');
    expect(prompt).not.toContain('no web access');
  });

  it('states that there is no web access when they are not', async () => {
    // AI Search and the browser binding only exist in the research wrangler env.
    // Without this the model kept offering to look things up it could not fetch.
    const prompt = await systemPrompt({});

    expect(prompt).toContain('no web access');
    expect(prompt).not.toContain('readWebPage');
  });
});

const liveToken = process.env.CLOUDFLARE_API_TOKEN;
const runLive = process.env.RUN_LIVE_RESEARCH === '1' && Boolean(liveToken);

describe.skipIf(!runLive)('live Gemma research tool calling', () => {
  it('uses the synthetic reader and search index before citing their source', async () => {
    const controller = new AbortController();
    const fixture = researchTools(controller.signal);
    const model = createCloudflareModel(
      {
        CLOUDFLARE_ACCOUNT_ID: 'e9be35217a75f5d2148e572d8853b3bf',
        CLOUDFLARE_API_TOKEN: liveToken,
      },
      DEFAULT_AI_MODEL,
    );
    const input = turnInput();
    input.message =
      'Use readWebPage on https://example.com/research, then use searchSources for "deterministic research result". Answer only from those tool results and cite the returned source URL.';

    const events = [];
    for await (const event of streamMastraTurn(input, model, controller.signal, fixture.tools))
      events.push(event);

    expect(fixture.quickAction).toHaveBeenCalledOnce();
    expect(fixture.search).toHaveBeenCalledOnce();
    const done = events.find((event) => event.type === 'done');
    expect(done?.type === 'done' ? done.message.content : '').toMatch(
      /deterministic tests avoid external dependencies/i,
    );
    expect(done?.type === 'done' ? done.message.content : '').toContain(
      'https://example.com/research',
    );
  }, 90_000);
});

it('ends the model loop once a learning check is ready for the user', async () => {
  const input = turnInput();
  input.conversation.learningChecksEnabled = true;
  input.persona = DEFAULT_PERSONAS.find((p) => p.id === 'study-partner')!;
  input.message = 'Help me study photosynthesis';
  const calls: LanguageModelV3CallOptions[] = [];
  const events: ChatEvent[] = [];
  for await (const event of streamMastraTurn(
    input,
    researchModel(calls, false, true),
    new AbortController().signal,
  ))
    events.push(event);
  expect(calls).toHaveLength(1);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'intervention',
      intervention: expect.objectContaining({
        kind: 'learning_check',
        question: 'What does chlorophyll absorb?',
      }),
    }),
  );
  expect(events.at(-1)?.type).toBe('done');
});

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import { createTool } from '@mastra/core/tools';
import { DEFAULT_PERSONAS, type WaldenUIMessageChunk } from '@walden/contracts';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createCloudflareModel, DEFAULT_AI_MODEL } from '../../../services/agent/agent';
import { streamMastraTurn } from '../../mastra-turn';
import {
  chunkText,
  researchModel,
  researchTools,
  turnInput,
  usage,
} from '../fixtures/research-tools';

it('sends attached image bytes to the model as image content', async () => {
  const calls: LanguageModelV3CallOptions[] = [];
  const input = {
    ...turnInput(),
    attachments: [
      {
        id: crypto.randomUUID(),
        name: 'chart.png',
        mimeType: 'image/png',
        size: 3,
        bytes: new Uint8Array(
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGmQAAAAASUVORK5CYII=',
            'base64',
          ),
        ),
      },
    ],
  };
  for await (const _ of streamMastraTurn({
    input,
    model: silentModel(calls),
    signal: new AbortController().signal,
  })) {
    // Consume the model stream.
  }
  expect(JSON.stringify(calls[0]?.prompt)).toContain('"type":"file"');
  expect(JSON.stringify(calls[0]?.prompt)).toContain('image/png');
});

it('passes screenshot image content to the next model step', async () => {
  const calls: LanguageModelV3CallOptions[] = [];
  const screenshotWebPage = createTool({
    id: 'screenshot_web_page',
    description: 'Capture a page',
    inputSchema: z.object({ url: z.string() }),
    execute: async () => ({
      url: 'https://example.com/',
      content: [{ type: 'image', data: '/9j/', mimeType: 'image/jpeg' }],
    }),
  });

  const events: WaldenUIMessageChunk[] = [];
  for await (const event of streamMastraTurn({
    input: turnInput(),
    model: screenshotModel(calls),
    signal: new AbortController().signal,
    tools: { screenshotWebPage },
  }))
    events.push(event);

  expect(calls).toHaveLength(2);
  expect(JSON.stringify(calls[1]?.prompt)).toContain('"type":"image-data"');
  expect(JSON.stringify(calls[1]?.prompt)).toContain('image/jpeg');
  expect(JSON.stringify(calls[1]?.prompt)).toContain('/9j/');
  expect(events).toContainEqual({
    type: 'source-url',
    sourceId: 'screenshot-1:0',
    url: 'https://example.com/',
  });
});

it('allows fifteen sequential tool calls followed by a final answer', async () => {
  const calls: LanguageModelV3CallOptions[] = [];
  const model: LanguageModelV3 = {
    ...silentModel(calls),
    async doStream(options) {
      calls.push(options);
      const step = calls.length;
      const parts: LanguageModelV3StreamPart[] =
        step <= 15
          ? [
              {
                type: 'tool-call',
                toolCallId: `lookup-${step}`,
                toolName: 'lookup',
                input: '{}',
              },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage },
            ]
          : [
              { type: 'text-start', id: 'answer' },
              { type: 'text-delta', id: 'answer', delta: 'Research complete.' },
              { type: 'text-end', id: 'answer' },
              { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
            ];
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
  const lookup = createTool({
    id: 'lookup',
    description: 'Look up a fact',
    inputSchema: z.object({}),
    execute: async () => ({ result: 'found' }),
  });
  const events: WaldenUIMessageChunk[] = [];
  for await (const event of streamMastraTurn({
    input: turnInput(),
    model,
    signal: new AbortController().signal,
    tools: {
      lookup,
    },
  }))
    events.push(event);

  expect(calls).toHaveLength(16);
  expect(chunkText(events)).toBe('Research complete.');
  expect(events.filter((event) => event.type === 'tool-output-available')).toHaveLength(15);
});

describe('research tools in a Mastra turn', () => {
  it('shows a failed web lookup as failed and lets the model answer with its error', async () => {
    const events: WaldenUIMessageChunk[] = [];
    const calls: LanguageModelV3CallOptions[] = [];
    for await (const event of streamMastraTurn({
      input: { ...turnInput(), message: 'Explain the huggingface attack to me' },
      model: researchModel(calls, true),
      signal: new AbortController().signal,
      tools: {
        searchWeb: createTool({
          id: 'search_web',
          description: 'Search',
          inputSchema: z.object({ query: z.string() }),
          execute: async () => {
            throw new Error(
              'Web search is unavailable. Do not interpret this as no matching reports.',
            );
          },
        }),
      },
    }))
      events.push(event);
    expect(events).toContainEqual({
      type: 'tool-output-error',
      toolCallId: expect.any(String),
      errorText: 'Web search failed',
    });
    // The reply goes on, and the model sees why the search came back empty.
    expect(events.some((event) => event.type === 'text-delta')).toBe(true);
    expect(JSON.stringify(calls[1]?.prompt)).toContain('Web search is unavailable');
  });
  it('keeps the source usable but exposes failed search indexing', async () => {
    const controller = new AbortController();
    const fixture = researchTools(controller.signal);
    fixture.upload.mockRejectedValueOnce(new Error('Index unavailable'));
    const events = [];
    for await (const event of streamMastraTurn({
      input: turnInput(),
      model: researchModel([]),
      signal: controller.signal,
      tools: fixture.tools,
    }))
      events.push(event);
    expect(events).toContainEqual({
      type: 'tool-output-available',
      toolCallId: 'read-1',
      output: {
        sources: [{ url: 'https://example.com/research' }],
        summary: 'Read, but not saved to search',
      },
    });
    expect(events).toContainEqual({
      type: 'source-url',
      sourceId: 'read-1:0',
      url: 'https://example.com/research',
    });
  });
});

function screenshotModel(calls: LanguageModelV3CallOptions[]): LanguageModelV3 {
  let step = 0;
  return {
    ...silentModel(calls),
    async doStream(options) {
      calls.push(options);
      step += 1;
      const parts: LanguageModelV3StreamPart[] =
        step === 1
          ? [
              {
                type: 'tool-call',
                toolCallId: 'screenshot-1',
                toolName: 'screenshotWebPage',
                input: JSON.stringify({ url: 'https://example.com/' }),
              },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage },
            ]
          : [
              { type: 'text-start', id: 'answer' },
              { type: 'text-delta', id: 'answer', delta: 'I can see the page.' },
              { type: 'text-end', id: 'answer' },
              { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
            ];
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
}

function silentModel(calls: LanguageModelV3CallOptions[], text = 'Noted.'): LanguageModelV3 {
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
            controller.enqueue({ type: 'text-delta', id: 'a', delta: text });
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

async function systemPrompt(
  tools: Parameters<typeof streamMastraTurn>[0]['tools'],
): Promise<string> {
  const controller = new AbortController();
  const calls: LanguageModelV3CallOptions[] = [];
  for await (const _event of streamMastraTurn({
    input: turnInput(),
    model: silentModel(calls),
    signal: controller.signal,
    tools,
  }));
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
const liveAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const runLive = process.env.RUN_LIVE_RESEARCH === '1' && Boolean(liveToken && liveAccountId);

describe.skipIf(!runLive)('live Gemma research tool calling', () => {
  it('uses the synthetic reader and search index before citing their source', async () => {
    const controller = new AbortController();
    const fixture = researchTools(controller.signal);
    const model = createCloudflareModel(
      {
        CLOUDFLARE_ACCOUNT_ID: liveAccountId,
        CLOUDFLARE_API_TOKEN: liveToken,
      },
      DEFAULT_AI_MODEL,
    );
    const input = turnInput();
    input.message =
      'Use readWebPage on https://example.com/research, then use searchSources for "deterministic research result". Answer only from those tool results and cite the returned source URL.';

    const events = [];
    for await (const event of streamMastraTurn({
      input,
      model,
      signal: controller.signal,
      tools: fixture.tools,
    }))
      events.push(event);

    expect(fixture.quickAction).toHaveBeenCalledOnce();
    expect(fixture.search).toHaveBeenCalledOnce();
    expect(chunkText(events)).toMatch(/deterministic tests avoid external dependencies/i);
    expect(chunkText(events)).toContain('https://example.com/research');
  }, 90_000);
});

it('ends the model loop once a learning check is ready for the user', async () => {
  const input = turnInput();
  input.conversation.learningChecksEnabled = true;
  input.persona = DEFAULT_PERSONAS.find((p) => p.id === 'study-partner')!;
  input.message = 'Help me study photosynthesis';
  const calls: LanguageModelV3CallOptions[] = [];
  const events: WaldenUIMessageChunk[] = [];
  for await (const event of streamMastraTurn({
    input,
    model: researchModel(calls, false, true),
    signal: new AbortController().signal,
  }))
    events.push(event);
  expect(calls).toHaveLength(1);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'data-intervention',
      data: expect.objectContaining({
        kind: 'learning_check',
        questions: [
          expect.objectContaining({
            format: 'short_answer',
            question: 'What does chlorophyll absorb?',
          }),
        ],
      }),
    }),
  );
  expect(events.at(-1)?.type).toBe('data-intervention');
});

it.each(['study-partner', 'account-override'])(
  'turns a standalone %s multiple-choice reply into a learning check',
  async (personaId) => {
    const input = turnInput();
    input.conversation.learningChecksEnabled = true;
    input.persona = {
      ...DEFAULT_PERSONAS.find((persona) => persona.id === 'study-partner')!,
      id: personaId,
    };
    const events: WaldenUIMessageChunk[] = [];
    for await (const event of streamMastraTurn({
      input,
      model: silentModel(
        [],
        'Where does the Calvin cycle occur?\n\nA) Thylakoid membrane\nB) Stroma\nC) Lumen\nD) Outer membrane',
      ),
      signal: new AbortController().signal,
    }))
      events.push(event);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'data-intervention',
        data: expect.objectContaining({
          kind: 'learning_check',
          questions: [
            expect.objectContaining({
              format: 'multiple_choice',
              question: 'Where does the Calvin cycle occur?',
              options: ['Thylakoid membrane', 'Stroma', 'Lumen', 'Outer membrane'],
            }),
          ],
        }),
      }),
    );
    // The reply was only the quiz: the card replaces its text.
    expect(events.slice(-2).map(({ type }) => type)).toEqual([
      'data-intervention',
      'message-metadata',
    ]);
    expect(events.at(-1)).toMatchObject({ messageMetadata: { quizOnly: true } });
  },
);

it('turns an introduced, numbered multiple-choice reply into a learning-check card', async () => {
  const input = turnInput();
  input.conversation.learningChecksEnabled = true;
  input.persona = DEFAULT_PERSONAS.find((persona) => persona.id === 'study-partner')!;
  const events: WaldenUIMessageChunk[] = [];
  for await (const event of streamMastraTurn({
    input,
    model: silentModel(
      [],
      'Since you said "Sure," I will test your understanding.\n\nWhich stage of the Calvin cycle uses ATP and NADPH to turn 3-PGA into G3P?\n\n1. Carbon Fixation\n2. Reduction\n3. Regeneration',
    ),
    signal: new AbortController().signal,
  }))
    events.push(event);

  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'data-intervention',
      data: expect.objectContaining({
        kind: 'learning_check',
        questions: [
          expect.objectContaining({
            format: 'multiple_choice',
            question: 'Which stage of the Calvin cycle uses ATP and NADPH to turn 3-PGA into G3P?',
            options: ['Carbon Fixation', 'Reduction', 'Regeneration'],
          }),
        ],
      }),
    }),
  );
  // The reply was only the quiz: the card replaces its text.
  expect(events.slice(-2).map(({ type }) => type)).toEqual([
    'data-intervention',
    'message-metadata',
  ]);
  expect(events.at(-1)).toMatchObject({ messageMetadata: { quizOnly: true } });
});

it('recovers a short-answer card when Gemma calls the quiz tool with empty arguments then writes its question', async () => {
  const input = turnInput();
  input.conversation.learningChecksEnabled = true;
  input.persona = DEFAULT_PERSONAS.find((persona) => persona.id === 'study-partner')!;
  let step = 0;
  const model: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'empty-quiz-tool-args',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('This test expects streaming generation');
    },
    async doStream() {
      step += 1;
      const parts: LanguageModelV3StreamPart[] =
        step === 1
          ? [
              {
                type: 'tool-call',
                toolCallId: 'quiz-1',
                toolName: 'proposeLearningCheck',
                input: '{}',
              },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage },
            ]
          : [
              { type: 'text-start', id: 'question' },
              {
                type: 'text-delta',
                id: 'question',
                delta: 'What five-carbon sugar accepts CO2 in the Calvin cycle?',
              },
              { type: 'text-end', id: 'question' },
              { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
            ];
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
  const events: WaldenUIMessageChunk[] = [];
  for await (const event of streamMastraTurn({
    input,
    model,
    signal: new AbortController().signal,
  }))
    events.push(event);

  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'data-intervention',
      data: expect.objectContaining({
        kind: 'learning_check',
        questions: [
          expect.objectContaining({
            format: 'short_answer',
            question: 'What five-carbon sugar accepts CO2 in the Calvin cycle?',
          }),
        ],
      }),
    }),
  );
  expect(events).not.toContainEqual(
    expect.objectContaining({ type: 'tool-input-available', toolName: 'proposeLearningCheck' }),
  );
  // The reply was only the quiz: the card replaces its text.
  expect(events.slice(-2).map(({ type }) => type)).toEqual([
    'data-intervention',
    'message-metadata',
  ]);
  expect(events.at(-1)).toMatchObject({ messageMetadata: { quizOnly: true } });
});

it('removes web search from the model tools when disabled for the conversation', async () => {
  const calls: LanguageModelV3CallOptions[] = [];
  const input = turnInput();
  input.conversation.webSearchEnabled = false;
  const execute = vi.fn();
  for await (const _ of streamMastraTurn({
    input,
    model: silentModel(calls),
    signal: new AbortController().signal,
    tools: {
      searchWeb: createTool({
        id: 'search_web',
        description: 'Search',
        inputSchema: z.object({ query: z.string() }),
        execute,
      }),
    },
  })) {
  }
  expect(calls[0]?.tools?.some((tool) => tool.name === 'searchWeb')).toBe(false);
  expect(JSON.stringify(calls[0]?.prompt)).toContain('Web search is disabled');
  expect(execute).not.toHaveBeenCalled();
});

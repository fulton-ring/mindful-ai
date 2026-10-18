import { DEFAULT_PERSONAS, type Persona } from '@walden/contracts';
import { describe, expect, it } from 'vitest';
import {
  cloudflareModelSettings,
  createConfiguredModel,
  DEFAULT_AI_MODEL,
  modelNameForPersona,
  OPENROUTER_DEFAULT_MODEL,
} from '../agent';

describe('configured model provider', () => {
  it('defaults to GLM 5.3 Flash on Cloudflare', () => {
    expect(DEFAULT_AI_MODEL).toBe('@cf/zai-org/glm-5.3-flash');
    expect(modelNameForPersona({ AI: {} as Ai }, DEFAULT_PERSONAS[0]!)).toBe(DEFAULT_AI_MODEL);
    expect(
      modelNameForPersona(
        { AI: {} as Ai, AI_MODEL: DEFAULT_AI_MODEL },
        { ...DEFAULT_PERSONAS[0]!, model: '@cf/google/gemma-4-26b-a4b-it' },
      ),
    ).toBe('@cf/google/gemma-4-26b-a4b-it');
  });
  it('uses the OpenRouter-compatible endpoint when selected', () => {
    const model = createConfiguredModel(
      {
        AI_PROVIDER: 'openrouter',
        OPENROUTER_API_KEY: 'test-key',
      },
      OPENROUTER_DEFAULT_MODEL,
    );

    expect(model.provider).toBe('openrouter.chat');
    expect(model.modelId).toBe(OPENROUTER_DEFAULT_MODEL);
  });
  it('honors persona models for compatible and OpenRouter providers', () => {
    const persona = { ...DEFAULT_PERSONAS[0]!, model: 'custom-model' } as Persona;
    expect(
      modelNameForPersona({ AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'test' }, persona),
    ).toBe('custom-model');
    const env = {
      AI_PROVIDER: 'openai-compatible',
      AI_BASE_URL: 'http://localhost:1234/v1',
      AI_MODEL: 'default-model',
    };
    expect(modelNameForPersona(env, persona)).toBe('custom-model');
    expect(createConfiguredModel(env, 'custom-model').provider).toBe('openai-compatible.chat');
  });
  it('sends each Workers AI model only reasoning settings it accepts', () => {
    expect(cloudflareModelSettings('@cf/zai-org/glm-5.3-flash')).toEqual({
      reasoning_effort: 'low',
    });
    expect(cloudflareModelSettings('@cf/google/gemma-4-26b-a4b-it')).toMatchObject({
      chat_template_kwargs: { enable_thinking: false },
    });
    // Qwen 3.8 answers 400 to reasoning_effort 'high'.
    expect(cloudflareModelSettings('@cf/qwen/qwen3.8-27b')).toEqual({ reasoning_effort: 'low' });
  });
});

const toolStreamChunks = [
  {
    id: 'chat',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'local-model',
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call-1',
              type: 'function',
              function: { name: 'lookup', arguments: '{"query":' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: 'chat',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'local-model',
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: '"topic"}' } }] },
        finish_reason: null,
      },
    ],
  },
  {
    id: 'chat',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'local-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
  },
];

it('streams tool calls and sends structured JSON schemas through compatible chat completions', async () => {
  const { vi } = await import('vitest');
  const requests: Record<string, unknown>[] = [];

  const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    expect(String(url)).toBe('http://localhost:9999/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer instance-key');
    requests.push(JSON.parse(String(init?.body)));
    return new Response(
      `${toolStreamChunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  });
  vi.stubGlobal('fetch', fetch);
  try {
    const model = createConfiguredModel(
      {
        AI_PROVIDER: 'openai-compatible',
        AI_BASE_URL: 'http://localhost:9999/v1',
        AI_API_KEY: 'instance-key',
        AI_MODEL: 'local-model',
        AI_MODELS_JSON: JSON.stringify([{ id: 'local-model', supportsStructuredOutput: true }]),
      },
      'local-model',
    );
    const result = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Search' }] }],
      tools: [
        {
          type: 'function',
          name: 'lookup',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ],
      responseFormat: {
        type: 'json',
        schema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
        },
        name: 'Answer',
      },
    });
    const events = [];
    for await (const event of result.stream) events.push(event);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'lookup',
        input: '{"query":"topic"}',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'finish',
        finishReason: expect.objectContaining({ unified: 'tool-calls' }),
      }),
    );
    expect(requests[0]).toMatchObject({
      model: 'local-model',
      stream: true,
      tools: [{ type: 'function', function: { name: 'lookup' } }],
      response_format: { type: 'json_schema', json_schema: { name: 'Answer' } },
    });
    expect(requests[0]).not.toHaveProperty('reasoning_effort');
    expect(requests[0]).not.toHaveProperty('chat_template_kwargs');
  } finally {
    vi.unstubAllGlobals();
  }
});

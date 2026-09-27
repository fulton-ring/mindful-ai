import { SpanType, type TracingEvent } from '@mastra/core/observability';
import { DefaultObservabilityInstance } from '@mastra/observability';
import { describe, expect, it, vi } from 'vitest';
import {
  ContentPrivacyProcessor,
  captureChatFailure,
  createApiTelemetry,
  posthogExporterConfig,
  scrubTelemetrySpan,
  turnTracingOptions,
} from '../observability';

it('sends a bounded server failure event without prompt, response, or provider error text', async () => {
  const send = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', send);
  try {
    await captureChatFailure(
      { POSTHOG_API_KEY: 'phc_test' },
      {
        userId: 'user',
        conversationId: 'conversation',
        turnId: 'turn',
        code: 'provider_unavailable',
        model: '@cf/model',
        hadPartialResponse: true,
        toolCount: 2,
      },
    );
    const request = JSON.parse(send.mock.calls[0]?.[1]?.body as string);
    expect(request.event).toBe('chat_generation_failed');
    expect(request.properties).toMatchObject({
      failure_code: 'provider_unavailable',
      turn_id: 'turn',
      had_partial_response: true,
      tool_count: 2,
    });
    expect(JSON.stringify(request)).not.toContain('prompt');
    expect(JSON.stringify(request)).not.toContain('response_text');
  } finally {
    vi.unstubAllGlobals();
  }
});

describe('API telemetry configuration', () => {
  it('is disabled when no PostHog key is configured', () => {
    expect(createApiTelemetry({})).toBeNull();
  });

  it('keeps model content private by default', () => {
    expect(posthogExporterConfig({ POSTHOG_API_KEY: 'phc_test' })).toMatchObject({
      apiKey: 'phc_test',
      host: 'https://us.i.posthog.com',
      serverless: true,
      enablePrivacyMode: true,
    });
  });

  it('uses an explicitly configured US-compatible host without disabling privacy', () => {
    expect(
      posthogExporterConfig({
        POSTHOG_API_KEY: 'phc_test',
        POSTHOG_HOST: 'https://us.i.posthog.com',
      }),
    ).toMatchObject({
      host: 'https://us.i.posthog.com',
      enablePrivacyMode: true,
    });
  });
});

describe('API telemetry tracing metadata', () => {
  it('builds private tracing metadata from an allowlist', () => {
    expect(
      turnTracingOptions({
        userId: 'user_opaque',
        conversationId: 'conversation',
        turnId: 'turn',
        model: '@cf/model',
        operation: 'chat',
      }),
    ).toEqual({
      hideInput: true,
      hideOutput: true,
      metadata: {
        userId: 'user_opaque',
        sessionId: 'conversation',
        conversationId: 'conversation',
        turnId: 'turn',
        model: '@cf/model',
        operation: 'chat',
      },
      tags: ['chat'],
    });
  });
});

describe('API telemetry scrubbing', () => {
  it('scrubs content, request context, and raw errors before export', () => {
    expect(
      scrubTelemetrySpan({
        input: { prompt: 'private prompt' },
        output: { text: 'private answer' },
        requestContext: { authorization: 'secret' },
        metadata: {
          userId: 'user_opaque',
          sessionId: 'conversation',
          turnId: 'turn',
          ignored: 'private metadata',
        },
        errorInfo: { message: 'raw provider failure', name: 'ProviderError', stack: 'private' },
        attributes: {
          model: '@cf/model',
          provider: 'cloudflare',
          finishReason: 'stop',
          toolName: 'proposeRecord',
          usage: {
            inputTokens: 12,
            outputTokens: 7,
            inputDetails: { text: 10, cacheRead: 2, injected: 'private' },
            outputDetails: { text: 6, reasoning: 1 },
          },
          toolInput: { note: 'private note' },
          messages: [{ content: 'private prompt' }],
          tools: [{ parameters: { secret: 'private schema' } }],
          parameters: { headers: { authorization: 'secret' } },
          reasoning: 'private reasoning',
        },
      }),
    ).toEqual({
      input: undefined,
      output: undefined,
      requestContext: undefined,
      metadata: { userId: 'user_opaque', sessionId: 'conversation', turnId: 'turn' },
      errorInfo: { message: 'Operation failed', name: 'ProviderError' },
      attributes: {
        model: '@cf/model',
        provider: 'cloudflare',
        finishReason: 'stop',
        toolName: 'proposeRecord',
        usage: {
          inputTokens: 12,
          outputTokens: 7,
          inputDetails: { text: 10, cacheRead: 2 },
          outputDetails: { text: 6, reasoning: 1 },
        },
      },
    });
  });
});

describe('API telemetry lifecycle', () => {
  it('preserves the live span lifecycle while exporting scrubbed events', async () => {
    const events: TracingEvent[] = [];
    const instance = new DefaultObservabilityInstance({
      name: 'test',
      serviceName: 'test',
      exporters: [
        {
          name: 'capture',
          onTracingEvent(event) {
            events.push(event);
          },
          async exportTracingEvent() {},
          async flush() {},
          async shutdown() {},
        },
      ],
      spanOutputProcessors: [new ContentPrivacyProcessor()],
    });
    const span = instance.startSpan({
      type: SpanType.MODEL_GENERATION,
      name: 'test-generation',
      input: { messages: [{ role: 'user', content: 'private prompt' }] },
      attributes: {
        model: '@cf/model',
        provider: 'cloudflare',
        tools: [{ type: 'function', name: 'private-tool', parameters: { secret: 'private' } }],
      },
      tracingOptions: {
        metadata: { userId: 'opaque', ignored: 'private metadata' },
      },
    });

    expect(typeof span.exportSpan).toBe('function');
    span.end({
      output: { text: 'private answer' },
      attributes: {
        usage: { inputTokens: 4, outputTokens: 2 },
        finishReason: 'stop',
      },
    });
    await instance.flush();

    const ended = events.find((event) => event.type === 'span_ended');
    expect(ended && 'exportedSpan' in ended ? ended.exportedSpan : undefined).toMatchObject({
      input: undefined,
      output: undefined,
      metadata: { userId: 'opaque' },
      attributes: {
        model: '@cf/model',
        provider: 'cloudflare',
        finishReason: 'stop',
        usage: { inputTokens: 4, outputTokens: 2 },
      },
    });
    await instance.shutdown();
  });
});

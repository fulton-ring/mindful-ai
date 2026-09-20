import type { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import type { AnySpan, SpanOutputProcessor, TracingOptions } from '@mastra/core/observability';
import { Observability } from '@mastra/observability';
import { PosthogExporter, type PosthogExporterConfig } from '@mastra/posthog';

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';
const FLUSH_TIMEOUT_MS = 1_500;
const ALLOWED_METADATA = [
  'userId',
  'sessionId',
  'conversationId',
  'turnId',
  'model',
  'operation',
] as const;
const USAGE_TOTAL_KEYS = ['inputTokens', 'outputTokens'] as const;
const INPUT_DETAIL_KEYS = [
  'text',
  'cacheRead',
  'cacheWrite',
  'cacheWrite5m',
  'cacheWrite1h',
  'audio',
  'image',
] as const;
const OUTPUT_DETAIL_KEYS = ['text', 'reasoning', 'audio', 'image'] as const;

type TelemetryEnv = {
  POSTHOG_API_KEY?: string;
  POSTHOG_HOST?: string;
};

export type TurnTraceMetadata = {
  userId: string;
  conversationId: string;
  turnId: string;
  model: string;
  operation: 'chat' | 'annotation' | 'note_proposal';
};

export function turnTracingOptions(metadata: TurnTraceMetadata): TracingOptions {
  return {
    hideInput: true,
    hideOutput: true,
    metadata: {
      userId: metadata.userId,
      sessionId: metadata.conversationId,
      conversationId: metadata.conversationId,
      turnId: metadata.turnId,
      model: metadata.model,
      operation: metadata.operation,
    },
    tags: [metadata.operation],
  };
}

export function posthogExporterConfig(env: TelemetryEnv): PosthogExporterConfig | null {
  if (!env.POSTHOG_API_KEY) return null;
  return {
    apiKey: env.POSTHOG_API_KEY,
    host: env.POSTHOG_HOST || DEFAULT_POSTHOG_HOST,
    serverless: true,
    enablePrivacyMode: true,
    logLevel: 'error',
  };
}

export function scrubTelemetrySpan<
  T extends {
    input?: unknown;
    output?: unknown;
    requestContext?: unknown;
    metadata?: Record<string, unknown>;
    errorInfo?: { name?: string };
    attributes?: object;
  },
>(span: T): T {
  const metadata = Object.fromEntries(
    ALLOWED_METADATA.flatMap((key) =>
      span.metadata?.[key] === undefined ? [] : [[key, span.metadata[key]]],
    ),
  );
  const numericFields = (value: unknown, keys: readonly string[]) =>
    typeof value === 'object' && value !== null
      ? Object.fromEntries(
          keys.flatMap((key) => {
            const candidate = (value as Record<string, unknown>)[key];
            return typeof candidate === 'number' && Number.isFinite(candidate)
              ? [[key, candidate]]
              : [];
          }),
        )
      : {};
  const usage = (value: unknown) => {
    if (typeof value !== 'object' || value === null) return undefined;
    const record = value as Record<string, unknown>;
    const clean = {
      ...numericFields(record, USAGE_TOTAL_KEYS),
      ...(Object.keys(numericFields(record.inputDetails, INPUT_DETAIL_KEYS)).length
        ? { inputDetails: numericFields(record.inputDetails, INPUT_DETAIL_KEYS) }
        : {}),
      ...(Object.keys(numericFields(record.outputDetails, OUTPUT_DETAIL_KEYS)).length
        ? { outputDetails: numericFields(record.outputDetails, OUTPUT_DETAIL_KEYS) }
        : {}),
    };
    return Object.keys(clean).length ? clean : undefined;
  };
  const sourceAttributes = (span.attributes ?? {}) as Record<string, unknown>;
  const attributes: Record<string, unknown> = Object.fromEntries(
    ['model', 'provider', 'finishReason', 'toolName'].flatMap((key) =>
      typeof sourceAttributes[key] === 'string' ? [[key, sourceAttributes[key]]] : [],
    ),
  );
  for (const key of ['usage', 'internalUsage'] as const) {
    const cleanUsage = usage(sourceAttributes[key]);
    if (cleanUsage) attributes[key] = cleanUsage;
  }
  return {
    ...span,
    input: undefined,
    output: undefined,
    requestContext: undefined,
    metadata,
    attributes,
    ...(span.errorInfo
      ? {
          errorInfo: {
            message: 'Operation failed',
            ...(span.errorInfo.name ? { name: span.errorInfo.name } : {}),
          },
        }
      : {}),
  } as unknown as T;
}

export class ContentPrivacyProcessor implements SpanOutputProcessor {
  readonly name = 'walden-content-privacy';

  process(span?: AnySpan): AnySpan | undefined {
    if (!span) return undefined;
    const scrubbed = scrubTelemetrySpan(span);
    Object.assign(span, {
      input: scrubbed.input,
      output: scrubbed.output,
      requestContext: scrubbed.requestContext,
      metadata: scrubbed.metadata,
      attributes: scrubbed.attributes,
      errorInfo: scrubbed.errorInfo,
    });
    return span;
  }

  async shutdown(): Promise<void> {}
}

export type ApiTelemetry = {
  registerAgent(agent: Agent): void;
  tracingOptions(metadata: TurnTraceMetadata): TracingOptions;
  flush(): Promise<void>;
};

export function createApiTelemetry(env: TelemetryEnv): ApiTelemetry | null {
  const exporterConfig = posthogExporterConfig(env);
  if (!exporterConfig) return null;
  try {
    const observability = new Observability({
      configs: {
        posthog: {
          serviceName: 'walden-api',
          exporters: [new PosthogExporter(exporterConfig)],
          spanOutputProcessors: [new ContentPrivacyProcessor()],
        },
      },
    });
    const mastra = new Mastra({ observability });
    return {
      registerAgent(agent) {
        try {
          mastra.addAgent(agent);
        } catch {
          console.warn('Telemetry agent registration failed');
        }
      },
      tracingOptions: turnTracingOptions,
      async flush() {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            observability.shutdown(),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
            }),
          ]);
        } catch {
          console.warn('Telemetry flush failed');
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
    };
  } catch {
    console.warn('Telemetry initialization failed');
    return null;
  }
}

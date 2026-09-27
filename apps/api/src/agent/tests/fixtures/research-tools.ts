import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';
import { DEFAULT_PERSONAS, type WaldenUIMessageChunk } from '@walden/contracts';
import { vi } from 'vitest';

import { createResearchTools, type ResearchEnv } from '../../../services/research/research';
import type { AgentTurnInput } from '../../../services/types';

export const usage: LanguageModelV3Usage = {
  inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

export function researchModel(
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
                  ? {
                      questions: [
                        {
                          id: 'chlorophyll_light',
                          header: 'Chlorophyll',
                          question: 'What does chlorophyll absorb?',
                        },
                      ],
                    }
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

export function researchTools(signal: AbortSignal) {
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

export const turnInput = (): AgentTurnInput => ({
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

/** The visible text a chunk stream spells out. */
export const chunkText = (chunks: WaldenUIMessageChunk[]) =>
  chunks.map((chunk) => (chunk.type === 'text-delta' ? chunk.delta : '')).join('');

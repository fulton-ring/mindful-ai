import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import { Agent } from '@mastra/core/agent';
import { createDurableAgent, createEventedAgent } from '@mastra/core/agent/durable';
import { Mastra } from '@mastra/core/mastra';
import { ToolCallFilter } from '@mastra/core/processors';
import { createTool } from '@mastra/core/tools';
import type { WaldenUIMessageChunk } from '@walden/contracts';
import { expect, it } from 'vitest';
import { contextBudgetProcessor } from '../../src/agent/context';
import { TurnProposals } from '../../src/agent/interventions';
import { learningCheckIntervention } from '../../src/agent/learning-checks';
import { streamMastraTurn } from '../../src/agent/mastra-turn';
import {
  chunkText,
  researchModel,
  researchTools,
  turnInput,
  usage,
} from '../../src/agent/tests/fixtures/research-tools';
import { learningCheckInputSchema } from '../../src/agent/tool-schemas';
import { agentUIChunks, newUIStreamState } from '../../src/agent/ui-stream';

async function collect(stream: AsyncIterable<WaldenUIMessageChunk>) {
  const chunks: WaldenUIMessageChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function textModel(
  calls: LanguageModelV3CallOptions[],
  reason: 'length' | 'stop' = 'stop',
): LanguageModelV3 {
  return {
    ...researchModel([]),
    async doStream(options) {
      calls.push(options);
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'answer' });
            controller.enqueue({ type: 'text-delta', id: 'answer', delta: 'Partial' });
            controller.enqueue({ type: 'text-end', id: 'answer' });
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: reason, raw: reason },
              usage,
            });
            controller.close();
          },
        }),
      };
    },
  };
}

it('passes a valid PNG attachment through the unchanged application agent path', async () => {
  const calls: LanguageModelV3CallOptions[] = [];
  const bytes = Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGmQAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  await collect(
    streamMastraTurn({
      input: {
        ...turnInput(),
        attachments: [
          {
            id: crypto.randomUUID(),
            name: 'pixel.png',
            mimeType: 'image/png',
            size: bytes.length,
            bytes,
          },
        ],
      },
      signal: new AbortController().signal,
      model: textModel(calls),
    }),
  );
  expect(JSON.stringify(calls[0]?.prompt)).toContain('"type":"file"');
  expect(JSON.stringify(calls[0]?.prompt)).toContain('image/png');
  expect(JSON.stringify(calls[0]?.prompt)).not.toContain('Attachment unavailable');
});

for (const [kind, wrap] of [
  ['durable', createDurableAgent],
  ['evented', createEventedAgent],
] as const) {
  it(`${kind}: preserves research text, tool progress and public sources through the existing converter`, async () => {
    const signal = new AbortController().signal;
    const baselineTools = researchTools(signal);
    const baseline = await collect(
      streamMastraTurn({
        input: turnInput(),
        signal,
        model: researchModel([]),
        tools: baselineTools.tools,
      }),
    );
    const nativeTools = researchTools(signal);
    const agent = wrap({
      agent: new Agent({
        id: `compat-${kind}`,
        name: 'Compatibility fixture',
        instructions: 'Read and search the source, then cite the answer.',
        model: researchModel([]),
        tools: nativeTools.tools,
        inputProcessors: [
          new ToolCallFilter({ filterAfterToolSteps: 4 }),
          contextBudgetProcessor(),
        ],
      }),
    });
    const mastra = new Mastra({ agents: { fixture: agent }, logger: false });
    const result = await agent.stream(turnInput().message, {
      maxSteps: 16,
      toolCallConcurrency: 1,
    });
    try {
      const native = await collect(
        agentUIChunks(result.output.fullStream, 'turn-1', newUIStreamState(), () => {}),
      );
      expect(chunkText(native)).toBe(chunkText(baseline));
      for (const type of [
        'source-url',
        'tool-input-available',
        'tool-output-available',
        'data-status',
      ]) {
        expect(native.filter((chunk) => chunk.type === type)).toEqual(
          baseline.filter((chunk) => chunk.type === type),
        );
      }
      expect(native.some((chunk) => chunk.type === 'source-url')).toBe(true);
      expect(nativeTools.quickAction).toHaveBeenCalledOnce();
      expect(nativeTools.search).toHaveBeenCalledOnce();
      const publicResults = native.filter((chunk) => chunk.type === 'tool-output-available');
      expect(JSON.stringify(publicResults)).not.toContain(
        'Deterministic tests avoid external dependencies.',
      );
    } finally {
      result.cleanup();
      await mastra.shutdown({ drainTimeout: 100 });
    }
  });

  it(`${kind}: preserves length-limited finish classification`, async () => {
    const model = textModel([], 'length');
    const agent = wrap({
      agent: new Agent({
        id: `length-${kind}`,
        name: 'Length fixture',
        instructions: 'Answer.',
        model,
      }),
    });
    const mastra = new Mastra({ agents: { fixture: agent }, logger: false });
    const result = await agent.stream('Answer', { maxSteps: 1 });
    const state = newUIStreamState();
    try {
      const chunks = await collect(
        agentUIChunks(result.output.fullStream, 'turn-1', state, () => {}),
      );
      expect(chunkText(chunks)).toBe('Partial');
      expect(state.lengthLimited).toBe(true);
    } finally {
      result.cleanup();
      await mastra.shutdown({ drainTimeout: 100 });
    }
  });

  it(`${kind}: preserves the learning-check stop condition and structured intervention`, async () => {
    const input = turnInput();
    input.conversation.learningChecksEnabled = true;
    const baseline = await collect(
      streamMastraTurn({
        input,
        signal: new AbortController().signal,
        model: researchModel([], false, true),
      }),
    );
    const calls: LanguageModelV3CallOptions[] = [];
    const proposals = new TurnProposals();
    const agent = wrap({
      agent: new Agent({
        id: `learning-${kind}`,
        name: 'Learning fixture',
        instructions: 'Propose a learning check.',
        model: researchModel(calls, false, true),
        tools: {
          proposeLearningCheck: createTool({
            id: 'propose_learning_check',
            description: 'Request a learning check',
            inputSchema: learningCheckInputSchema,
            execute: async (args) =>
              proposals.propose(learningCheckIntervention(args, input.turnId)),
          }),
        },
      }),
    });
    const mastra = new Mastra({ agents: { fixture: agent }, logger: false });
    const result = await agent.stream(input.message, {
      maxSteps: 16,
      toolCallConcurrency: 1,
      stopWhen: () => proposals.drain().intervention?.kind === 'learning_check',
    });
    try {
      const native = await collect(
        agentUIChunks(result.output.fullStream, input.turnId, newUIStreamState(), () => {}),
      );
      const intervention = proposals.drain().intervention;
      expect(calls).toHaveLength(1);
      expect(intervention).toBeDefined();
      expect({ type: 'data-intervention', id: intervention?.id, data: intervention }).toEqual(
        baseline.find((chunk) => chunk.type === 'data-intervention'),
      );
      expect(chunkText(native)).toBe(chunkText(baseline));
    } finally {
      result.cleanup();
      await mastra.shutdown({ drainTimeout: 100 });
    }
  });
}

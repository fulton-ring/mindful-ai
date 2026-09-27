import type { LanguageModelV3CallOptions } from '@ai-sdk/provider';
import type { WaldenUIMessageChunk } from '@walden/contracts';
import { expect, it } from 'vitest';
import { streamMastraTurn } from '../../mastra-turn';
import { chunkText, researchModel, researchTools, turnInput } from '../fixtures/research-tools';

async function collectResearchSequence() {
  const controller = new AbortController();
  const calls: LanguageModelV3CallOptions[] = [];
  const fixture = researchTools(controller.signal);
  const events: WaldenUIMessageChunk[] = [];
  for await (const event of streamMastraTurn({
    input: turnInput(),
    model: researchModel(calls),
    signal: controller.signal,
    tools: fixture.tools,
  }))
    events.push(event);
  return { calls, events };
}

it('reads, searches, exposes tool results to later model steps, and returns a cited answer', async () => {
  const { calls, events } = await collectResearchSequence();

  expect(calls).toHaveLength(3);
  expect(events).toContainEqual({
    type: 'tool-input-available',
    toolCallId: 'search-1',
    toolName: 'searchSources',
    input: { query: 'deterministic research result' },
  });
  expect(events).toContainEqual({
    type: 'tool-output-available',
    toolCallId: 'search-1',
    output: { sources: [expect.objectContaining({ url: 'https://example.com/research' })] },
  });
  expect(JSON.stringify(calls[1]?.prompt)).toContain(
    'Deterministic tests avoid external dependencies.',
  );
  expect(JSON.stringify(calls[2]?.prompt)).toContain('https://example.com/research');
  expect(events).toEqual(
    expect.arrayContaining([
      { type: 'data-status', data: { text: 'Reading source…' }, transient: true },
      { type: 'data-status', data: { text: 'Searching sources…' }, transient: true },
      { type: 'tool-input-available', toolCallId: 'read-1', toolName: 'readWebPage', input: {} },
      {
        type: 'tool-output-available',
        toolCallId: 'read-1',
        output: { sources: [{ url: 'https://example.com/research' }] },
      },
      { type: 'source-url', sourceId: 'read-1:0', url: 'https://example.com/research' },
    ]),
  );
  // Tool parts carry only public queries and sources, never raw results.
  expect(JSON.stringify(events.filter((event) => event.type.startsWith('tool-')))).not.toContain(
    'Deterministic tests avoid external dependencies.',
  );
  expect(chunkText(events)).toContain('[Example research](https://example.com/research)');
  expect(events.filter((event) => event.type === 'source-url')).toEqual([
    { type: 'source-url', sourceId: 'read-1:0', url: 'https://example.com/research' },
    {
      type: 'source-url',
      sourceId: 'native-source',
      url: 'https://docs.example.com/native',
      title: 'Native source',
    },
  ]);
  const tools = events.filter((event) => event.type === 'tool-output-available');
  expect(tools.map((event) => event.toolCallId)).toEqual(['read-1', 'search-1']);
});

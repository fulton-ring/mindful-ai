import type { LanguageModelV3CallOptions } from '@ai-sdk/provider';
import { expect, it } from 'vitest';

import { streamMastraTurn } from '../../index';
import { researchModel, researchTools, turnInput } from '../fixtures/research-tools';

async function collectResearchSequence() {
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
  return { calls, events };
}

it('reads, searches, exposes tool results to later model steps, and returns a cited answer', async () => {
  const { calls, events } = await collectResearchSequence();

  expect(calls).toHaveLength(3);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'tool',
      tool: expect.objectContaining({
        name: 'searchSources',
        query: 'deterministic research result',
        state: 'complete',
        sources: [expect.objectContaining({ url: 'https://example.com/research' })],
      }),
    }),
  );
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
          sources: [{ id: 'read-1:0', url: 'https://example.com/research' }],
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

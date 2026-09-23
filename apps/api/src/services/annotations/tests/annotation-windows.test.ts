import type { AnnotationEvent, ChatEvent } from '@walden/contracts';
import { describe, expect, it } from 'vitest';
import { streamWithEarlyAnnotations } from '../early-annotations';

// Long enough that a single 1200-char pass cannot reach the end.
const paragraph = (index: number) =>
  `Paragraph ${index} explains a distinct mechanism in enough words that it comfortably exceeds the minimum window size on its own, and it ends with a clear sentence boundary right here.`;
const chunks = Array.from({ length: 8 }, (_, index) => `${paragraph(index)}\n\n`);
const fullText = chunks.join('');

const done = (content: string): ChatEvent => ({
  type: 'done',
  message: {
    id: 'assistant-1',
    role: 'assistant',
    content,
    createdAt: '2026-09-18T12:00:00.000Z',
  },
  conversationId: 'conversation-1',
  branchId: 'branch-1',
  title: 'Long answer',
  expiresAt: '2999-01-01T00:00:00.000Z',
});

async function collect(stream: AsyncIterable<ChatEvent>) {
  const events: ChatEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('annotation windows', () => {
  it('classifies a long reply in successive windows and needs no client sweep', async () => {
    const classified: string[] = [];
    const primary = (async function* () {
      for (const chunk of chunks) yield { type: 'text', text: chunk } as ChatEvent;
      yield done(fullText);
    })();

    const classify = async (segment: string): Promise<AsyncIterable<AnnotationEvent>> => {
      classified.push(segment);
      return (async function* () {
        yield { type: 'done', annotations: [] } satisfies AnnotationEvent;
      })();
    };

    const events = await collect(streamWithEarlyAnnotations(primary, classify));
    const final = events.at(-1);
    if (final?.type !== 'done') throw new Error('Expected done event');

    // More than one pass, and every character reached a classifier exactly once.
    expect(classified.length).toBeGreaterThan(1);
    expect(classified.join('')).toBe(fullText);
    // Fully covered, so the client does not need a post-completion round trip.
    expect(final.annotationsHandled).toBe(true);
  });

  it('reports unhandled when a window fails so the client still sweeps', async () => {
    const primary = (async function* () {
      for (const chunk of chunks) yield { type: 'text', text: chunk } as ChatEvent;
      yield done(fullText);
    })();
    const classify = async (): Promise<AsyncIterable<AnnotationEvent>> => {
      throw new Error('classifier unavailable');
    };

    const events = await collect(streamWithEarlyAnnotations(primary, classify));
    const final = events.at(-1);
    if (final?.type !== 'done') throw new Error('Expected done event');
    expect(final.annotationsHandled).toBe(false);
  });
});

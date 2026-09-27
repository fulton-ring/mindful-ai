import type { Annotation, AnnotationEvent, Message } from '@walden/contracts';
import { nowIso } from '../../http';
import { mergeAnnotationsPreservingExisting } from '../../services/annotations/annotations';
import type { AgentService, AgentTurnInput } from '../../services/types';
import { agentHighlightStatements } from '../highlights/agent-highlights';
import { createBackgroundSseStream } from '../sse';

type AnnotationGeneration = {
  db: D1Database;
  ownerId: string;
  input: AgentTurnInput;
  assistantMessage: Message;
  agent: AgentService;
};

type AnnotationStream = AnnotationGeneration & {
  requestSignal: AbortSignal;
  waitUntil(task: Promise<void>): void;
};

export class AnnotationGenerationError extends Error {}

async function persistAnnotations(
  { db, ownerId, assistantMessage }: AnnotationGeneration,
  annotations: Annotation[],
) {
  await db.batch(
    agentHighlightStatements(db, {
      messageId: assistantMessage.id,
      ownerId,
      content: assistantMessage.content,
      annotations,
      updatedAt: nowIso(),
    }),
  );
}

export async function generateAnnotations(
  generation: AnnotationGeneration,
  signal: AbortSignal,
): Promise<Annotation[]> {
  const { agent, input, assistantMessage } = generation;
  let additions: Annotation[];
  try {
    additions = await agent.annotateTurn(input, assistantMessage, signal);
  } catch {
    throw new AnnotationGenerationError();
  }
  const annotations = mergeAnnotationsPreservingExisting(
    assistantMessage.annotations ?? [],
    additions,
    assistantMessage.content,
  );
  await persistAnnotations(generation, annotations);
  return annotations;
}

function mergeStreamedAnnotation(
  provisional: Annotation[],
  event: Extract<AnnotationEvent, { type: 'annotation' }>,
  content: string,
) {
  const merged = mergeAnnotationsPreservingExisting(provisional, [event.annotation], content);
  return merged.some(({ id }) => id === event.annotation.id) ? merged : null;
}

async function runAnnotationStream(
  generation: AnnotationGeneration,
  signal: AbortSignal,
  emit: (event: AnnotationEvent) => void,
) {
  const { agent, input, assistantMessage } = generation;
  let provisional = assistantMessage.annotations ?? [];
  const events = await agent.streamAnnotations(input, assistantMessage, signal);
  for await (const event of events) {
    if (signal.aborted) return;
    if (event.type === 'annotation') {
      const merged = mergeStreamedAnnotation(provisional, event, assistantMessage.content);
      if (!merged) continue;
      provisional = merged;
      emit(event);
      continue;
    }
    if (event.type === 'error') {
      emit(event);
      continue;
    }
    const annotations = mergeAnnotationsPreservingExisting(
      provisional,
      event.annotations,
      assistantMessage.content,
    );
    await persistAnnotations(generation, annotations);
    emit({ type: 'done', annotations });
    return;
  }
}

export function createAnnotationStream(generation: AnnotationStream): ReadableStream<Uint8Array> {
  return createBackgroundSseStream<AnnotationEvent>({
    requestSignal: generation.requestSignal,
    waitUntil: generation.waitUntil,
    errorEvent: { type: 'error', message: 'Highlights could not be generated. Please try again.' },
    run: (signal, emit) => runAnnotationStream(generation, signal, emit),
  });
}

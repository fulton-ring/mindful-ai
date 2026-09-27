import type { Annotation, AnnotationEvent, ChatEvent } from '@walden/contracts';
import { mergeAnnotationsPreservingExisting } from './annotations';

/** Finish every annotation operation before the Workflow can commit its terminal event. */
export async function* streamWithDurableAnnotations(
  primary: AsyncIterable<ChatEvent>,
  classify: (
    text: string,
    signal: AbortSignal,
  ) => AsyncIterable<AnnotationEvent> | Promise<AsyncIterable<AnnotationEvent>>,
  signal?: AbortSignal,
): AsyncIterable<ChatEvent> {
  let done: Extract<ChatEvent, { type: 'done' }> | undefined;
  for await (const event of primary) {
    if (event.type === 'done') done = event;
    else yield event;
  }
  if (!done) return;
  signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(25_000);
  const annotationSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const annotations: Annotation[] = [...(done.message.annotations ?? [])];
  let handled = false;
  try {
    for await (const event of await classify(done.message.content, annotationSignal)) {
      if (event.type === 'annotation') {
        annotations.push(event.annotation);
        yield event;
      } else if (event.type === 'done') {
        annotations.push(...event.annotations);
        handled = true;
      }
    }
  } catch {
    // Annotation failures leave the completed answer usable and permit a later retry.
    handled = false;
    signal?.throwIfAborted();
  }
  signal?.throwIfAborted();
  yield {
    ...done,
    annotationsHandled: handled,
    message: {
      ...done.message,
      annotations: mergeAnnotationsPreservingExisting([], annotations, done.message.content),
    },
  };
}

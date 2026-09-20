import type { AnnotationEvent, Note, NoteProposalEvent } from '@walden/contracts';
import { resolveEdit } from '@walden/domain';
import { Hono } from 'hono';
import { z } from 'zod';
import { first, parseJson } from '../db/client';
import { HttpError, jsonBody, newId, nowIso } from '../http';
import { loadNoteState } from '../notes/history';
import {
  cancelNoteSuggestionAttempt,
  loadNoteSuggestionBatch,
  loadNoteSuggestionBySource,
  loadPendingNoteSuggestions,
  persistNoteSuggestion,
} from '../notes/suggestions';
import { createAgentService } from '../services/agent';
import {
  annotationBudget,
  mergeAnnotationsPreservingExisting,
} from '../services/early-annotations';
import type { AgentTurnInput } from '../services/types';
import type { Bindings, Variables } from '../types';
import { agentHighlightStatements } from './agent-highlights';
import { loadConversation } from './conversations';
import { personaFor } from './routes';

const requestSchema = z
  .object({
    conversationId: z.string().min(1),
    branchId: z.string().min(1),
    personaId: z.string(),
    noteRevision: z.number().int().nonnegative().nullable(),
    noteProposalRequested: z.boolean().optional(),
    action: z.literal('capture').optional(),
    captureText: z.string().min(1).max(20_000).optional(),
  })
  .superRefine((value, context) => {
    if ((value.action === 'capture') !== (typeof value.captureText === 'string'))
      context.addIssue({
        code: 'custom',
        message: 'Capture action and text must be supplied together',
      });
  });

export async function loadNote(
  db: D1Database,
  ownerId: string,
  id: string | null,
  title: string,
): Promise<Note | null> {
  if (!id) return null;
  const row = await first<{
    id: string;
    markdown: string;
    revision: number;
    provenance_json: string;
    created_at: string;
    updated_at: string;
  }>(
    db
      .prepare(
        'SELECT id,markdown,revision,provenance_json,created_at,updated_at FROM notes WHERE id=? AND owner_id=?',
      )
      .bind(id, ownerId),
  );
  if (!row) throw new HttpError(404, 'Note not found');
  return {
    id: row.id,
    title,
    markdown: row.markdown,
    revision: row.revision,
    provenance: parseJson(row.provenance_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function removeCancelledPendingSuggestion(
  db: D1Database,
  input: {
    id: string;
    ownerId: string;
    conversationId: string;
    sourceMessageId: string;
  },
) {
  await db
    .prepare(
      `DELETE FROM note_suggestions
       WHERE id=? AND owner_id=? AND conversation_id=? AND source_message_id=? AND status='pending'`,
    )
    .bind(input.id, input.ownerId, input.conversationId, input.sourceMessageId)
    .run();
}

export const followupRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();
followupRoutes.post('/messages/:messageId/note-proposal/cancel', async (c) => {
  const parsed = z
    .object({
      conversationId: z.string().min(1),
      branchId: z.string().min(1),
      attemptId: z.string().min(1).max(200),
    })
    .safeParse(await jsonBody(c));
  if (!parsed.success) throw new HttpError(400, 'Invalid cancellation request');
  const ownerId = c.get('userId');
  const result = await cancelNoteSuggestionAttempt(c.env.DB, {
    ownerId,
    conversationId: parsed.data.conversationId,
    branchId: parsed.data.branchId,
    sourceMessageId: c.req.param('messageId'),
    attemptId: parsed.data.attemptId,
  });
  return c.json({
    cancelledSuggestionIds: result.cancelledSuggestionIds,
    noteState: result.noteId ? await loadNoteState(c.env.DB, ownerId, result.noteId) : null,
  });
});
followupRoutes.post('/messages/:messageId/:operation', async (c) => {
  const operation = c.req.param('operation');
  if (operation !== 'annotations' && operation !== 'note-proposal')
    throw new HttpError(404, 'Not found');
  const parsed = requestSchema.safeParse(await jsonBody(c));
  if (!parsed.success) throw new HttpError(400, 'Invalid follow-up request');
  const ownerId = c.get('userId');
  const conversation = await loadConversation(c.env.DB, ownerId, parsed.data.conversationId, {
    branchId: parsed.data.branchId,
  });
  if (conversation.expiresAt <= nowIso()) throw new HttpError(410, 'Conversation expired');
  const index = conversation.messages.findIndex(
    (message) => message.id === c.req.param('messageId'),
  );
  const assistantMessage = conversation.messages[index];
  if (!assistantMessage || assistantMessage.role !== 'assistant' || assistantMessage.incomplete)
    throw new HttpError(404, 'Completed response not found');
  const generationKey =
    parsed.data.action === 'capture'
      ? `${assistantMessage.id}:capture:${Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(parsed.data.captureText),
            ),
          ),
          (byte) => byte.toString(16).padStart(2, '0'),
        ).join('')}`
      : assistantMessage.id;
  if (
    operation === 'annotations' &&
    (assistantMessage.annotations?.length ?? 0) >= annotationBudget(assistantMessage.content)
  ) {
    const annotations = assistantMessage.annotations ?? [];
    if (c.req.query('stream') === '1')
      return new Response(
        `data: ${JSON.stringify({ type: 'done', annotations } satisfies AnnotationEvent)}\n\n`,
        {
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            'x-accel-buffering': 'no',
          },
        },
      );
    return c.json({ annotations });
  }
  if (operation === 'note-proposal') {
    const suggestionLookup = {
      ownerId,
      conversationId: conversation.id,
      branchId: conversation.branchId,
      sourceMessageId: assistantMessage.id,
      generationKey,
    };
    const storedBatch =
      parsed.data.action === 'capture'
        ? [await loadNoteSuggestionBySource(c.env.DB, suggestionLookup)].filter(
            (suggestion) => suggestion !== null,
          )
        : await loadNoteSuggestionBatch(c.env.DB, suggestionLookup);
    const pending = storedBatch.filter((suggestion) => suggestion.status === 'pending');
    if (storedBatch.length && (pending.length || !parsed.data.noteProposalRequested)) {
      const event: NoteProposalEvent = {
        type: 'done',
        proposal: pending.at(-1) ?? null,
        ...(parsed.data.action === 'capture' ? {} : { proposals: pending }),
      };
      return new Response(`data: ${JSON.stringify(event)}\n\n`, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          'x-accel-buffering': 'no',
        },
      });
    }
  }
  const userMessage = conversation.messages[index - 1];
  if (!userMessage || userMessage.role !== 'user')
    throw new HttpError(409, 'Response context unavailable');
  const note =
    operation === 'note-proposal'
      ? await loadNote(c.env.DB, ownerId, conversation.noteId, conversation.title)
      : null;
  if (operation === 'note-proposal' && (note?.revision ?? null) !== parsed.data.noteRevision)
    throw new HttpError(409, 'Note changed');
  const turn = await first<{ turn_id: string }>(
    c.env.DB.prepare('SELECT turn_id FROM messages WHERE id=? AND owner_id=?').bind(
      assistantMessage.id,
      ownerId,
    ),
  );
  if (!turn) throw new HttpError(404, 'Response not found');
  const input: AgentTurnInput = {
    ownerId,
    telemetryUserId: c.get('authSubject'),
    turnId: turn.turn_id,
    requestId: `${assistantMessage.id}:${operation}`,
    conversation: { ...conversation, messages: conversation.messages.slice(0, index - 1) },
    note,
    persona: await personaFor(c.env.DB, ownerId, parsed.data.personaId),
    message: parsed.data.captureText ?? userMessage.content,
    action: parsed.data.action,
    noteProposalRequested: parsed.data.noteProposalRequested,
    // Lets a new proposal supersede one still waiting on the reader rather than
    // stacking a second suggestion about the same point.
    pendingProposals:
      operation === 'note-proposal' && conversation.noteId
        ? await loadPendingNoteSuggestions(c.env.DB, ownerId, conversation.noteId)
        : undefined,
  };
  const agent = createAgentService(c.env, (task) => c.executionCtx.waitUntil(task));
  if (operation === 'annotations') {
    if (c.req.query('stream') === '1') {
      const controller = new AbortController();
      const abort = () => controller.abort('client disconnected');
      c.req.raw.signal.addEventListener('abort', abort, { once: true });
      if (c.req.raw.signal.aborted) abort();
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(output) {
          const emit = (event: AnnotationEvent) =>
            output.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          const run = async () => {
            let provisional = assistantMessage.annotations ?? [];
            try {
              const annotationEvents = await agent.streamAnnotations(
                input,
                assistantMessage,
                controller.signal,
              );
              for await (const event of annotationEvents) {
                if (controller.signal.aborted) break;
                if (event.type === 'annotation') {
                  const merged = mergeAnnotationsPreservingExisting(
                    provisional,
                    [event.annotation],
                    assistantMessage.content,
                  );
                  if (!merged.some(({ id }) => id === event.annotation.id)) continue;
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
                await c.env.DB.batch(
                  agentHighlightStatements(c.env.DB, {
                    messageId: assistantMessage.id,
                    ownerId,
                    content: assistantMessage.content,
                    annotations,
                    updatedAt: nowIso(),
                  }),
                );
                emit({ type: 'done', annotations });
                break;
              }
            } catch {
              if (!controller.signal.aborted)
                emit({
                  type: 'error',
                  message: 'Highlights could not be generated. Please try again.',
                });
            } finally {
              c.req.raw.signal.removeEventListener('abort', abort);
              try {
                output.close();
              } catch {
                /* Reader already left. */
              }
            }
          };
          c.executionCtx.waitUntil(run());
        },
        cancel: abort,
      });
      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          'x-accel-buffering': 'no',
        },
      });
    }
    const additions = await agent
      .annotateTurn(input, assistantMessage, c.req.raw.signal)
      .catch(() => {
        throw new HttpError(503, 'Highlights could not be generated. Please try again.');
      });
    const annotations = mergeAnnotationsPreservingExisting(
      assistantMessage.annotations ?? [],
      additions,
      assistantMessage.content,
    );
    await c.env.DB.batch(
      agentHighlightStatements(c.env.DB, {
        messageId: assistantMessage.id,
        ownerId,
        content: assistantMessage.content,
        annotations,
        updatedAt: nowIso(),
      }),
    );
    return c.json({ annotations });
  }
  const controller = new AbortController();
  const proposalAttemptId = newId();
  const abort = () => controller.abort('client disconnected');
  c.req.raw.signal.addEventListener('abort', abort, { once: true });
  if (c.req.raw.signal.aborted) abort();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(output) {
      const emit = (event: NoteProposalEvent) => {
        try {
          output.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          return true;
        } catch {
          controller.abort('response stream closed');
          return false;
        }
      };
      const run = async () => {
        const undeliveredCreatedSuggestions: {
          id: string;
          ownerId: string;
          conversationId: string;
          sourceMessageId: string;
        }[] = [];
        const proposalAttempts = new Map<string, { id: string; slot: number }>();
        const attemptIdFor = (proposal: { id: string }, operationIndex?: number) => {
          const existing = proposalAttempts.get(proposal.id);
          if (existing) return existing.id;
          const assignedId = [...proposalAttempts.values()].find(
            (attempt) => attempt.id === proposal.id,
          );
          if (assignedId) return assignedId.id;
          let slot = operationIndex ?? 0;
          while ([...proposalAttempts.values()].some((attempt) => attempt.slot === slot)) slot += 1;
          const id = slot === 0 ? proposalAttemptId : `${proposalAttemptId}:${slot}`;
          proposalAttempts.set(proposal.id, { id, slot });
          return id;
        };
        const generationKeyFor = (proposal: { id: string }) => {
          const id = attemptIdFor(proposal);
          const slot = [...proposalAttempts.values()].find((attempt) => attempt.id === id)?.slot;
          return slot === 0 || slot === undefined
            ? generationKey
            : `${generationKey}:operation:${slot}`;
        };
        try {
          const events = await agent.streamNoteProposal(input, assistantMessage, controller.signal);
          for await (const event of events) {
            if (controller.signal.aborted) break;
            const attemptEvent =
              event.type === 'preview'
                ? {
                    ...event,
                    proposal: {
                      ...event.proposal,
                      id: attemptIdFor(event.proposal, event.operationIndex),
                    },
                  }
                : event.type === 'done'
                  ? (() => {
                      const proposals = event.proposals?.map((proposal, operationIndex) => ({
                        ...proposal,
                        id: attemptIdFor(proposal, operationIndex),
                      }));
                      return {
                        ...event,
                        proposal: event.proposal
                          ? { ...event.proposal, id: attemptIdFor(event.proposal) }
                          : null,
                        ...(proposals ? { proposals } : {}),
                      };
                    })()
                  : event;
            if (
              attemptEvent.type === 'done' &&
              (attemptEvent.proposals?.length || attemptEvent.proposal)
            ) {
              const latest = await loadConversation(c.env.DB, ownerId, conversation.id, {
                branchId: conversation.branchId,
              });
              const currentNote = await loadNote(c.env.DB, ownerId, latest.noteId, latest.title);
              if (controller.signal.aborted) break;
              const sourceStillExists = latest.messages.some(
                (message) =>
                  message.id === assistantMessage.id &&
                  message.role === 'assistant' &&
                  !message.incomplete,
              );
              if (
                !sourceStillExists ||
                latest.expiresAt <= nowIso() ||
                latest.noteId !== conversation.noteId
              ) {
                emit({ type: 'done', proposal: null });
                break;
              }
              const proposals =
                attemptEvent.proposals ?? (attemptEvent.proposal ? [attemptEvent.proposal] : []);
              try {
                // Only a replacement can fail to resolve. An addition has no
                // position to go stale, so it never sends the reader back to
                // retry an edit they have already reviewed.
                for (const proposal of proposals)
                  if (proposal.oldText !== '')
                    resolveEdit(currentNote?.markdown ?? '', proposal.oldText, proposal.newText);
              } catch {
                emit({
                  type: 'error',
                  message:
                    'That part of the note changed while the suggestion was being prepared. Retry to use your latest text.',
                });
                break;
              }
              try {
                const persistedProposals = [];
                let expectedNoteId = note?.id ?? null;
                let expectedRevision = currentNote?.revision ?? null;
                for (const proposal of proposals) {
                  const persisted = await persistNoteSuggestion(c.env.DB, {
                    ownerId,
                    conversationId: conversation.id,
                    branchId: conversation.branchId,
                    sourceMessageId: assistantMessage.id,
                    generationKey: generationKeyFor(proposal),
                    attemptId: proposalAttemptId,
                    expectedNoteId,
                    expectedRevision,
                    allowAfterDecision: parsed.data.noteProposalRequested === true,
                    proposal: {
                      ...proposal,
                      noteId: expectedNoteId ?? proposal.noteId,
                      baseRevision: currentNote?.revision ?? 0,
                    },
                  });
                  expectedNoteId = persisted.noteId;
                  expectedRevision ??= persisted.suggestion.baseRevision;
                  persistedProposals.push(persisted.suggestion);
                  if (persisted.created)
                    undeliveredCreatedSuggestions.push({
                      id: persisted.suggestion.id,
                      ownerId,
                      conversationId: conversation.id,
                      sourceMessageId: assistantMessage.id,
                    });
                }
                if (controller.signal.aborted) {
                  break;
                }
                const delivered = emit({
                  type: 'done',
                  proposal: persistedProposals.at(-1) ?? null,
                  ...(attemptEvent.proposals ? { proposals: persistedProposals } : {}),
                });
                if (delivered) undeliveredCreatedSuggestions.length = 0;
              } catch (error) {
                if (error instanceof HttpError && error.status === 409) {
                  emit({
                    type: 'error',
                    message:
                      'The note changed before the suggestion was saved. Retry to use your latest text.',
                  });
                  break;
                }
                throw error;
              }
              break;
            }
            emit(attemptEvent);
          }
        } catch {
          if (!controller.signal.aborted)
            try {
              emit({ type: 'error', message: 'Could not prepare a note suggestion.' });
            } catch {
              /* Reader already left. */
            }
        } finally {
          for (const suggestion of undeliveredCreatedSuggestions)
            await removeCancelledPendingSuggestion(c.env.DB, suggestion);
          c.req.raw.signal.removeEventListener('abort', abort);
          try {
            output.close();
          } catch {
            /* Reader already left. */
          }
        }
      };
      c.executionCtx.waitUntil(run());
    },
    cancel: abort,
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
});

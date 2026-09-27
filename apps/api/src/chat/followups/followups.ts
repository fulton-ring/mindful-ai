import {
  type Annotation,
  type AnnotationEvent,
  type Conversation,
  type MessageFollowupRequest,
  messageFollowupRequestSchema,
  type NoteProposalEvent,
  uiMessageText,
  type WaldenUIMessage,
} from '@walden/contracts';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { first } from '../../db/client';
import { HttpError, jsonBody, nowIso } from '../../http';
import { loadNoteState } from '../../notes/history/history';
import {
  cancelNoteSuggestionAttempt,
  loadNoteSuggestionBatch,
  loadNoteSuggestionBySource,
  loadPendingNoteSuggestions,
} from '../../notes/suggestions/suggestions';
import { createAgentService } from '../../services/agent/agent';
import { annotationBudget } from '../../services/annotations/annotations';
import type { AgentTurnInput } from '../../services/types';
import type { Bindings, Variables } from '../../types';
import { loadConversation } from '../conversations/repository';
import { isInterrupted } from '../messages';
import { encodeSse, sseResponse } from '../sse';
import { personaFor } from '../turns/turn-support';
import {
  AnnotationGenerationError,
  createAnnotationStream,
  generateAnnotations,
} from './followup-annotations';
import { createNoteProposalStream, loadNote } from './followup-note-proposals';

type FollowupEnv = { Bindings: Bindings; Variables: Variables };
type FollowupContext = Context<FollowupEnv>;
type FollowupOperation = 'annotations' | 'note-proposal';

type FollowupTarget = {
  ownerId: string;
  conversation: Conversation;
  index: number;
  assistantMessage: WaldenUIMessage;
  generationKey: string;
};

function parseOperation(value: string): FollowupOperation {
  if (value !== 'annotations' && value !== 'note-proposal') throw new HttpError(404, 'Not found');
  return value;
}

function requestParam(c: FollowupContext, name: string) {
  const value = c.req.param(name);
  if (!value) throw new HttpError(404, 'Not found');
  return value;
}

async function parseRequest(c: FollowupContext): Promise<MessageFollowupRequest> {
  const parsed = messageFollowupRequestSchema.safeParse(await jsonBody(c));
  if (!parsed.success) throw new HttpError(400, 'Invalid follow-up request');
  return parsed.data;
}

async function captureGenerationKey(messageId: string, captureText: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(captureText));
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `${messageId}:capture:${hash}`;
}

async function generationKeyFor(messageId: string, request: MessageFollowupRequest) {
  return request.action === 'capture'
    ? captureGenerationKey(messageId, request.captureText ?? '')
    : messageId;
}

async function loadTarget(
  c: FollowupContext,
  request: MessageFollowupRequest,
): Promise<FollowupTarget> {
  const ownerId = c.get('userId');
  const conversation = await loadConversation(c.env.DB, ownerId, request.conversationId, {
    branchId: request.branchId,
  });
  if (conversation.expiresAt <= nowIso()) throw new HttpError(410, 'Conversation expired');
  const index = conversation.messages.findIndex(
    (message) => message.id === requestParam(c, 'messageId'),
  );
  const assistantMessage = conversation.messages[index];
  if (!assistantMessage || assistantMessage.role !== 'assistant' || isInterrupted(assistantMessage))
    throw new HttpError(404, 'Completed response not found');
  return {
    ownerId,
    conversation,
    index,
    assistantMessage,
    generationKey: await generationKeyFor(assistantMessage.id, request),
  };
}

function cachedAnnotationResponse(
  c: FollowupContext,
  operation: FollowupOperation,
  assistantMessage: WaldenUIMessage,
) {
  if (
    operation !== 'annotations' ||
    (assistantMessage.metadata?.annotations?.length ?? 0) <
      annotationBudget(uiMessageText(assistantMessage))
  )
    return null;
  const annotations = assistantMessage.metadata?.annotations ?? [];
  if (c.req.query('stream') === '1') {
    const event = { type: 'done', annotations } satisfies AnnotationEvent;
    return sseResponse(encodeSse(event));
  }
  return c.json({ annotations });
}

async function storedProposalResponse(
  c: FollowupContext,
  request: MessageFollowupRequest,
  target: FollowupTarget,
) {
  const lookup = {
    ownerId: target.ownerId,
    conversationId: target.conversation.id,
    branchId: target.conversation.branchId,
    sourceMessageId: target.assistantMessage.id,
    generationKey: target.generationKey,
  };
  const stored =
    request.action === 'capture'
      ? [await loadNoteSuggestionBySource(c.env.DB, lookup)].filter(
          (suggestion) => suggestion !== null,
        )
      : await loadNoteSuggestionBatch(c.env.DB, lookup);
  const pending = stored.filter((suggestion) => suggestion.status === 'pending');
  if (!stored.length || (!pending.length && request.noteProposalRequested)) return null;
  const event: NoteProposalEvent = {
    type: 'done',
    proposal: pending.at(-1) ?? null,
    ...(request.action === 'capture' ? {} : { proposals: pending }),
  };
  return sseResponse(encodeSse(event));
}

async function buildAgentInput(
  c: FollowupContext,
  operation: FollowupOperation,
  request: MessageFollowupRequest,
  target: FollowupTarget,
): Promise<AgentTurnInput> {
  const { ownerId, conversation, assistantMessage, index } = target;
  const userMessage = conversation.messages[index - 1];
  if (!userMessage || userMessage.role !== 'user')
    throw new HttpError(409, 'Response context unavailable');
  const note =
    operation === 'note-proposal' ? await loadNote(c.env.DB, ownerId, conversation.noteId) : null;
  if (operation === 'note-proposal' && (note?.revision ?? null) !== request.noteRevision)
    throw new HttpError(409, 'Note changed');
  const turn = await first<{ turn_id: string }>(
    c.env.DB.prepare('SELECT turn_id FROM messages WHERE id=? AND owner_id=?').bind(
      assistantMessage.id,
      ownerId,
    ),
  );
  if (!turn) throw new HttpError(404, 'Response not found');
  return {
    ownerId,
    telemetryUserId: c.get('authSubject'),
    turnId: turn.turn_id,
    requestId: `${assistantMessage.id}:${operation}`,
    conversation: { ...conversation, messages: conversation.messages.slice(0, index - 1) },
    note,
    persona: await personaFor(c.env.DB, ownerId, request.personaId),
    message: request.captureText ?? uiMessageText(userMessage),
    action: request.action,
    noteProposalRequested: request.noteProposalRequested,
    pendingProposals:
      operation === 'note-proposal' && conversation.noteId
        ? await loadPendingNoteSuggestions(c.env.DB, ownerId, conversation.noteId)
        : undefined,
  };
}

async function annotationResponse(
  c: FollowupContext,
  target: FollowupTarget,
  input: AgentTurnInput,
) {
  const agent = createAgentService(c.env, (task) => c.executionCtx.waitUntil(task));
  const generation = {
    db: c.env.DB,
    ownerId: target.ownerId,
    input,
    assistantMessage: target.assistantMessage,
    agent,
  };
  if (c.req.query('stream') === '1')
    return sseResponse(
      createAnnotationStream({
        ...generation,
        requestSignal: c.req.raw.signal,
        waitUntil: (task) => c.executionCtx.waitUntil(task),
      }),
    );
  let annotations: Annotation[];
  try {
    annotations = await generateAnnotations(generation, c.req.raw.signal);
  } catch (error) {
    if (error instanceof AnnotationGenerationError)
      throw new HttpError(503, 'Highlights could not be generated. Please try again.');
    throw error;
  }
  return c.json({ annotations });
}

function proposalResponse(
  c: FollowupContext,
  request: MessageFollowupRequest,
  target: FollowupTarget,
  input: AgentTurnInput,
) {
  const agent = createAgentService(c.env, (task) => c.executionCtx.waitUntil(task));
  return sseResponse(
    createNoteProposalStream({
      db: c.env.DB,
      ownerId: target.ownerId,
      conversation: target.conversation,
      assistantMessage: target.assistantMessage,
      note: input.note,
      input,
      agent,
      generationKey: target.generationKey,
      noteProposalRequested: request.noteProposalRequested,
      requestSignal: c.req.raw.signal,
      waitUntil: (task) => c.executionCtx.waitUntil(task),
    }),
  );
}

async function cancelProposal(c: FollowupContext) {
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
    sourceMessageId: requestParam(c, 'messageId'),
    attemptId: parsed.data.attemptId,
  });
  return c.json({
    cancelledSuggestionIds: result.cancelledSuggestionIds,
    noteState: result.noteId ? await loadNoteState(c.env.DB, ownerId, result.noteId) : null,
  });
}

async function handleFollowup(c: FollowupContext) {
  const operation = parseOperation(requestParam(c, 'operation'));
  const request = await parseRequest(c);
  const target = await loadTarget(c, request);
  const cachedAnnotations = cachedAnnotationResponse(c, operation, target.assistantMessage);
  if (cachedAnnotations) return cachedAnnotations;
  if (operation === 'note-proposal') {
    const storedProposal = await storedProposalResponse(c, request, target);
    if (storedProposal) return storedProposal;
  }
  const input = await buildAgentInput(c, operation, request, target);
  return operation === 'annotations'
    ? annotationResponse(c, target, input)
    : proposalResponse(c, request, target, input);
}

export const followupRoutes = new Hono<FollowupEnv>();
followupRoutes.post('/messages/:messageId/note-proposal/cancel', cancelProposal);
followupRoutes.post('/messages/:messageId/:operation', handleFollowup);

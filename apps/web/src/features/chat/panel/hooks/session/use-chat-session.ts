import { useChat } from '@ai-sdk/react';
import {
  type Conversation,
  messageMetadataSchema,
  type WaldenDataParts,
  type WaldenUIMessage,
} from '@walden/contracts';
import { conversationTitle } from '@walden/domain';
import type { ChatInit, DataUIPart } from 'ai';
import { type RefObject, useState } from 'react';

import { type ActiveTurn, DurableTurnTransport } from '../../../../../lib/durable-turn-transport';
import { id } from '../../../../../lib/ids';
import { track } from '../../../../../lib/telemetry';
import type { TurnArgs } from './turn-args';
import { adoptUserMessageId, handleData, handleError, handleFinish } from './turn-callbacks';

async function ensureConversation(args: TurnArgs, editing: boolean) {
  const { props, runtime } = args;
  runtime.awaitingConversationAdoption.current = props.scopeId === null;
  try {
    const conversation = await props.onEnsureConversation();
    if (!editing) props.onAdvance?.();
    return conversation;
  } finally {
    runtime.awaitingConversationAdoption.current = false;
  }
}

function nameConversation(args: TurnArgs, conversation: Conversation) {
  const draft = args.runtime.live.current?.draft;
  const untitled = conversation.title === 'New thread' || conversation.title === 'New conversation';
  const named =
    untitled && draft
      ? { ...conversation, title: conversationTitle(draft.text || draft.files[0]?.name || 'Files') }
      : conversation;
  if (named !== conversation) void args.props.onConversation(named);
  if (named !== conversation || args.runtime.latestConversation.current?.id !== named.id)
    args.runtime.latestConversation.current = named;
  return named;
}

/** Flushes the note and resolves the conversation a new turn is sent against. */
async function prepareTurn(args: TurnArgs, editing: boolean, signal?: AbortSignal) {
  const { props, runtime } = args;
  await runtime.pendingTurnCancellation.current;
  const noteRevision = await props.onFlush();
  signal?.throwIfAborted();
  const regenerating = runtime.live.current?.kind === 'regenerate';
  if (noteRevision === false)
    throw new Error(
      `Your note still has unsaved changes. Resolve the save before ${regenerating ? 'regenerating' : 'starting a turn'}.`,
    );
  const conversation = nameConversation(args, await ensureConversation(args, editing));
  signal?.throwIfAborted();
  runtime.activeConversationId.current = conversation.id;
  const live = runtime.live.current;
  if (live)
    Object.assign(live, {
      conversationId: conversation.id,
      branchId: conversation.branchId,
      noteRevision,
    });
  track(regenerating ? 'chat_regeneration_started' : 'chat_submitted', {
    conversation_id: conversation.id,
    request_id: live?.requestId,
    persona_id: args.effectivePersonaId,
    action: live?.action,
    characters: live?.draft?.text.length,
    attachment_count: live?.draft?.files.length,
    had_note: Boolean(conversation.noteId),
  });
  return {
    conversationId: conversation.id,
    branchId: conversation.branchId,
    noteRevision,
    personaId: args.effectivePersonaId,
  };
}

/** A running turn found on mount or after switching threads becomes the live turn. */
export function adoptResumedTurn(args: TurnArgs, turn: ActiveTurn) {
  const { runtime, chat } = args;
  runtime.live.current = {
    kind: 'resume',
    turnId: turn.id,
    requestId: turn.requestId,
    conversationId: turn.conversationId,
    branchId: turn.branchId,
    noteRevision: null,
    snapshot: chat.messages,
    startedAt: performance.now(),
  };
  args.display.setStatus('Reconnecting…');
  const fork = turn.regenerateMessageId ?? turn.editMessageId;
  if (fork)
    chat.setMessages((messages) => {
      const index = messages.findIndex((message) => message.id === fork);
      return index < 0 ? messages : messages.slice(0, index);
    });
}

function createTransport(argsRef: RefObject<TurnArgs | null>) {
  const args = () => argsRef.current!;
  return new DurableTurnTransport({
    prepare: ({ editing, abortSignal }) => prepareTurn(args(), editing, abortSignal),
    locate: () => {
      const conversation = args().props.conversation;
      return conversation
        ? { conversationId: conversation.id, branchId: conversation.branchId }
        : null;
    },
    onTurn: (turn) => {
      const live = args().runtime.live.current;
      if (turn.resumed) adoptResumedTurn(args(), turn.resumed);
      else if (live) {
        live.turnId = turn.id;
        // Adopt the server id now, so Stop before the first chunk still retries correctly.
        if (turn.userMessageId && live.kind === 'send')
          adoptUserMessageId(args(), turn.userMessageId);
      }
    },
  });
}

/**
 * Typed for `useChat` (checking the Zod schema structurally exceeds the compiler's depth).
 * Data parts are not validated: ai@6.0.286 looks schemas up by chunk type (`data-status`)
 * while its types key them by name (`status`), so a `dataPartSchemas` option never runs.
 */
const schemas = { messageMetadataSchema } as unknown as Pick<
  ChatInit<WaldenUIMessage>,
  'messageMetadataSchema'
>;

/** The panel's AI SDK chat: one instance for the panel's life, fed by durable server turns. */
export function useChatSession(
  argsRef: RefObject<TurnArgs | null>,
  initialMessages: WaldenUIMessage[],
) {
  const [transport] = useState(() => createTransport(argsRef));
  const [chatId] = useState(() => id('chat'));
  return useChat<WaldenUIMessage>({
    id: chatId,
    messages: initialMessages,
    transport,
    // Not `resume: true`: a reconnect that finds no turn marks the chat ready, even when a
    // send started meanwhile. The lifecycle looks the turn up and resumes it by id instead.
    ...schemas,
    experimental_throttle: 50,
    // `useChat` infers generic data parts from the message type; ours are `WaldenDataParts`.
    onData: (part) => handleData(argsRef.current!, part as DataUIPart<WaldenDataParts>),
    onFinish: (event) => handleFinish(argsRef.current!, event),
    onError: (error) => handleError(argsRef.current!, error),
  });
}

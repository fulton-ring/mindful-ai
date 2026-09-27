import type { UseChatHelpers } from '@ai-sdk/react';
import type { Annotation, WaldenMessageMetadata, WaldenUIMessage } from '@walden/contracts';

import type { ChatPanelProps } from '../../chat-panel-types';
import type { useChatUploads } from '../actions/use-chat-uploads';
import type { ChatDisplayState } from '../state/use-chat-display-state';
import type { ChatRuntimeState } from '../state/use-chat-runtime-state';

export type WaldenChat = UseChatHelpers<WaldenUIMessage>;

/** Everything the turn callbacks and actions need, refreshed on every render. */
export type TurnArgs = {
  props: ChatPanelProps;
  display: ChatDisplayState;
  runtime: ChatRuntimeState;
  chat: WaldenChat;
  uploads: ReturnType<typeof useChatUploads>;
  effectivePersonaId: string;
  followups: {
    resetAnnotationRetries(): void;
    animateAnnotations(messageId: string, values: Annotation[]): void;
    launchFollowups(
      messageId: string,
      conversationId: string,
      noteRevision: number | null,
      annotationsHandled?: boolean,
    ): void;
  };
};

export function withMetadata(
  message: WaldenUIMessage,
  patch: Partial<WaldenMessageMetadata>,
): WaldenUIMessage {
  return {
    ...message,
    metadata: { createdAt: new Date().toISOString(), ...message.metadata, ...patch },
  };
}

/** Applies `update` to a message in the live transcript and in the cached conversation. */
export function updateMessage(
  args: Pick<TurnArgs, 'chat' | 'runtime' | 'props'>,
  messageId: string,
  update: (message: WaldenUIMessage) => WaldenUIMessage,
) {
  const apply = (messages: WaldenUIMessage[]) =>
    messages.map((message) => (message.id === messageId ? update(message) : message));
  args.chat.setMessages(apply);
  const current = args.runtime.latestConversation.current;
  if (!current?.messages.some((message) => message.id === messageId)) return undefined;
  const next = { ...current, messages: apply(current.messages) };
  args.runtime.latestConversation.current = next;
  return args.props.onConversation(next);
}

import type { ChatRequest, LearningCheckResponse, WaldenUIMessage } from '@walden/contracts';
import { useRef } from 'react';

import { effectivePersona } from '../../../../personas/PersonaPicker';
import type { ChatPanelProps } from '../../chat-panel-types';
import { useChatAnnotations } from '../actions/use-chat-annotations';
import { useChatLifecycle } from '../actions/use-chat-lifecycle';
import { useChatPreferences } from '../actions/use-chat-preferences';
import { useChatProposals } from '../actions/use-chat-proposals';
import { useChatUploads } from '../actions/use-chat-uploads';
import { useMessageActions } from '../actions/use-message-actions';
import { regenerate, retryIncomplete, send, stop } from '../session/turn-actions';
import type { TurnArgs } from '../session/turn-args';
import { useChatSession } from '../session/use-chat-session';
import { useChatDisplayState } from '../state/use-chat-display-state';
import { type ChatRuntimeState, useChatRuntimeState } from '../state/use-chat-runtime-state';

function syncRuntime(props: ChatPanelProps, runtime: ChatRuntimeState) {
  if (props.conversation !== runtime.lastConversationProp.current) {
    runtime.lastConversationProp.current = props.conversation;
    runtime.latestConversation.current = props.conversation;
  }
  runtime.activeBranchId.current = props.conversation?.branchId ?? null;
  // A thread being created for the live turn keeps its id until the route adopts it.
  if (props.scopeId !== null || !runtime.live.current)
    runtime.activeConversationId.current = props.scopeId;
}

function turnActions(args: TurnArgs) {
  return {
    send: (
      message?: string,
      action?: ChatRequest['action'],
      editMessageId?: string,
      learningCheckResponse?: LearningCheckResponse,
    ) => send(args, message, action, editMessageId, learningCheckResponse),
    regenerateResponse: (message: WaldenUIMessage) => regenerate(args, message),
    retryIncomplete: (message: WaldenUIMessage) => retryIncomplete(args, message),
    stopMainTurn: () => stop(args),
  };
}

export function useChatPanelController(props: ChatPanelProps) {
  const selectedPersona = effectivePersona(props.personas, props.personaId);
  const effectivePersonaId = selectedPersona?.id ?? 'thinking-partner';
  const display = useChatDisplayState();
  const runtime = useChatRuntimeState(props.conversation, props.scopeId);
  syncRuntime(props, runtime);
  const argsRef = useRef<TurnArgs | null>(null);
  const chat = useChatSession(argsRef, props.conversation?.messages ?? []);
  const messageActions = useMessageActions(display.setError);
  const uploads = useChatUploads(props, display, runtime);
  const preferences = useChatPreferences({ props, display, runtime });
  const proposals = useChatProposals({ props, display, runtime, effectivePersonaId });
  const annotations = useChatAnnotations({
    props,
    display,
    runtime,
    chat,
    effectivePersonaId,
    proposeNote: proposals.proposeNote,
  });
  const args: TurnArgs = {
    props,
    display,
    runtime,
    chat,
    uploads,
    effectivePersonaId,
    followups: annotations,
  };
  argsRef.current = args;
  useChatLifecycle(args);
  return {
    ...display,
    ...runtime,
    ...messageActions,
    ...uploads,
    ...preferences,
    ...proposals,
    ...annotations,
    ...turnActions(args),
    messages: chat.messages,
    sending: chat.status === 'submitted' || chat.status === 'streaming',
    selectedPersona,
    effectivePersonaId,
  };
}

export type ChatPanelController = ReturnType<typeof useChatPanelController>;

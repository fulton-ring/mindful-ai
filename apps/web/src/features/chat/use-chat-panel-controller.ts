import { effectivePersona } from '../personas/PersonaPicker';
import type { ChatPanelProps } from './chat-panel-types';
import { resetAnnotationRetries, useChatAnnotations } from './use-chat-annotations';
import { useChatDisplayState } from './use-chat-display-state';
import { useChatLifecycle } from './use-chat-lifecycle';
import { useChatPreferences } from './use-chat-preferences';
import { useChatProposals } from './use-chat-proposals';
import { useChatRegeneration } from './use-chat-regenerate';
import { useChatRuntimeState } from './use-chat-runtime-state';
import { useChatSend } from './use-chat-send';
import { useChatTurn } from './use-chat-turn';
import { useMessageActions } from './use-message-actions';

function syncRuntime(props: ChatPanelProps, runtime: ReturnType<typeof useChatRuntimeState>) {
  if (props.conversation !== runtime.lastConversationProp.current) {
    runtime.lastConversationProp.current = props.conversation;
    runtime.latestConversation.current = props.conversation;
  }
  runtime.activeBranchId.current = props.conversation?.branchId ?? null;
  if (
    props.scopeId !== null ||
    runtime.previousConversationId.current !== null ||
    !runtime.streamConversationId.current
  )
    runtime.activeConversationId.current = props.scopeId;
}

function useChatOrchestration(
  props: ChatPanelProps,
  display: ReturnType<typeof useChatDisplayState>,
  runtime: ReturnType<typeof useChatRuntimeState>,
  turn: ReturnType<typeof useChatTurn>,
  effectivePersonaId: string,
) {
  const lifecycle = useChatLifecycle({
    props,
    display,
    runtime,
    turn,
    resetAnnotationRetries: () => resetAnnotationRetries(display),
  });
  const preferences = useChatPreferences({ props, display, runtime });
  const proposals = useChatProposals({ props, display, runtime, effectivePersonaId });
  const annotations = useChatAnnotations(
    {
      props,
      display,
      runtime,
      effectivePersonaId,
      proposeNote: proposals.proposeNote,
    },
    turn,
  );
  const send = useChatSend({
    props,
    display,
    runtime,
    turn,
    effectivePersonaId,
    pendingEdit: display.pendingEdit,
    cancelMainTurn: lifecycle.cancelMainTurn,
    resetAnnotationRetries: annotations.resetAnnotationRetries,
    animateAnnotations: annotations.animateAnnotations,
    adoptIncompleteResponse: lifecycle.adoptIncompleteResponse,
    launchFollowups: annotations.launchFollowups,
  });
  const regeneration = useChatRegeneration({
    props,
    display,
    runtime,
    turn,
    effectivePersonaId,
    animateAnnotations: annotations.animateAnnotations,
    launchFollowups: annotations.launchFollowups,
  });
  return {
    ...lifecycle,
    ...preferences,
    ...proposals,
    ...annotations,
    ...send,
    ...regeneration,
  };
}

export function useChatPanelController(props: ChatPanelProps) {
  const selectedPersona = effectivePersona(props.personas, props.personaId);
  const effectivePersonaId = selectedPersona?.id ?? 'thinking-partner';
  const display = useChatDisplayState();
  const runtime = useChatRuntimeState(props.conversation, props.scopeId);
  const turn = useChatTurn(display.setStreamed);
  const messageActions = useMessageActions(display.setError);
  syncRuntime(props, runtime);
  const orchestration = useChatOrchestration(props, display, runtime, turn, effectivePersonaId);
  return {
    ...display,
    ...runtime,
    ...turn,
    ...messageActions,
    ...orchestration,
    selectedPersona,
    effectivePersonaId,
  };
}

export type ChatPanelController = ReturnType<typeof useChatPanelController>;

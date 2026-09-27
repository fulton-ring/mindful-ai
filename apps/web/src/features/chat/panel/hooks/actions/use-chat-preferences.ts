import { api } from '../../../../../lib/api';
import { failureDetails, track } from '../../../../../lib/telemetry';
import type { ChatPanelProps } from '../../chat-panel-types';
import type { ChatDisplayState } from '../state/use-chat-display-state';
import type { ChatRuntimeState } from '../state/use-chat-runtime-state';

type PreferenceArgs = {
  props: ChatPanelProps;
  display: ChatDisplayState;
  runtime: ChatRuntimeState;
};

async function changeChatPreference(
  args: PreferenceArgs,
  setting: 'learningChecks' | 'webSearch',
  enabled: boolean,
) {
  if (args.display.sendingRef.current || args.display.savingChatPreference) {
    track('action_blocked', {
      action: 'change_chat_preference',
      setting,
      failure_code: args.display.sendingRef.current ? 'response_in_progress' : 'preference_saving',
    });
    return;
  }
  args.display.setSavingChatPreference(true);
  const originalScope = args.runtime.activeConversationId.current;
  try {
    const conversation = args.props.conversation ?? (await args.props.onEnsureConversation());
    const result = await (setting === 'webSearch' ? api.setWebSearch : api.setLearningChecks)(
      conversation.id,
      enabled,
    );
    if (
      args.runtime.activeConversationId.current !== conversation.id &&
      args.runtime.activeConversationId.current !== originalScope
    )
      return;
    await args.props.onConversation({ ...conversation, ...result });
    if (setting === 'learningChecks' && !enabled) args.display.setIntervention(null);
    track('chat_preference_changed', { conversation_id: conversation.id, setting, enabled });
  } catch (cause) {
    track('chat_preference_failed', { setting, enabled, ...failureDetails(cause) });
    if (args.runtime.activeConversationId.current === originalScope)
      args.display.setError(
        cause instanceof Error ? cause.message : 'Could not save chat preference.',
      );
  } finally {
    args.display.setSavingChatPreference(false);
  }
}

export function useChatPreferences(args: PreferenceArgs) {
  return {
    changeChatPreference: (setting: 'learningChecks' | 'webSearch', enabled: boolean) =>
      changeChatPreference(args, setting, enabled),
  };
}

import { api } from '../../../../../lib/api';
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
  if (args.runtime.sendingRef.current || args.display.savingChatPreference) return;
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
  } catch (cause) {
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

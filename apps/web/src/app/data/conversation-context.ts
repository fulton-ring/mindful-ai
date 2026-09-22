import type { useConversationNavigation } from './use-conversation-navigation';
import type {
  useConversationQueries,
  useEditorState,
  usePanelState,
  useRouteState,
  useSidebarQueries,
  useThemeState,
} from './use-conversation-shell';

export type ConversationContext = ReturnType<typeof useRouteState> &
  ReturnType<typeof usePanelState> &
  ReturnType<typeof useThemeState> &
  ReturnType<typeof useEditorState> &
  ReturnType<typeof useSidebarQueries> &
  ReturnType<typeof useConversationQueries> &
  ReturnType<typeof useConversationNavigation>;

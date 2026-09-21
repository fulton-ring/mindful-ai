import { useConversationLifecycle } from './use-conversation-lifecycle';
import { useConversationNavigation } from './use-conversation-navigation';
import {
  useConversationQueries,
  useEditorState,
  usePanelState,
  useRouteState,
  useSidebarQueries,
  useThemeState,
} from './use-conversation-shell';
import { useNoteSaveActions } from './use-note-save-actions';

export function useConversationComposition(identity?: string) {
  const route = useRouteState();
  const panel = usePanelState(identity);
  const themeState = useThemeState();
  const editor = useEditorState();
  const sidebar = useSidebarQueries();
  const query = useConversationQueries(route, panel);
  const navigation = useConversationNavigation({ identity, route, panel, query });
  useConversationLifecycle({
    route,
    panel,
    editor,
    query,
    adoptingConversationId: navigation.adoptingConversationId,
  });
  const baseContext = {
    identity,
    ...route,
    ...panel,
    ...themeState,
    ...editor,
    ...sidebar,
    ...query,
    ...navigation,
  };
  const { doSave } = useNoteSaveActions({
    queryClient: sidebar.queryClient,
    activeRoute: route.activeRoute,
    draftRef: editor.draftRef,
    setDraft: editor.setDraft,
    setSaveState: editor.setSaveState,
    saveStateRef: editor.saveStateRef,
    savePromise: editor.savePromise,
    suggestionDecisionPromise: editor.suggestionDecisionPromise,
    dismissSuggestionsOnSave: editor.dismissSuggestionsOnSave,
    dismissedSuggestionIds: editor.dismissedSuggestionIds,
    deletedNoteIds: editor.deletedNoteIds,
  });
  return { route, panel, themeState, editor, sidebar, query, navigation, baseContext, doSave };
}

import { useConversationActionGroups } from '../actions/use-conversation-action-groups';
import { useConversationComposition } from './use-conversation-composition';

export function useConversationData({ identity }: { identity?: string }) {
  const composition = useConversationComposition(identity);
  const actions = useConversationActionGroups(composition);
  const { route, panel, themeState, editor, sidebar, query, navigation, doSave } = composition;
  return {
    ...route,
    ...panel,
    ...themeState,
    ...editor,
    ...sidebar,
    ...query,
    ...navigation,
    sidebar: panel.sidebar,
    selected: query.activeDocumentNoteId ? query.noteStateQuery.data?.note : undefined,
    doSave,
    ...actions,
  };
}

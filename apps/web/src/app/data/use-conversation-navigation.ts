import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { Conversation, ConversationSummary } from '@walden/contracts';
import { useCallback, useEffect, useRef } from 'react';
import { storageKeys } from '../../lib/storage-keys';
import { cacheConversationUpdate, writeDismissedNotePanels } from '../lifecycle/workspace-helpers';
import type {
  useConversationQueries,
  usePanelState,
  useRouteState,
} from './use-conversation-shell';

type NavigationContext = {
  identity?: string;
  route: ReturnType<typeof useRouteState>;
  panel: ReturnType<typeof usePanelState>;
  query: ReturnType<typeof useConversationQueries>;
};

export function useConversationNavigation({ identity, route, panel, query }: NavigationContext) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const adoptingConversationId = useRef<string | null>(null);
  const { activeBranchId, activeConversationId } = route;
  const { dismissedNoteConversations } = panel;
  const { conversationQuery, conversation } = query;
  const setConversation = useCallback(
    async (value: Conversation) => {
      if (!activeConversationId && dismissedNoteConversations.delete('new')) {
        dismissedNoteConversations.add(value.id);
        writeDismissedNotePanels(identity, dismissedNoteConversations);
      }
      const cached = cacheConversationUpdate(
        queryClient,
        value,
        activeConversationId,
        activeBranchId,
        conversation?.branchId ?? null,
      );
      const summary = queryClient
        .getQueryData<ConversationSummary[]>(['conversations'])
        ?.find((thread) => thread.id === value.id);
      if (
        !summary ||
        summary.title !== value.title ||
        summary.noteId !== value.noteId ||
        summary.expiresAt !== value.expiresAt
      )
        void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      if (activeConversationId !== value.id) {
        if (!activeConversationId) adoptingConversationId.current = value.id;
        await navigate({
          to: '/conversations/$conversationId',
          params: { conversationId: value.id },
          search: { branch: undefined },
        });
      } else if (!cached) {
        await navigate({
          to: '/conversations/$conversationId',
          params: { conversationId: value.id },
          search: { branch: value.branchId },
        });
        await queryClient.invalidateQueries({
          queryKey: ['conversation', value.id, value.branchId],
          exact: true,
        });
      }
    },
    [
      activeBranchId,
      activeConversationId,
      conversation?.branchId,
      dismissedNoteConversations,
      identity,
      navigate,
      queryClient,
    ],
  );
  useEffect(() => {
    if (conversationQuery.data && !conversationQuery.data.noteId)
      localStorage.removeItem(storageKeys.lastNote);
  }, [conversationQuery.data?.id, conversationQuery.data?.noteId]);
  return { navigate, setConversation, adoptingConversationId };
}

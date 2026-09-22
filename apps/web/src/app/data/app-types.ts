import type { AppConfig } from '@walden/contracts';
import type { ReactNode } from 'react';
import type { useConversationData } from './use-conversation-data';
import type { usePersonaData } from './use-persona-data';

export type WorkspaceData = ReturnType<typeof useConversationData> &
  ReturnType<typeof usePersonaData>;

export type AppRouteProps = WorkspaceData & {
  config: AppConfig;
  authControls?: ReactNode;
};

import type { AppConfig } from '@walden/contracts';
import type { ReactNode } from 'react';
import { useConversationData } from './app/data/use-conversation-data';
import { usePersonaData } from './app/data/use-persona-data';
import { AppRoutes } from './app/views/AppRoutes';

export function App({
  config,
  authControls,
  identity,
}: {
  config: AppConfig;
  authControls?: ReactNode;
  identity?: string;
}) {
  const personaData = usePersonaData(identity);
  const conversationData = useConversationData({ identity });
  return (
    <AppRoutes {...conversationData} {...personaData} config={config} authControls={authControls} />
  );
}

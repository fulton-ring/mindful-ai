import type { AppConfig } from '@walden/contracts';
import type { ReactNode } from 'react';
import { AppRoutes } from './app/AppRoutes';
import { useConversationData } from './app/use-conversation-data';
import { usePersonaData } from './app/use-persona-data';

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

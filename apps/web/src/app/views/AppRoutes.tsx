import type { ReactNode } from 'react';
import { ResizableHandle, ResizablePanelGroup } from '../../components/ui/resizable';
import { ConversationPrivacy } from '../../features/settings/ConversationPrivacy';
import { useWorkspaceShell } from '../data/workspace-context';
import { AppSidebar } from './AppSidebar';
import { useVisualViewport } from './use-visual-viewport';
import { WorkspacePanel } from './WorkspacePanels';

export function AppRoutes({ authControls }: { authControls?: ReactNode }) {
  useVisualViewport();
  const { desktop } = useWorkspaceShell();
  return (
    <ResizablePanelGroup className="app-shell" orientation="horizontal" disabled={!desktop}>
      <ConversationPrivacy notice />
      <AppSidebar authControls={authControls} />
      <ResizableHandle aria-label="Resize sidebar" disabled={!desktop} />
      <WorkspacePanel />
    </ResizablePanelGroup>
  );
}

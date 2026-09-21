import { ResizableHandle, ResizablePanelGroup } from '../components/ui/resizable';
import { ConversationPrivacy } from '../features/settings/ConversationPrivacy';
import { AppSidebar } from './AppSidebar';
import type { AppRouteProps } from './app-types';
import { WorkspacePanel } from './WorkspacePanels';

export function AppRoutes({ config, authControls, ...data }: AppRouteProps) {
  const { desktop } = data;
  return (
    <ResizablePanelGroup className="app-shell" orientation="horizontal" disabled={!desktop}>
      <ConversationPrivacy notice />
      <AppSidebar data={data} authControls={authControls} />
      <ResizableHandle aria-label="Resize sidebar" disabled={!desktop} />
      <WorkspacePanel data={data} config={config} />
    </ResizablePanelGroup>
  );
}

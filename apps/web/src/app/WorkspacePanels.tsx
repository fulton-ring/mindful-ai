import type { AppConfig } from '@walden/contracts';
import { Menu } from 'lucide-react';
import { ResizablePanel } from '../components/ui/resizable';
import type { WorkspaceData } from './app-types';
import { ConversationPanels } from './ConversationPanels';
import { WorkspaceOverlays } from './WorkspaceOverlays';

export function WorkspacePanel({ data, config }: { data: WorkspaceData; config: AppConfig }) {
  return (
    <ResizablePanel className="workspace-panel" minSize="420px">
      <div
        className={`app-workspace with-chat ${data.noteOpen ? '' : 'without-note'} mobile-${data.mobilePane}`}
      >
        <MobileHeader data={data} />
        <ConversationPanels data={data} />
        <WorkspaceOverlays data={data} config={config} />
      </div>
    </ResizablePanel>
  );
}

function MobileHeader({ data }: { data: WorkspaceData }) {
  const {
    setSidebar,
    conversation,
    draft,
    noteOnly,
    startChatFromNote,
    mobilePane,
    closeNote,
    showNote,
  } = data;
  return (
    <header className="mobile-header">
      <button className="icon-button" aria-label="Open sidebar" onClick={() => setSidebar(true)}>
        <Menu />
      </button>
      <span>{conversation?.title || draft?.title || 'Walden'}</span>
      <button
        className="text-button"
        onClick={noteOnly ? startChatFromNote : mobilePane === 'note' ? closeNote : showNote}
      >
        {noteOnly ? 'Start chat' : mobilePane === 'note' ? 'Chat' : 'Note'}
      </button>
    </header>
  );
}

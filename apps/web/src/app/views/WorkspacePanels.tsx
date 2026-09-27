import { Menu } from 'lucide-react';
import { ResizablePanel } from '../../components/ui/resizable';
import { useNoteDocument, useWorkspaceShell } from '../data/workspace-context';
import { ConversationPanels } from './ConversationPanels';
import { WorkspaceOverlays } from './WorkspaceOverlays';

export function WorkspacePanel() {
  const { noteOpen, mobilePane } = useWorkspaceShell();
  return (
    <ResizablePanel className="workspace-panel" minSize="420px">
      <div
        className={`app-workspace with-chat ${noteOpen ? '' : 'without-note'} mobile-${mobilePane}`}
      >
        <MobileHeader />
        <ConversationPanels />
        <WorkspaceOverlays />
      </div>
    </ResizablePanel>
  );
}

function MobileHeader() {
  const { setSidebar, conversation, noteOnly, startChatFromNote, mobilePane, closeNote, showNote } =
    useWorkspaceShell();
  const { draft } = useNoteDocument();
  return (
    <header className="mobile-header">
      <button className="icon-button" aria-label="Open sidebar" onClick={() => setSidebar(true)}>
        <Menu />
      </button>
      <span>{conversation?.title || draft?.title || 'New thread'}</span>
      <button
        className="text-button"
        onClick={noteOnly ? startChatFromNote : mobilePane === 'note' ? closeNote : showNote}
      >
        {noteOnly ? 'Start chat' : mobilePane === 'note' ? 'Chat' : 'Note'}
      </button>
    </header>
  );
}

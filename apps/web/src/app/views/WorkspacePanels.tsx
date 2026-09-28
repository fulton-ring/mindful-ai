import { Menu } from 'lucide-react';
import { useEffect } from 'react';
import { ResizablePanel } from '../../components/ui/resizable';
import { useNoteDocument, useWorkspaceShell } from '../data/workspace-context';
import { ConversationPanels } from './ConversationPanels';
import { WorkspaceOverlays } from './WorkspaceOverlays';

/** The open thread's name, as the mobile header and the browser tab show it. */
function useThreadTitle() {
  const { conversation } = useWorkspaceShell();
  const { draft } = useNoteDocument();
  return conversation?.title || draft?.title || 'New thread';
}

function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = `Walden - ${title}`;
    return () => {
      document.title = 'Walden';
    };
  }, [title]);
}

export function WorkspacePanel() {
  const { noteOpen, mobilePane } = useWorkspaceShell();
  useDocumentTitle(useThreadTitle());
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
  const { setSidebar, noteOnly, startChatFromNote, mobilePane, closeNote, showNote } =
    useWorkspaceShell();
  const title = useThreadTitle();
  return (
    <header className="mobile-header">
      <button className="icon-button" aria-label="Open sidebar" onClick={() => setSidebar(true)}>
        <Menu />
      </button>
      <span>{title}</span>
      <button
        className="text-button"
        onClick={noteOnly ? startChatFromNote : mobilePane === 'note' ? closeNote : showNote}
      >
        {noteOnly ? 'Start chat' : mobilePane === 'note' ? 'Chat' : 'Note'}
      </button>
    </header>
  );
}

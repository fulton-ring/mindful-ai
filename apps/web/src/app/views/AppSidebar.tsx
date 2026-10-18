import { ChevronLeft, Moon, Settings, Sun } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { ResizablePanel } from '../../components/ui/resizable';
import { WaldenMark } from '../../components/WaldenMark';
import { ThreadHistory } from '../../features/chat/ThreadHistory';
import { storageKeys } from '../../lib/storage-keys';
import { useWorkspaceShell, type WorkspaceShell } from '../data/workspace-context';

export function AppSidebar({ authControls }: { authControls?: ReactNode }) {
  const { desktop } = useWorkspaceShell();
  return (
    <ResizablePanel
      className="sidebar-panel"
      defaultSize={`${Number(localStorage.getItem(storageKeys.sidebarWidth)) || 250}px`}
      minSize="220px"
      maxSize="360px"
      onResize={({ inPixels }) => {
        if (desktop) localStorage.setItem(storageKeys.sidebarWidth, String(Math.round(inPixels)));
      }}
    >
      <SidebarContent authControls={authControls} />
    </ResizablePanel>
  );
}

function SidebarContent({ authControls }: { authControls?: ReactNode }) {
  const { sidebar, desktop } = useWorkspaceShell();
  return (
    <aside
      className={`note-sidebar ${sidebar ? 'open' : ''}`}
      aria-label="Threads"
      inert={!desktop && !sidebar}
    >
      <SidebarHeader />
      <SidebarHistory />
      <SidebarFooter authControls={authControls} />
    </aside>
  );
}

function SidebarHeader() {
  const { setSidebar } = useWorkspaceShell();
  return (
    <header>
      <div className="brand">
        <span className="brand-mark" aria-hidden>
          <WaldenMark />
        </span>
        <span>Walden</span>
      </div>
      <button
        className="icon-button sidebar-close"
        aria-label="Close sidebar"
        onClick={() => setSidebar(false)}
      >
        <ChevronLeft />
      </button>
    </header>
  );
}

function SidebarHistory() {
  const shell = useWorkspaceShell();
  return (
    <section className="conversation-history" aria-label="Thread history">
      <div className="sidebar-section-heading">
        <span>Threads</span>
        <button className="text-button" onClick={() => void startNewThread(shell)}>
          New thread
        </button>
      </div>
      <SidebarThreadHistory shell={shell} />
    </section>
  );
}

function SidebarThreadHistory({ shell }: { shell: WorkspaceShell }) {
  const {
    activeConversationId,
    activeNoteId,
    threadOptionsId,
    setThreadOptionsId,
    hasThreadOrNote,
    threadsLoading,
    threadsLoadError,
    retryThreads,
    retrySearch,
    threadSearch,
    setThreadSearch,
    searchActive,
    searchWaiting,
    searchFailed,
    threadClock,
    visibleThreadGroups,
    standaloneNotes,
    deletingThread,
    deletingNote,
  } = shell;
  return (
    <ThreadHistory
      hasThreadOrNote={hasThreadOrNote}
      loading={threadsLoading}
      loadError={threadsLoadError}
      search={threadSearch}
      searchActive={searchActive}
      searchWaiting={searchWaiting}
      searchFailed={searchFailed}
      groups={visibleThreadGroups}
      notes={standaloneNotes}
      activeConversationId={activeConversationId}
      activeNoteId={activeNoteId}
      now={threadClock}
      threadOptionsId={threadOptionsId}
      deletingThread={deletingThread}
      deletingNote={deletingNote}
      onSearchChange={setThreadSearch}
      onRetryLoad={() => void retryThreads()}
      onRetrySearch={() => void retrySearch()}
      onThreadOptionsChange={setThreadOptionsId}
      onOpenThread={(thread, retainedNote) => handleOpenThread(shell, thread, retainedNote)}
      onArchiveThread={(thread) => handleArchiveThread(shell, thread)}
      onDeleteThread={(thread) => handleDeleteThread(shell, thread)}
      onOpenNote={(note) => handleOpenNote(shell, note)}
      onDeleteNote={(note) => handleDeleteNote(shell, note)}
    />
  );
}

async function startNewThread(shell: WorkspaceShell) {
  if ((await shell.flush(true)) === false) return;
  shell.setRetainedNoteChatStarted(false);
  shell.setSidebar(false);
  void shell.navigate({ to: '/' });
  localStorage.removeItem(storageKeys.lastNote);
  shell.setMobilePane('chat');
}

async function handleOpenThread(
  shell: WorkspaceShell,
  thread: Parameters<NonNullable<ComponentProps<typeof ThreadHistory>['onOpenThread']>>[0],
  retainedNote: Parameters<NonNullable<ComponentProps<typeof ThreadHistory>['onOpenThread']>>[1],
) {
  if ((await shell.flush(true)) === false) return;
  shell.setRetainedNoteChatStarted(false);
  await shell.queryClient.invalidateQueries({ queryKey: ['conversation', thread.id] });
  shell.setSidebar(false);
  void shell.navigate({
    to: '/conversations/$conversationId',
    params: { conversationId: thread.id },
    search: { branch: undefined },
  });
  shell.setMobilePane(retainedNote ? 'note' : 'chat');
}

function handleArchiveThread(
  shell: WorkspaceShell,
  thread: Parameters<NonNullable<ComponentProps<typeof ThreadHistory>['onArchiveThread']>>[0],
) {
  shell.resetThreadDeletion();
  shell.setThreadOptionsId(null);
  shell.setThreadToDelete({ thread, mode: 'archive' });
}

function handleDeleteThread(
  shell: WorkspaceShell,
  thread: Parameters<NonNullable<ComponentProps<typeof ThreadHistory>['onDeleteThread']>>[0],
) {
  shell.resetThreadDeletion();
  shell.setThreadOptionsId(null);
  shell.setThreadToDelete({ thread, mode: 'delete' });
}

async function handleOpenNote(
  shell: WorkspaceShell,
  note: Parameters<NonNullable<ComponentProps<typeof ThreadHistory>['onOpenNote']>>[0],
) {
  if ((await shell.flush(true)) === false) return;
  shell.setSidebar(false);
  void shell.navigate({ to: '/notes/$noteId', params: { noteId: note.id } });
  shell.setMobilePane('note');
}

function handleDeleteNote(
  shell: WorkspaceShell,
  note: Parameters<NonNullable<ComponentProps<typeof ThreadHistory>['onDeleteNote']>>[0],
) {
  shell.resetNoteDeletion();
  shell.setThreadOptionsId(null);
  shell.setNoteToDelete(note);
}

function SidebarFooter({ authControls }: { authControls?: ReactNode }) {
  const { setSettingsOpen, theme, changeTheme } = useWorkspaceShell();
  return (
    <footer>
      <button onClick={() => setSettingsOpen(true)}>
        <Settings /> Settings
      </button>
      <button
        aria-label={`Use ${theme === 'light' ? 'dark' : 'light'} theme`}
        onClick={() => changeTheme(theme === 'light' ? 'dark' : 'light')}
      >
        {theme === 'light' ? <Moon /> : <Sun />} {theme === 'light' ? 'Dark' : 'Light'}
      </button>
      {authControls && <div className="sidebar-auth-controls">{authControls}</div>}
      <a className="sidebar-maker" href="https://fultonring.com" target="_blank" rel="noreferrer">
        A Fulton Ring product
      </a>
    </footer>
  );
}

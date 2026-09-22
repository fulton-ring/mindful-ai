import { ChevronLeft, Moon, Settings, Sun } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { ResizablePanel } from '../../components/ui/resizable';
import { ThreadHistory } from '../../features/chat/ThreadHistory';
import type { WorkspaceData } from '../data/app-types';

const SIDEBAR_WIDTH = 'walden:sidebar-width';
const LAST_NOTE = 'walden:last-note';

export function AppSidebar({
  data,
  authControls,
}: {
  data: WorkspaceData;
  authControls?: ReactNode;
}) {
  const { desktop } = data;
  return (
    <ResizablePanel
      className="sidebar-panel"
      defaultSize={`${Number(localStorage.getItem(SIDEBAR_WIDTH)) || 250}px`}
      minSize="220px"
      maxSize="360px"
      onResize={({ inPixels }) => {
        if (desktop) localStorage.setItem(SIDEBAR_WIDTH, String(Math.round(inPixels)));
      }}
    >
      <SidebarContent data={data} authControls={authControls} />
    </ResizablePanel>
  );
}

function SidebarContent({ data, authControls }: { data: WorkspaceData; authControls?: ReactNode }) {
  const { sidebar, desktop } = data;
  return (
    <aside
      className={`note-sidebar ${sidebar ? 'open' : ''}`}
      aria-label="Threads"
      inert={!desktop && !sidebar}
    >
      <SidebarHeader data={data} />
      <SidebarHistory data={data} />
      <SidebarFooter data={data} authControls={authControls} />
    </aside>
  );
}

function SidebarHeader({ data }: { data: WorkspaceData }) {
  const { setSidebar } = data;
  return (
    <header>
      <div className="brand">
        {/* Concentric ripples: a stone dropped in the pond. Uses
              currentColor so it inverts with the theme. */}
        <span className="brand-mark" aria-hidden>
          <svg viewBox="0 0 24 24" focusable="false">
            <circle cx="12" cy="12" r="2.1" fill="currentColor" />
            <circle
              cx="12"
              cy="12"
              r="6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              opacity="0.72"
            />
            <circle
              cx="12"
              cy="12"
              r="9.6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              opacity="0.4"
            />
          </svg>
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

function SidebarHistory({ data }: { data: WorkspaceData }) {
  return (
    <section className="conversation-history" aria-label="Thread history">
      <div className="sidebar-section-heading">
        <span>Threads</span>
        <button className="text-button" onClick={() => void startNewThread(data)}>
          New thread
        </button>
      </div>
      <SidebarThreadHistory data={data} />
    </section>
  );
}

function SidebarThreadHistory({ data }: { data: WorkspaceData }) {
  const {
    activeConversationId,
    activeNoteId,
    threadOptionsId,
    setThreadOptionsId,
    conversationsQuery,
    notesQuery,
    threadSearch,
    setThreadSearch,
    searchThreadsQuery,
    searchActive,
    searchWaiting,
    searchFailed,
    threadClock,
    visibleThreadGroups,
    standaloneNotes,
    deleteConversation,
    deleteNote,
  } = data;
  return (
    <ThreadHistory
      hasThreadOrNote={
        (conversationsQuery.data?.length ?? 0) > 0 || (notesQuery.data?.length ?? 0) > 0
      }
      loading={conversationsQuery.isPending}
      loadError={conversationsQuery.isError}
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
      deletingThread={deleteConversation.isPending}
      deletingNote={deleteNote.isPending}
      onSearchChange={setThreadSearch}
      onRetryLoad={() => void conversationsQuery.refetch()}
      onRetrySearch={() => void searchThreadsQuery.refetch()}
      onThreadOptionsChange={setThreadOptionsId}
      onOpenThread={(thread, retainedNote) => handleOpenThread(data, thread, retainedNote)}
      onArchiveThread={(thread) => handleArchiveThread(data, thread)}
      onDeleteThread={(thread) => handleDeleteThread(data, thread)}
      onOpenNote={(note) => handleOpenNote(data, note)}
      onDeleteNote={(note) => handleDeleteNote(data, note)}
    />
  );
}

async function startNewThread(data: WorkspaceData) {
  if ((await data.flush(true)) === false) return;
  data.setRetainedNoteChatStarted(false);
  data.setSidebar(false);
  void data.navigate({ to: '/' });
  localStorage.removeItem(LAST_NOTE);
  data.setMobilePane('chat');
}

async function handleOpenThread(
  data: WorkspaceData,
  thread: Parameters<NonNullable<ComponentProps<typeof ThreadHistory>['onOpenThread']>>[0],
  retainedNote: Parameters<NonNullable<ComponentProps<typeof ThreadHistory>['onOpenThread']>>[1],
) {
  if ((await data.flush(true)) === false) return;
  data.setRetainedNoteChatStarted(false);
  await data.queryClient.invalidateQueries({
    queryKey: ['conversation', thread.id],
    exact: true,
  });
  data.setSidebar(false);
  void data.navigate({
    to: '/conversations/$conversationId',
    params: { conversationId: thread.id },
    search: { branch: undefined },
  });
  data.setMobilePane(retainedNote ? 'note' : 'chat');
}

function handleArchiveThread(
  data: WorkspaceData,
  thread: Parameters<NonNullable<ComponentProps<typeof ThreadHistory>['onArchiveThread']>>[0],
) {
  data.deleteConversation.reset();
  data.setThreadOptionsId(null);
  data.setThreadToDelete({ thread, mode: 'archive' });
}

function handleDeleteThread(
  data: WorkspaceData,
  thread: Parameters<NonNullable<ComponentProps<typeof ThreadHistory>['onDeleteThread']>>[0],
) {
  data.deleteConversation.reset();
  data.setThreadOptionsId(null);
  data.setThreadToDelete({ thread, mode: 'delete' });
}

async function handleOpenNote(
  data: WorkspaceData,
  note: Parameters<NonNullable<ComponentProps<typeof ThreadHistory>['onOpenNote']>>[0],
) {
  if ((await data.flush(true)) === false) return;
  data.setSidebar(false);
  void data.navigate({ to: '/notes/$noteId', params: { noteId: note.id } });
  data.setMobilePane('note');
}

function handleDeleteNote(
  data: WorkspaceData,
  note: Parameters<NonNullable<ComponentProps<typeof ThreadHistory>['onDeleteNote']>>[0],
) {
  data.deleteNote.reset();
  data.setThreadOptionsId(null);
  data.setNoteToDelete(note);
}

function SidebarFooter({ data, authControls }: { data: WorkspaceData; authControls?: ReactNode }) {
  const { setSettingsOpen, theme, changeTheme } = data;
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
    </footer>
  );
}

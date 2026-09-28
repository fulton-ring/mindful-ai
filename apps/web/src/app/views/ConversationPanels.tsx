import { Download, Redo2, Undo2, X } from 'lucide-react';
import { lazy, Suspense } from 'react';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '../../components/ui/resizable';
import { ChatPanel } from '../../features/chat/ChatPanel';
import { storageKeys } from '../../lib/storage-keys';
import { track } from '../../lib/telemetry';
import { useMessageBudget } from '../data/use-message-budget';
import { useChatBridge, useNoteDocument, useWorkspaceShell } from '../data/workspace-context';

const NotesEditor = lazy(() =>
  import('../../features/notes/editor/NotesEditor').then(({ NotesEditor }) => ({
    default: NotesEditor,
  })),
);

export function ConversationPanels() {
  const { desktop, noteOnly, noteOpen } = useWorkspaceShell();
  return (
    <ResizablePanelGroup
      className={`conversation-panels ${noteOnly ? 'note-only' : ''}`}
      orientation="horizontal"
      disabled={!desktop}
    >
      <ChatPanelView />
      <ResizableHandle
        aria-label="Resize note"
        disabled={!desktop || !noteOpen || noteOnly}
        className={noteOpen && !noteOnly ? '' : 'hidden'}
      />
      <NotePanelView />
    </ResizablePanelGroup>
  );
}

function ChatPanelView() {
  return (
    <ResizablePanel id="chat" className="chat-resizable-panel" minSize="30%">
      <ChatContent />
    </ResizablePanel>
  );
}

function ChatContent() {
  const { activeConversationId, conversationPending, conversationLoadError } = useWorkspaceShell();
  return activeConversationId && conversationPending ? (
    <ChatLoading />
  ) : activeConversationId && conversationLoadError ? (
    <ChatError />
  ) : (
    <ChatReady />
  );
}

function ChatLoading() {
  return (
    <section className="chat-panel empty-state" aria-label="Thread" aria-busy="true">
      <p>Opening thread…</p>
    </section>
  );
}

function ChatError() {
  const { activeBranchId, activeConversationId, conversationError, retryConversation, navigate } =
    useWorkspaceShell();
  if (!activeConversationId) return null;
  return (
    <section className="chat-panel empty-state" aria-label="Thread" role="alert">
      <h2>Thread could not open</h2>
      <p>
        {conversationError instanceof Error
          ? conversationError.message
          : 'This thread may have expired or been deleted.'}
      </p>
      <div className="button-row">
        <button onClick={() => void retryConversation()}>Try again</button>
        {activeBranchId && (
          <button
            onClick={() =>
              void navigate({
                to: '/conversations/$conversationId',
                params: { conversationId: activeConversationId },
                search: { branch: undefined },
              })
            }
          >
            Open current thread
          </button>
        )}
        <button className="primary" onClick={() => void navigate({ to: '/' })}>
          New thread
        </button>
      </div>
    </section>
  );
}

function ChatReady() {
  const {
    navigate,
    activeConversationId,
    noteOpen,
    desktop,
    mobilePane,
    conversation,
    noteOnly,
    showNote,
    personas,
    personaId,
    setPersonaId,
  } = useWorkspaceShell();
  const bridge = useChatBridge();
  const messageBudget = useMessageBudget();
  return (
    <ChatPanel
      budget={messageBudget.budget}
      onBudget={messageBudget.update}
      visible={!noteOnly && (desktop || mobilePane === 'chat')}
      conversation={conversation}
      scopeId={activeConversationId}
      personas={personas}
      personaId={personaId}
      onPersona={(value) => {
        setPersonaId(value);
        track('persona_selected', { persona_id: value, conversation_id: conversation?.id });
      }}
      noteOpen={noteOpen}
      onOpenNote={showNote}
      onBranch={(branch) => {
        if (!activeConversationId || branch === conversation?.branchId) return;
        void navigate({
          to: '/conversations/$conversationId',
          params: { conversationId: activeConversationId },
          search: { branch },
        });
      }}
      onEnsureConversation={bridge.ensureConversation}
      onAdvance={bridge.refreshConversationNote}
      onConversation={bridge.setConversation}
      onFlush={bridge.flush}
      onProposalStart={bridge.startProposalRequest}
      onProposalCancelable={bridge.setProposalCanceler}
      onProposalCancelled={bridge.applyCancelledNoteState}
      onGhost={bridge.previewProposal}
      onGhostBatch={bridge.completeProposals}
    />
  );
}

function NotePanelView() {
  const { noteOpen, noteOnly, desktop, notePanelRef, noteWidth, closeNote } = useWorkspaceShell();
  return (
    <ResizablePanel
      id="note"
      className={`note-resizable-panel ${noteOpen ? 'is-opening' : ''}`}
      panelRef={notePanelRef}
      collapsible
      collapsedSize="0%"
      minSize="25%"
      maxSize={noteOnly ? '100%' : '70%'}
      defaultSize={noteOpen ? `${noteWidth.current}%` : '0%'}
      onResize={({ asPercentage }) => {
        if (desktop && noteOpen && asPercentage === 0) closeNote();
        if (desktop && noteOpen && asPercentage >= 25) {
          noteWidth.current = asPercentage;
          localStorage.setItem(storageKeys.noteWidth, String(asPercentage));
        }
      }}
    >
      <NoteSurface />
    </ResizablePanel>
  );
}

function NoteSurface() {
  return (
    <main className="note-surface">
      <NoteNotice />
      <NoteBody />
    </main>
  );
}

function NoteNotice() {
  const { notice, setNotice } = useNoteDocument();
  return (
    <>
      {notice && (
        <div className="notice-bar" role="status">
          <span>{notice}</span>
          <button onClick={() => setNotice('')}>Dismiss</button>
        </div>
      )}
    </>
  );
}

function NoteBody() {
  const { activeDocumentNoteId, notePending, noteLoadError } = useNoteDocument();
  return (
    <>{activeDocumentNoteId && (notePending || noteLoadError) ? <NoteLoading /> : <NoteEditor />}</>
  );
}

function NoteLoading() {
  const { conversation, noteOnly, closeNote } = useWorkspaceShell();
  const { draft, notePending, noteError, retryNote } = useNoteDocument();
  return (
    <>
      <div className="note-toolbar">
        <span className="note-title">{conversation?.title || draft?.title || 'Note'}</span>
        {!noteOnly && (
          <button
            className="icon-button"
            aria-label="Close note"
            title="Close note"
            onClick={closeNote}
          >
            <X size={16} aria-hidden />
          </button>
        )}
      </div>
      {notePending ? (
        // A brief fetch, not an empty note. The full empty state -
        // large glyph and heading - reads as a destination and is
        // jarring for something that resolves in a moment.
        <p className="panel-loading" role="status">
          Opening your note…
        </p>
      ) : (
        <Empty
          title="Note could not open"
          body={noteError?.message ?? ''}
          action="Try again"
          onAction={() => void retryNote()}
        />
      )}
    </>
  );
}

function NoteEditor() {
  return (
    <>
      <NoteToolbar />
      <EditorWrap />
    </>
  );
}

function NoteToolbar() {
  return (
    <div className="note-toolbar">
      <NoteTitle />
      <NoteToolbarActions />
    </div>
  );
}

function NoteTitle() {
  const { activeNoteId, conversation, renameConversation } = useWorkspaceShell();
  const { draft, renameStandaloneNote } = useNoteDocument();
  if (conversation) {
    return (
      <input
        key={`${conversation.id}:${conversation.title}`}
        className="note-title"
        aria-label="Thread title"
        defaultValue={conversation.title}
        maxLength={200}
        onBlur={(event) => void renameConversation(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
        placeholder="Untitled thread"
      />
    );
  }
  if (activeNoteId && draft) {
    return (
      <input
        key={`${draft.id}:${draft.title}`}
        className="note-title"
        aria-label="Note title"
        defaultValue={draft.title}
        maxLength={120}
        onBlur={(event) => void renameStandaloneNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
        placeholder="Untitled note"
      />
    );
  }
  return <span className="note-title">New thread</span>;
}

function NoteToolbarActions() {
  const { noteOnly, startChatFromNote, closeNote } = useWorkspaceShell();
  const { draft, unsavedDraft, saveState, proposals, retrySave, exportNote } = useNoteDocument();
  const saveLabel =
    proposals.length && !['dirty', 'saving', 'error', 'conflict'].includes(saveState)
      ? ''
      : {
          idle: '',
          dirty: 'Unsaved',
          saving: 'Saving…',
          saved: 'Saved',
          error: 'Save failed',
          conflict: 'Changed elsewhere',
        }[saveState];
  return (
    <div className="toolbar-actions">
      {noteOnly && (
        <button className="primary" onClick={startChatFromNote}>
          Start chat
        </button>
      )}
      <span className={`save-state ${saveState}`} aria-live="polite">
        {saveLabel}
      </span>
      {saveState === 'error' && (
        <button className="text-button" onClick={() => void retrySave()}>
          Retry
        </button>
      )}
      <HistoryButton direction="undo" />
      <HistoryButton direction="redo" />
      {(draft || unsavedDraft.markdown) && (
        <button
          className="icon-button"
          aria-label="Export Markdown"
          title="Export Markdown"
          onClick={exportNote}
        >
          <Download />
        </button>
      )}
      {!noteOnly && (
        <button
          className="icon-button"
          aria-label="Close note"
          title="Close note"
          onClick={closeNote}
        >
          <X size={16} aria-hidden />
        </button>
      )}
    </div>
  );
}

function HistoryButton({ direction }: { direction: 'undo' | 'redo' }) {
  const { draft, historyPending, canUndo, canRedo, moveNoteHistory } = useNoteDocument();
  if (!draft) return null;
  const canMove = direction === 'undo' ? canUndo : canRedo;
  return (
    <button
      className="icon-button"
      aria-label={`${direction === 'undo' ? 'Undo' : 'Redo'} note action`}
      disabled={historyPending || !canMove}
      onClick={() => void moveNoteHistory(direction)}
    >
      {direction === 'undo' ? <Undo2 /> : <Redo2 />}
    </button>
  );
}

function EditorWrap() {
  return (
    <div className="editor-wrap">
      <EditorCanvas />
      <ConflictCard />
    </div>
  );
}

function EditorCanvas() {
  const { activeConversationId, noteOpen } = useWorkspaceShell();
  const {
    draft,
    unsavedDraft,
    proposal,
    proposals,
    additionQueueRef,
    proposalStreaming,
    streamingProposalIds,
    proposalLoading,
    decisionPending,
    captureRevealRange,
    historyPending,
    changeNote,
    acceptProposal,
    dismissSuggestion,
    moveNoteHistory,
  } = useNoteDocument();
  if (!noteOpen && !draft && !unsavedDraft.markdown && proposals.length === 0) return null;
  return (
    <Suspense fallback={<p role="status">Opening editor…</p>}>
      <NotesEditor
        key={activeConversationId ?? 'new-conversation-note'}
        revealRange={captureRevealRange}
        note={
          draft ?? {
            id: 'unsaved-note',
            title: 'Note',
            markdown: unsavedDraft.markdown,
            revision: 0,
            provenance: unsavedDraft.provenance,
            createdAt: '',
            updatedAt: '',
          }
        }
        proposal={proposal}
        additionQueue={additionQueueRef.current}
        proposals={proposals}
        proposalStreaming={proposalStreaming}
        streamingProposalIds={streamingProposalIds}
        onChange={changeNote}
        onAccept={acceptProposal}
        onUndo={() => void moveNoteHistory('undo')}
        onRedo={() => void moveNoteHistory('redo')}
        onDismiss={dismissSuggestion}
        disabled={decisionPending || historyPending || proposalLoading}
      />
    </Suspense>
  );
}

function ConflictCard() {
  const { saveState, keepLocalDraft, loadLatestNote } = useNoteDocument();
  if (saveState !== 'conflict') return null;
  return (
    <div className="conflict-card" role="alert">
      <strong>This note changed elsewhere.</strong>
      <p>Choose which version to keep.</p>
      <div className="button-row">
        <button onClick={() => void keepLocalDraft()}>Keep my version</button>
        <button onClick={() => void loadLatestNote()}>Use latest</button>
      </div>
    </div>
  );
}

function Empty({
  title,
  body,
  action,
  onAction,
}: {
  title: string;
  body: string;
  action?: string;
  onAction?(): void;
}) {
  return (
    <div className="empty-state">
      <span className="empty-glyph">¶</span>
      <h1>{title}</h1>
      {body && <p>{body}</p>}
      {action && (
        <button className="primary" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}

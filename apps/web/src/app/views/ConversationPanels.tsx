import { Download, Redo2, Undo2, X } from 'lucide-react';
import { type ComponentProps, lazy, Suspense } from 'react';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '../../components/ui/resizable';
import { ChatPanel } from '../../features/chat/ChatPanel';
import { track } from '../../lib/telemetry';
import type { WorkspaceData } from '../data/app-types';
import type { CachedNoteDraft } from '../lifecycle/workspace-helpers';

const NotesEditor = lazy(() =>
  import('../../features/notes/editor/NotesEditor').then(({ NotesEditor }) => ({
    default: NotesEditor,
  })),
);
const NO_PREVIEWS: ReadonlySet<string> = new Set();
type EditorDismiss = NonNullable<ComponentProps<typeof NotesEditor>['onDismiss']>;

export function ConversationPanels({ data }: { data: WorkspaceData }) {
  const { desktop, noteOnly, noteOpen } = data;
  return (
    <ResizablePanelGroup
      className={`conversation-panels ${noteOnly ? 'note-only' : ''}`}
      orientation="horizontal"
      disabled={!desktop}
    >
      <ChatPanelView data={data} />
      <ResizableHandle
        aria-label="Resize note"
        disabled={!desktop || !noteOpen || noteOnly}
        className={noteOpen && !noteOnly ? '' : 'hidden'}
      />
      <NotePanelView data={data} />
    </ResizablePanelGroup>
  );
}

function ChatPanelView({ data }: { data: WorkspaceData }) {
  return (
    <ResizablePanel id="chat" className="chat-resizable-panel" minSize="30%">
      <ChatContent data={data} />
    </ResizablePanel>
  );
}

function ChatContent({ data }: { data: WorkspaceData }) {
  const { activeConversationId, conversationQuery } = data;
  return activeConversationId && conversationQuery.isPending ? (
    <ChatLoading />
  ) : activeConversationId && conversationQuery.isLoadingError ? (
    <ChatError data={data} />
  ) : (
    <ChatReady data={data} />
  );
}

function ChatLoading() {
  return (
    <section className="chat-panel empty-state" aria-label="Thread" aria-busy="true">
      <p>Opening thread…</p>
    </section>
  );
}

function ChatError({ data }: { data: WorkspaceData }) {
  const { activeBranchId, activeConversationId, conversationQuery, navigate } = data;
  if (!activeConversationId) return null;
  return (
    <section className="chat-panel empty-state" aria-label="Thread" role="alert">
      <h2>Thread could not open</h2>
      <p>
        {conversationQuery.error instanceof Error
          ? conversationQuery.error.message
          : 'This thread may have expired or been deleted.'}
      </p>
      <div className="button-row">
        <button onClick={() => void conversationQuery.refetch()}>Try again</button>
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

function ChatReady({ data }: { data: WorkspaceData }) {
  const {
    navigate,
    activeConversationId,
    noteOpen,
    desktop,
    mobilePane,
    draftRef,
    setProposal,
    setProposalRequest,
    cancelProposal,
    conversation,
    noteOnly,
    setConversation,
    flush,
    ensureConversation,
    applyCancelledNoteState,
    previewProposal,
    completeProposals,
    showNote,
    personas,
    personaId,
    setPersonaId,
  } = data;
  return (
    <ChatPanel
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
      onEnsureConversation={ensureConversation}
      onAdvance={() => advanceConversation(data)}
      onConversation={setConversation}
      onFlush={flush}
      onProposalStart={(sourceId) => {
        setProposal(null);
        setProposalRequest({
          sourceId,
          noteId: draftRef.current?.id ?? 'unsaved-note',
          phase: 'streaming',
          previewIds: NO_PREVIEWS,
        });
      }}
      onProposalCancelable={(cancel) => {
        cancelProposal.current = cancel;
      }}
      onProposalCancelled={applyCancelledNoteState}
      onGhost={previewProposal}
      onGhostBatch={completeProposals}
    />
  );
}

function advanceConversation(data: WorkspaceData) {
  if (data.conversation?.noteId) {
    void data.queryClient.invalidateQueries({
      queryKey: ['note-state', data.conversation.noteId],
    });
  }
}

function NotePanelView({ data }: { data: WorkspaceData }) {
  const { noteOpen, noteOnly, desktop, notePanelRef, noteWidth, closeNote } = data;
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
          localStorage.setItem('walden:note-width', String(asPercentage));
        }
      }}
    >
      <NoteSurface data={data} />
    </ResizablePanel>
  );
}

function NoteSurface({ data }: { data: WorkspaceData }) {
  return (
    <main className="note-surface">
      <NoteNotice data={data} />
      <NoteBody data={data} />
    </main>
  );
}

function NoteNotice({ data }: { data: WorkspaceData }) {
  const { notice, setNotice } = data;
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

function NoteBody({ data }: { data: WorkspaceData }) {
  const { activeDocumentNoteId, noteStateQuery } = data;
  return (
    <>
      {activeDocumentNoteId && (noteStateQuery.isPending || noteStateQuery.isLoadingError) ? (
        <NoteLoading data={data} />
      ) : (
        <NoteEditor data={data} />
      )}
    </>
  );
}

function NoteLoading({ data }: { data: WorkspaceData }) {
  const { draft, conversation, noteOnly, noteStateQuery, closeNote } = data;
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
      {noteStateQuery.isPending ? (
        // A brief fetch, not an empty note. The full empty state -
        // large glyph and heading - reads as a destination and is
        // jarring for something that resolves in a moment.
        <p className="panel-loading" role="status">
          Opening your note…
        </p>
      ) : (
        <Empty
          title="Note could not open"
          body={noteStateQuery.error?.message ?? ''}
          action="Try again"
          onAction={() => noteStateQuery.refetch()}
        />
      )}
    </>
  );
}

function NoteEditor({ data }: { data: WorkspaceData }) {
  return (
    <>
      <NoteToolbar data={data} />
      <EditorWrap data={data} />
    </>
  );
}

function NoteToolbar({ data }: { data: WorkspaceData }) {
  return (
    <div className="note-toolbar">
      <NoteTitle data={data} />
      <NoteToolbarActions data={data} />
    </div>
  );
}

function NoteTitle({ data }: { data: WorkspaceData }) {
  const { activeNoteId, draft, conversation, renameConversation, renameStandaloneNote } = data;
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

function NoteToolbarActions({ data }: { data: WorkspaceData }) {
  const {
    draft,
    draftRef,
    unsavedDraft,
    saveState,
    proposals,
    noteOnly,
    doSave,
    persistUnsavedDraft,
    startChatFromNote,
    closeNote,
    exportNote,
  } = data;
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
        <button
          className="text-button"
          onClick={() => void (draftRef.current ? doSave() : persistUnsavedDraft())}
        >
          Retry
        </button>
      )}
      <HistoryButton direction="undo" data={data} />
      <HistoryButton direction="redo" data={data} />
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

function HistoryButton({ direction, data }: { direction: 'undo' | 'redo'; data: WorkspaceData }) {
  const { draft, historyPending, noteStateQuery, moveNoteHistory } = data;
  if (!draft) return null;
  const canMove =
    direction === 'undo' ? noteStateQuery.data?.canUndo : noteStateQuery.data?.canRedo;
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

function EditorWrap({ data }: { data: WorkspaceData }) {
  return (
    <div className="editor-wrap">
      <EditorCanvas data={data} />
      <ConflictCard data={data} />
    </div>
  );
}

function EditorCanvas({ data }: { data: WorkspaceData }) {
  const {
    activeConversationId,
    noteOpen,
    draft,
    draftRef,
    unsavedDraft,
    proposal,
    proposals,
    queueOrderRef,
    proposalStreaming,
    streamingProposalIds,
    proposalLoading,
    decisionPending,
    captureRevealRange,
    historyPending,
    updateDraft,
    updateUnsavedDraft,
    acceptProposal,
    moveNoteHistory,
  } = data;
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
        additionQueue={queueOrderRef.current}
        proposals={proposals}
        proposalStreaming={proposalStreaming}
        streamingProposalIds={streamingProposalIds}
        onChange={(markdown, provenance) =>
          draftRef.current
            ? updateDraft(markdown, provenance)
            : updateUnsavedDraft(markdown, provenance)
        }
        onAccept={acceptProposal}
        onUndo={() => void moveNoteHistory('undo')}
        onRedo={() => void moveNoteHistory('redo')}
        onDismiss={(reason, candidate) => handleEditorDismiss(data, reason, candidate)}
        disabled={decisionPending || historyPending || proposalLoading}
      />
    </Suspense>
  );
}

function handleEditorDismiss(data: WorkspaceData, ...args: Parameters<EditorDismiss>) {
  const [reason, candidate] = args;
  const target = candidate ?? data.proposalRef.current;
  if (!target) return;
  const isActive = data.proposalRef.current?.id === target.id;
  if (data.proposalRequestRef.current?.previewIds.has(target.id)) {
    data.cancelProposalRequest();
    return;
  }
  track('note_suggestion_rejected', { conversation_id: data.conversation?.id });
  if (reason === 'typing') {
    data.dismissedSuggestionIds.current.add(target.id);
    data.setProposals((items) => items.filter((item) => item.id !== target.id));
    if (isActive) data.setProposal(null);
    data.dismissSuggestionsOnSave.current.add(target.id);
    const current = data.draftRef.current;
    if (current) {
      sessionStorage.setItem(
        `walden:draft:${current.id}`,
        JSON.stringify({
          version: 1,
          baseRevision: current.revision,
          markdown: current.markdown,
          provenance: current.provenance,
          dismissedSuggestionIds: [...data.dismissSuggestionsOnSave.current],
        } satisfies CachedNoteDraft),
      );
    }
    return;
  }
  void data.decideSuggestion(target, 'reject').then((updated) => {
    if (updated && isActive) data.setProposal(null);
  });
}

function ConflictCard({ data }: { data: WorkspaceData }) {
  const { saveState, keepLocalDraft, loadLatestNote } = data;
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

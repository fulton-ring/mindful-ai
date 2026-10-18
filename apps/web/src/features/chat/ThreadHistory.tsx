import * as Popover from '@radix-ui/react-popover';
import type { ConversationSummary, Note } from '@walden/contracts';
import { Ellipsis } from 'lucide-react';
import { Fragment } from 'react';
import { isRetainedNote, type ThreadGroup, threadRetention, threadTimestamp } from './thread-list';

type Props = {
  hasThreadOrNote: boolean;
  loading: boolean;
  loadError: boolean;
  search: string;
  searchActive: boolean;
  searchWaiting: boolean;
  searchFailed: boolean;
  groups: ThreadGroup[];
  notes: Note[];
  activeConversationId: string | null;
  activeNoteId: string | null;
  now: Date;
  threadOptionsId: string | null;
  deletingThread: boolean;
  deletingNote: boolean;
  onSearchChange(value: string): void;
  onRetryLoad(): void;
  onRetrySearch(): void;
  onThreadOptionsChange(id: string | null): void;
  onOpenThread(thread: ConversationSummary, retainedNote: boolean): void;
  onArchiveThread(thread: ConversationSummary): void;
  onDeleteThread(thread: ConversationSummary): void;
  onOpenNote(note: Note): void;
  onDeleteNote(note: Note): void;
};

export function ThreadHistory(props: Props) {
  const empty =
    props.groups.length === 0 &&
    props.notes.length === 0 &&
    !props.loading &&
    !props.loadError &&
    !props.searchWaiting &&
    !props.searchFailed;
  return (
    <>
      {props.hasThreadOrNote && (
        <SearchInput value={props.search} onChange={props.onSearchChange} />
      )}
      <ThreadStatus {...props} />
      {empty && (
        <p className="thread-empty">
          {props.searchActive ? 'No threads or notes match that search.' : 'No threads yet.'}
        </p>
      )}
      <ThreadGroups {...props} />
      <StandaloneNotes {...props} />
    </>
  );
}

function SearchInput({ value, onChange }: { value: string; onChange(value: string): void }) {
  return (
    <input
      type="search"
      className="thread-search"
      placeholder="Search threads and notes"
      aria-label="Search threads and notes"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function ThreadStatus({
  loading,
  loadError,
  searchWaiting,
  searchFailed,
  onRetryLoad,
  onRetrySearch,
}: Props) {
  if (loading)
    return (
      <p role="status" className="px-2 py-2 text-sm text-muted-foreground">
        Loading threads…
      </p>
    );
  if (loadError) return <RetryNotice text="Couldn’t load threads." onRetry={onRetryLoad} />;
  if (searchWaiting)
    return (
      <p className="thread-empty" role="status">
        Searching…
      </p>
    );
  if (searchFailed) return <RetryNotice text="Couldn’t search threads." onRetry={onRetrySearch} />;
  return null;
}

function RetryNotice({ text, onRetry }: { text: string; onRetry(): void }) {
  return (
    <div role="alert" className="px-2 py-2 text-sm">
      <p>{text}</p>
      <button type="button" className="text-button mt-1" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

function ThreadGroups(props: Props) {
  return props.groups.map((group) => (
    <Fragment key={group.label}>
      <h2
        className={
          group.label === 'Notes' ? 'sidebar-section-heading notes-section-heading' : 'thread-group'
        }
      >
        {group.label}
      </h2>
      {group.threads.map((thread) => (
        <ThreadRow key={thread.id} thread={thread} {...props} />
      ))}
    </Fragment>
  ));
}

function ThreadRow({ thread, ...props }: Props & { thread: ConversationSummary }) {
  const retainedNote = isRetainedNote(thread, props.now);
  const timestamp = threadTimestamp(
    retainedNote
      ? { ...thread, lastMessageAt: null, updatedAt: thread.noteUpdatedAt ?? thread.updatedAt }
      : thread,
  );
  const retention = retainedNote ? null : threadRetention(thread, props.now);
  return (
    <div className={`conversation-row ${thread.id === props.activeConversationId ? 'active' : ''}`}>
      <button
        className="conversation-link"
        aria-label={`Open ${retainedNote ? 'note' : 'thread'}: ${thread.title}`}
        aria-describedby={retention ? `thread-retention-${thread.id}` : undefined}
        onClick={() => props.onOpenThread(thread, retainedNote)}
      >
        <span className="conversation-title">{thread.title || 'Untitled thread'}</span>
        {timestamp && (
          <time
            className="conversation-timestamp"
            dateTime={timestamp.value}
            title={timestamp.full}
          >
            {timestamp.text}
          </time>
        )}
        {retention && <RetentionNotice thread={thread} value={retention} />}
      </button>
      <ThreadOptions thread={thread} {...props} />
    </div>
  );
}

function RetentionNotice({ thread, value }: { thread: ConversationSummary; value: string }) {
  const consequence = thread.noteId
    ? 'message history is permanently cleared; your note is kept'
    : 'this thread is permanently deleted';
  return (
    <span
      className="conversation-retention"
      id={`thread-retention-${thread.id}`}
      title={
        thread.expiresAt === null
          ? 'This thread does not expire automatically.'
          : `At expiry, ${consequence}. Expiry: ${new Date(thread.expiresAt).toLocaleString()}.`
      }
    >
      {value}
    </span>
  );
}

function ThreadOptions({ thread, ...props }: Props & { thread: ConversationSummary }) {
  return (
    <Popover.Root
      open={props.threadOptionsId === thread.id}
      onOpenChange={(open) => props.onThreadOptionsChange(open ? thread.id : null)}
    >
      <Popover.Trigger asChild>
        <button
          className="icon-button"
          aria-label={`Thread options: ${thread.title}`}
          disabled={props.deletingThread}
        >
          <Ellipsis />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="thread-options-menu" side="right" align="start">
          {thread.noteId && (
            <button type="button" onClick={() => props.onArchiveThread(thread)}>
              Archive thread
            </button>
          )}
          <button type="button" className="danger" onClick={() => props.onDeleteThread(thread)}>
            {thread.noteId ? 'Delete everything' : 'Delete thread'}
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function StandaloneNotes(props: Props) {
  if (!props.notes.length) return null;
  const alreadyListed = props.groups.some((group) => group.label === 'Notes');
  return (
    <>
      {!alreadyListed && <h2 className="sidebar-section-heading notes-section-heading">Notes</h2>}
      {props.notes.map((note) => (
        <NoteRow key={note.id} note={note} {...props} />
      ))}
    </>
  );
}

function NoteRow({ note, ...props }: Props & { note: Note }) {
  const timestamp = new Date(note.updatedAt);
  return (
    <div className={`conversation-row ${note.id === props.activeNoteId ? 'active' : ''}`}>
      <button
        className="conversation-link"
        aria-label={`Open note: ${note.title}`}
        onClick={() => props.onOpenNote(note)}
      >
        <span className="conversation-title">{note.title || 'Untitled note'}</span>
        <time
          className="conversation-timestamp"
          dateTime={note.updatedAt}
          title={timestamp.toLocaleString()}
        >
          {timestamp.toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })}
        </time>
      </button>
      <Popover.Root
        open={props.threadOptionsId === `note:${note.id}`}
        onOpenChange={(open) => props.onThreadOptionsChange(open ? `note:${note.id}` : null)}
      >
        <Popover.Trigger asChild>
          <button
            className="icon-button"
            aria-label={`Note options: ${note.title}`}
            disabled={props.deletingNote}
          >
            <Ellipsis />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className="thread-options-menu" side="right" align="start">
            <button type="button" className="danger" onClick={() => props.onDeleteNote(note)}>
              Delete everything
            </button>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

import { useRef } from 'react';
import { NoteSuggestionList } from './NoteSuggestionList';
import { type NotesEditorProps, useNoteEditor } from './use-note-editor';

export type { NotesEditorProps } from './use-note-editor';

export function NotesEditor(props: NotesEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const { projected, revealUnfinished } = useNoteEditor(host, props);
  const proposal = props.proposal;
  const proposalStreaming = props.proposalStreaming ?? false;

  return (
    <div className={`notes-editor ${proposal ? 'has-proposal' : ''}`}>
      <NoteSuggestionList
        issues={projected.issues}
        proposals={props.proposals}
        onDismiss={props.onDismiss}
      />
      <div ref={host} aria-label="Markdown note editor" />
      {proposal && (
        <div className="sr-only" role="status" aria-live="polite">
          {proposalStreaming || revealUnfinished
            ? 'Preparing a note suggestion.'
            : 'Note suggestion ready. Accept with Tab or reject with Escape while editing the suggestion.'}
        </div>
      )}
    </div>
  );
}

export default NotesEditor;

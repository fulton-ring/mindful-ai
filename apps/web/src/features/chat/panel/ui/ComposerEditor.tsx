import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder, ViewPlugin } from '@codemirror/view';
import { type RefObject, useEffect, useRef } from 'react';
import {
  markdownPreviewDecorations,
  markdownPreviewTheme,
} from '../../../notes/markdown/markdown-preview';

type Props = {
  value: string;
  disabled: boolean;
  inputRef: RefObject<HTMLElement | null>;
  onChange(value: string): void;
  onSend(): void;
  onPasteFiles(files: File[]): void;
};

type Callbacks = Pick<Props, 'onChange' | 'onSend' | 'onPasteFiles'>;

const preview = ViewPlugin.fromClass(
  class {
    decorations;
    constructor(view: EditorView) {
      this.decorations = markdownPreviewDecorations(
        view.state.doc.toString(),
        view.state.selection.main.head,
      );
    }
    update(update: { view: EditorView; docChanged: boolean; selectionSet: boolean }) {
      if (update.docChanged || update.selectionSet)
        this.decorations = markdownPreviewDecorations(
          update.view.state.doc.toString(),
          update.view.state.selection.main.head,
        );
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

function pasteHandler(event: ClipboardEvent, callbacks: RefObject<Callbacks>) {
  const files = [...(event.clipboardData?.files ?? [])];
  const text = event.clipboardData?.getData('text/plain') ?? '';
  if (!files.length && text.length <= 2000) return false;
  event.preventDefault();
  callbacks.current.onPasteFiles(
    files.length ? files : [new File([text], 'Pasted text.md', { type: 'text/markdown' })],
  );
  return true;
}

function createComposerView(
  parent: HTMLElement,
  value: string,
  disabled: boolean,
  editable: Compartment,
  callbacks: RefObject<Callbacks>,
) {
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: value,
      extensions: [
        editable.of(EditorView.editable.of(!disabled)),
        EditorState.transactionFilter.of((transaction) =>
          transaction.newDoc.length > 2000 ? [] : transaction,
        ),
        history(),
        preview,
        markdownPreviewTheme,
        EditorView.lineWrapping,
        placeholder('Message…'),
        EditorView.contentAttributes.of({ 'aria-label': 'Message' }),
        EditorView.theme({
          '&': {
            border: '0',
            background: 'transparent',
            fontFamily: '"IBM Plex Sans", sans-serif',
          },
          '.cm-scroller': {
            maxHeight: '150px',
            overflow: 'auto',
            fontFamily: '"IBM Plex Sans", sans-serif',
          },
          '.cm-content': {
            padding: '0.45rem',
            minHeight: '3rem',
            fontFamily: 'inherit',
            lineHeight: '1.45',
          },
          '&.cm-focused': { outline: 'none !important' },
        }),
        keymap.of([
          {
            key: 'Enter',
            run: () => {
              callbacks.current.onSend();
              return true;
            },
          },
          {
            key: 'Shift-Enter',
            run: (editor) => {
              editor.dispatch(editor.state.replaceSelection('\n'));
              return true;
            },
          },
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        EditorView.domEventHandlers({ paste: (event) => pasteHandler(event, callbacks) }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
        }),
      ],
    }),
  });
}

export function ComposerEditor({
  value,
  disabled,
  inputRef,
  onChange,
  onSend,
  onPasteFiles,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const editable = useRef(new Compartment());
  const callbacks = useRef({ onChange, onSend, onPasteFiles });
  callbacks.current = { onChange, onSend, onPasteFiles };

  useEffect(() => {
    if (!host.current) return;
    const view = createComposerView(host.current, value, disabled, editable.current, callbacks);
    editor.current = view;
    inputRef.current = view.contentDOM;
    return () => {
      view.destroy();
      editor.current = null;
      inputRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = editor.current;
    if (!view) return;
    if (view.state.doc.toString() !== value)
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    view.dispatch({ effects: editable.current.reconfigure(EditorView.editable.of(!disabled)) });
  }, [value, disabled]);

  return (
    <div className="composer-editor-wrap">
      <div ref={host} className="composer-editor" />
    </div>
  );
}

import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
  invertedEffects,
} from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import {
  ChangeSet,
  Compartment,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  Transaction,
} from '@codemirror/state';
import { Decoration, EditorView, keymap, type ViewUpdate } from '@codemirror/view';
import type { EditProposal, Note, ProvenanceSpan } from '@walden/contracts';
import { minimalEdit, resolveEdit, updateProvenance } from '@walden/domain';
import { markdownPreviewDecorations, markdownPreviewTheme } from '../markdown/markdown-preview';
import {
  createSuggestionDecorations,
  type SuggestionActions,
} from '../proposals/NoteSuggestionList';
import { candidateOnLine, type PendingProjection } from '../proposals/pending-projection';

// CodeMirror state, keymaps and update handling for the note editor. Nothing here uses React:
// the hook in use-note-editor.ts reaches the latest props through EditorRefs.

export type MutableRef<T> = { current: T };
export type EditorCallbacks = {
  onChange: (markdown: string, provenance: ProvenanceSpan[]) => void;
  onAccept: (proposal: EditProposal) => void;
  onDismiss: (reason?: 'typing' | 'reject', proposal?: EditProposal) => void;
  onUndo?: () => void;
  onRedo?: () => void;
};
export type EditorRefs = {
  spans: MutableRef<ProvenanceSpan[]>;
  proposal: MutableRef<EditProposal | null>;
  proposals: MutableRef<readonly EditProposal[]>;
  projection: MutableRef<PendingProjection | null>;
  projectionChanges: MutableRef<ChangeSet | null>;
  caret: MutableRef<number | null>;
  committed: MutableRef<string>;
  acceptBlocked: MutableRef<boolean>;
  disabled: MutableRef<boolean>;
  proposalStreaming: MutableRef<boolean>;
  streamingProposalIds: MutableRef<ReadonlySet<string>>;
  callbacks: MutableRef<EditorCallbacks>;
};

const externalChange = StateEffect.define<void>();
const suggestionEffect = StateEffect.define<DecorationSet>();
const previewEffect = StateEffect.define<DecorationSet>();
export const captureRevealEffect = StateEffect.define<{ from: number; to: number } | null>();
const provenanceValueEffect = StateEffect.define<ProvenanceSpan[]>();
export const readonlyCompartment = new Compartment();
type DecorationSet = ReturnType<typeof Decoration.set>;

const suggestionField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(suggestionEffect)) return effect.value;
    }
    return transaction.docChanged ? value.map(transaction.changes) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const previewField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(previewEffect)) return effect.value;
    return transaction.docChanged || transaction.selection
      ? markdownPreviewDecorations(
          transaction.newDoc.toString(),
          transaction.newSelection.main.head,
        )
      : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const captureRevealField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(captureRevealEffect)) return revealDecoration(effect.value);
    }
    return transaction.docChanged ? value.map(transaction.changes) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const provenanceState = StateField.define<ProvenanceSpan[]>({
  create: () => [],
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(provenanceValueEffect)) return effect.value;
    }
    if (!transaction.docChanged || hasExternalChange(transaction)) return value;
    return updateProvenanceForChanges(value, transaction.changes);
  },
});

function revealDecoration(value: { from: number; to: number } | null): DecorationSet {
  if (!value || value.to <= value.from) return Decoration.none;
  return Decoration.set([
    Decoration.mark({ class: 'notes-editor__capture-reveal' }).range(value.from, value.to),
  ]);
}

function hasExternalChange(transaction: Transaction): boolean {
  return transaction.effects.some((effect) => effect.is(externalChange));
}

type TextChange = { from: number; to: number; insert: string };

/** The changes as a list, positions relative to the document before them. */
function changeList(changes: ChangeSet): TextChange[] {
  const list: TextChange[] = [];
  changes.iterChanges((from, to, _fromB, _toB, inserted) =>
    list.push({ from, to, insert: inserted.toString() }),
  );
  return list;
}

/** Applies changes to provenance from the end, so earlier positions stay valid. */
function provenanceAfter(
  value: ProvenanceSpan[],
  changes: readonly TextChange[],
): ProvenanceSpan[] {
  let next = value;
  for (const change of [...changes].reverse())
    next = updateProvenance(next, change.from, change.to, change.insert);
  return next;
}

function updateProvenanceForChanges(value: ProvenanceSpan[], changes: ChangeSet): ProvenanceSpan[] {
  return provenanceAfter(value, changeList(changes));
}

function projectedPosition(
  canonical: number,
  projection: PendingProjection | null,
  document: string,
): number {
  const shift = (projection?.ranges ?? [])
    .filter((range) => range.sourceFrom <= canonical)
    .reduce((total, range) => total + range.insert.length - (range.sourceTo - range.sourceFrom), 0);
  return Math.max(0, Math.min(canonical + shift, document.length));
}

function suggestionActions(refs: EditorRefs): SuggestionActions {
  return {
    onAccept: (candidate) =>
      refs.callbacks.current.onAccept(
        refs.proposals.current.find((value) => value.id === candidate.id) ?? candidate,
      ),
    onDismiss: (candidate) => refs.callbacks.current.onDismiss('reject', candidate),
    disabled: (candidate) => isSuggestionBlocked(refs, candidate),
    streaming: (candidate) =>
      refs.streamingProposalIds.current.has(candidate.id) ||
      (candidate.id === refs.proposal.current?.id && refs.proposalStreaming.current),
  };
}

function isSuggestionBlocked(refs: EditorRefs, candidate: EditProposal): boolean {
  return (
    refs.disabled.current ||
    refs.streamingProposalIds.current.has(candidate.id) ||
    (candidate.id === refs.proposal.current?.id && refs.acceptBlocked.current)
  );
}

function findSuggestion(refs: EditorRefs, projection: PendingProjection, position: number) {
  const selected = candidateOnLine(projection, position);
  if (selected.kind !== 'unique') return null;
  return refs.proposals.current.find((value) => value.id === selected.proposalId) ?? null;
}

function acceptSuggestion(refs: EditorRefs, editor: EditorView): boolean {
  const projection = refs.projection.current;
  if (!projection) return false;
  const candidate = findSuggestion(refs, projection, editor.state.selection.main.head);
  if (!candidate || isSuggestionBlocked(refs, candidate)) return false;
  refs.callbacks.current.onAccept(candidate);
  return true;
}

function dismissSuggestion(refs: EditorRefs, editor: EditorView): boolean {
  const projection = refs.projection.current;
  if (!projection) return false;
  const candidate = findSuggestion(refs, projection, editor.state.selection.main.head);
  if (!candidate) return false;
  refs.callbacks.current.onDismiss('reject', candidate);
  return true;
}

function historyKeyBindings(refs: EditorRefs) {
  return [
    {
      key: 'Mod-z',
      run: () => runHistoryAction(refs, 'onUndo'),
      shift: () => runHistoryAction(refs, 'onRedo'),
    },
    { key: 'Mod-y', run: () => runHistoryAction(refs, 'onRedo') },
  ];
}

function runHistoryAction(refs: EditorRefs, action: 'onUndo' | 'onRedo'): boolean {
  const callback = refs.callbacks.current[action];
  if (!callback) return false;
  if (!refs.disabled.current) callback();
  return true;
}

function suggestionKeyBindings(refs: EditorRefs) {
  const hasSuggestionOnLine = (editor: EditorView) => {
    const projection = refs.projection.current;
    return (
      projection && candidateOnLine(projection, editor.state.selection.main.head).kind !== 'none'
    );
  };
  const canNestUnderPreviousLine = (editor: EditorView) => {
    const line = editor.state.doc.lineAt(editor.state.selection.main.from);
    if (line.number === 1) return false;
    const previous = editor.state.doc.line(line.number - 1).text;
    if (!previous.trim()) return false;
    const previousIndent = previous.match(/^[ \t]*/)?.[0].length ?? 0;
    const currentIndent = line.text.match(/^[ \t]*/)?.[0].length ?? 0;
    const previousIsList = /^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/.test(previous);
    return (previousIsList || previousIndent > 0) && currentIndent <= previousIndent;
  };
  return [
    {
      key: 'Tab',
      run: (editor: EditorView) => {
        if (hasSuggestionOnLine(editor)) {
          acceptSuggestion(refs, editor);
          return true;
        }
        return canNestUnderPreviousLine(editor) ? indentMore(editor) : true;
      },
    },
    {
      key: 'Shift-Tab',
      run: (editor: EditorView) => (hasSuggestionOnLine(editor) ? true : indentLess(editor)),
    },
    {
      key: 'Escape',
      run: (editor: EditorView) => dismissSuggestion(refs, editor),
    },
  ];
}

function createKeymap(refs: EditorRefs) {
  return Prec.high(keymap.of([...historyKeyBindings(refs), ...suggestionKeyBindings(refs)]));
}

/**
 * Whether an edit lands on a suggested range. A deletion must cover an empty range; a replacement
 * must overlap it. Typing at a caret counts inside the range, and at its edges only when
 * `edgesCount`: projected suggestions are separate widgets, so typing right before or after one
 * is ordinary writing, while the unprojected current proposal is plain text whose edges belong
 * to it.
 */
function changeTouches(
  range: { from: number; to: number },
  change: { from: number; to: number },
  edgesCount: boolean,
): boolean {
  if (range.from === range.to) return change.from <= range.from && change.to >= range.to;
  if (change.from !== change.to) return change.from < range.to && change.to > range.from;
  return edgesCount
    ? change.from >= range.from && change.from <= range.to
    : change.from > range.from && change.from < range.to;
}

function dismissTouchedSuggestions(
  refs: EditorRefs,
  projection: PendingProjection,
  update: ViewUpdate,
) {
  const touched = new Set<string>();
  update.changes.iterChangedRanges((from, to) => {
    for (const range of projection.ranges)
      if (changeTouches(range, { from, to }, false)) touched.add(range.proposalId);
  });
  for (const id of touched) {
    const candidate = refs.proposals.current.find((value) => value.id === id);
    if (candidate) refs.callbacks.current.onDismiss('typing', candidate);
  }
}

function saveProjectedChanges(refs: EditorRefs, projectionChanges: ChangeSet, update: ViewUpdate) {
  const changes = changeList(update.changes);
  const canonicalChanges = changes.map((change) => ({
    from: projectionChanges.invertedDesc.mapPos(change.from, -1),
    to: projectionChanges.invertedDesc.mapPos(change.to, 1),
    insert: change.insert,
  }));
  const lastChange = canonicalChanges.at(-1);
  refs.caret.current = lastChange ? lastChange.from + lastChange.insert.length : null;
  const canonical = ChangeSet.of(canonicalChanges, refs.committed.current.length).apply(
    EditorState.create({ doc: refs.committed.current }).doc,
  );
  const spans = provenanceAfter(refs.spans.current, canonicalChanges);
  refs.spans.current = spans;
  refs.callbacks.current.onChange(canonical.toString(), spans);
}

function dismissCurrentProposal(refs: EditorRefs, update: ViewUpdate) {
  const currentProposal = refs.proposal.current;
  let resolved: { from: number; to: number } | null = null;
  if (currentProposal) {
    try {
      resolved = resolveEdit(
        update.startState.doc.toString(),
        currentProposal.oldText,
        currentProposal.newText,
      );
    } catch {
      resolved = null;
    }
  }
  if (!resolved) return;
  for (const change of changeList(update.changes)) {
    if (changeTouches(resolved, change, true)) refs.callbacks.current.onDismiss('typing');
  }
}

function handleEditorUpdate(update: ViewUpdate, refs: EditorRefs) {
  // The caret is only kept for the re-render that answers an edit; once the user moves it, the
  // editor's own selection is the one to keep.
  if (update.selectionSet && !update.docChanged) refs.caret.current = null;
  if (!update.docChanged || update.transactions.some(hasExternalChange)) return;
  const projection = refs.projection.current;
  const projectionChanges = refs.projectionChanges.current;
  if (projection && projectionChanges) {
    dismissTouchedSuggestions(refs, projection, update);
    saveProjectedChanges(refs, projectionChanges, update);
    return;
  }
  dismissCurrentProposal(refs, update);
  const changedSpans = update.state.field(provenanceState);
  refs.spans.current = changedSpans;
  refs.callbacks.current.onChange(update.state.doc.toString(), changedSpans);
}

export function createEditorExtensions(refs: EditorRefs, readOnly: boolean) {
  return [
    history(),
    invertedEffects.of((transaction) => {
      if (!transaction.docChanged || hasExternalChange(transaction)) return [];
      return [provenanceValueEffect.of(transaction.startState.field(provenanceState))];
    }),
    EditorView.lineWrapping,
    markdownPreviewTheme,
    EditorView.theme({
      '&': { fontFamily: '"IBM Plex Sans", sans-serif', fontSize: '16px' },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.65' },
      '.cm-content': { padding: '0 0 6rem', caretColor: 'var(--ink)' },
      '.cm-line': { padding: '0' },
    }),
    markdown(),
    suggestionField,
    previewField,
    captureRevealField,
    provenanceState,
    readonlyCompartment.of(EditorState.readOnly.of(refs.disabled.current || readOnly)),
    createKeymap(refs),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.updateListener.of((update) => handleEditorUpdate(update, refs)),
  ];
}

export function syncEditorDocument(
  view: EditorView,
  refs: EditorRefs,
  note: Note,
  projected: PendingProjection,
) {
  const current = view.state.doc.toString();
  const caret = refs.caret.current;
  refs.caret.current = null;
  if (current === projected.text) {
    refs.spans.current = note.provenance;
    return;
  }
  view.dispatch({
    changes: minimalEdit(current, projected.text),
    ...(caret === null
      ? {}
      : { selection: { anchor: projectedPosition(caret, projected, projected.text) } }),
    effects: [externalChange.of(undefined), provenanceValueEffect.of(note.provenance)],
    annotations: Transaction.addToHistory.of(false),
  });
  refs.spans.current = note.provenance;
}

/** Redraws the suggestion widgets and markdown preview, and resets provenance to the note's. */
export function redrawDecorations(
  view: EditorView,
  refs: EditorRefs,
  projection: PendingProjection,
  provenance: ProvenanceSpan[],
) {
  view.dispatch({
    effects: [
      suggestionEffect.of(
        createSuggestionDecorations(projection, refs.proposals.current, suggestionActions(refs)),
      ),
      previewEffect.of(markdownPreviewDecorations(projection.text, view.state.selection.main.head)),
      provenanceValueEffect.of(provenance),
    ],
  });
}

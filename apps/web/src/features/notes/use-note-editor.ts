import { defaultKeymap, history, historyKeymap, invertedEffects } from '@codemirror/commands';
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
import { useEffect, useRef, useState } from 'react';
import { markdownPreviewDecorations, markdownPreviewTheme } from './markdown-preview';
import {
  createSuggestionDecorations,
  displayEdit,
  type SuggestionActions,
} from './NoteSuggestionList';
import { candidateOnLine, type PendingProjection, projectPendingEdits } from './pending-projection';

export type NotesEditorProps = {
  note: Note;
  proposal: EditProposal | null;
  proposals: EditProposal[];
  /** Every addition on the note in order, accepted ones included. */
  additionQueue?: readonly { id: string; text: string; accepted: boolean }[];
  onChange: (markdown: string, provenance: ProvenanceSpan[]) => void;
  onAccept: (proposal: EditProposal) => void;
  onDismiss: (reason?: 'typing' | 'reject', proposal?: EditProposal) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  disabled?: boolean;
  readOnly?: boolean;
  revealRange?: { from: number; to: number; key: number } | null;
  proposalStreaming?: boolean;
  streamingProposalIds?: ReadonlySet<string>;
  revealProposalImmediately?: boolean;
};

type HostRef = { current: HTMLDivElement | null };
type MutableRef<T> = { current: T };
type EditorCallbacks = Pick<
  NotesEditorProps,
  'onChange' | 'onAccept' | 'onDismiss' | 'onUndo' | 'onRedo'
>;
type EditorRefs = {
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
type UpdateContext = {
  refs: EditorRefs;
  note: Note;
};

const externalChange = StateEffect.define<void>();
const suggestionEffect = StateEffect.define<DecorationSet>();
const previewEffect = StateEffect.define<DecorationSet>();
const captureRevealEffect = StateEffect.define<{ from: number; to: number } | null>();
const provenanceValueEffect = StateEffect.define<ProvenanceSpan[]>();
const readonlyCompartment = new Compartment();
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
    return transaction.docChanged
      ? markdownPreviewDecorations(transaction.newDoc.toString())
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

function updateProvenanceForChanges(value: ProvenanceSpan[], changes: ChangeSet): ProvenanceSpan[] {
  const edits: Array<{ from: number; to: number; insert: string }> = [];
  changes.iterChanges((from, to, _fromB, _toB, inserted) =>
    edits.push({ from, to, insert: inserted.toString() }),
  );
  let next = value;
  for (const edit of edits.reverse())
    next = updateProvenance(next, edit.from, edit.to, edit.insert);
  return next;
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
    disabled: (candidate) =>
      refs.disabled.current ||
      refs.streamingProposalIds.current.has(candidate.id) ||
      (candidate.id === refs.proposal.current?.id && refs.acceptBlocked.current),
    streaming: (candidate) =>
      refs.streamingProposalIds.current.has(candidate.id) ||
      (candidate.id === refs.proposal.current?.id && refs.proposalStreaming.current),
  };
}

type EditorUpdate = ViewUpdate;

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
  return [
    {
      key: 'Tab',
      run: (editor: EditorView) => acceptSuggestion(refs, editor),
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

function changedRanges(update: EditorUpdate) {
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  update.changes.iterChanges((from, to, _fromB, _toB, inserted) =>
    changes.push({ from, to, insert: inserted.toString() }),
  );
  return changes;
}

function touchesSuggestion(range: PendingProjection['ranges'][number], from: number, to: number) {
  return range.from === range.to
    ? from <= range.from && to >= range.to
    : from === to
      ? from > range.from && from < range.to
      : from < range.to && to > range.from;
}

function dismissTouchedSuggestions(
  refs: EditorRefs,
  projection: PendingProjection,
  update: EditorUpdate,
) {
  const touched = new Set<string>();
  update.changes.iterChangedRanges((from, to) => {
    for (const range of projection.ranges)
      if (touchesSuggestion(range, from, to)) touched.add(range.proposalId);
  });
  for (const id of touched) {
    const candidate = refs.proposals.current.find((value) => value.id === id);
    if (candidate) refs.callbacks.current.onDismiss('typing', candidate);
  }
}

function saveProjectedChanges(
  refs: EditorRefs,
  projectionChanges: ChangeSet,
  update: EditorUpdate,
) {
  const changes = changedRanges(update);
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
  let spans = refs.spans.current;
  for (const change of [...canonicalChanges].reverse()) {
    spans = updateProvenance(spans, change.from, change.to, change.insert);
  }
  refs.spans.current = spans;
  refs.callbacks.current.onChange(canonical.toString(), spans);
}

function touchesCurrentProposal(
  resolved: { from: number; to: number } | null,
  change: { from: number; to: number },
): boolean {
  if (!resolved) return false;
  return resolved.from === resolved.to
    ? change.from <= resolved.from && change.to >= resolved.to
    : change.from === change.to
      ? change.from >= resolved.from && change.from <= resolved.to
      : change.from < resolved.to && change.to > resolved.from;
}

function dismissCurrentProposal(refs: EditorRefs, update: EditorUpdate) {
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
  for (const change of changedRanges(update)) {
    if (touchesCurrentProposal(resolved, change)) refs.callbacks.current.onDismiss('typing');
  }
}

function handleEditorUpdate(update: EditorUpdate, context: UpdateContext) {
  if (!update.docChanged || update.transactions.some(hasExternalChange)) return;
  const { refs } = context;
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

function createEditorExtensions(refs: EditorRefs, note: Note, readOnly: boolean) {
  const context = { refs, note };
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
    EditorView.updateListener.of((update) => handleEditorUpdate(update, context)),
  ];
}

function mountEditor(
  host: HostRef,
  refs: EditorRefs,
  note: Note,
  projection: PendingProjection,
  readOnly: boolean,
) {
  if (!host.current) return undefined;
  const decorations = createSuggestionDecorations(
    projection,
    refs.proposals.current,
    suggestionActions(refs),
  );
  const state = EditorState.create({
    doc: projection.text,
    extensions: createEditorExtensions(refs, note, readOnly),
  });
  const view = new EditorView({ state, parent: host.current });
  refs.spans.current = note.provenance;
  view.dispatch({
    effects: [
      suggestionEffect.of(decorations),
      previewEffect.of(markdownPreviewDecorations(projection.text)),
      provenanceValueEffect.of(note.provenance),
    ],
  });
  return { view, cleanup: () => view.destroy() };
}

function useEditorMount(
  host: HostRef,
  refs: EditorRefs,
  note: Note,
  projection: PendingProjection,
  readOnly: boolean,
) {
  const viewRef = useRef<EditorView | null>(null);
  useEffect(() => {
    const mounted = mountEditor(host, refs, note, projection, readOnly);
    if (!mounted) return;
    viewRef.current = mounted.view;
    return () => {
      mounted.cleanup();
      viewRef.current = null;
    };
  }, [host, suggestionEffect, previewEffect, provenanceValueEffect, readonlyCompartment]);
  return viewRef;
}

function useReveal(
  proposal: EditProposal | null,
  targetInsert: string,
  proposalStreaming: boolean,
  revealProposalImmediately: boolean,
) {
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const revealTargetRef = useRef({ id: proposal?.id ?? null, text: targetInsert });
  const [reveal, setReveal] = useState<{ id: string | null; length: number }>(() => ({
    id: revealProposalImmediately ? (proposal?.id ?? null) : null,
    length: revealProposalImmediately ? targetInsert.length : 0,
  }));
  revealTargetRef.current = { id: proposal?.id ?? null, text: targetInsert };
  useEffect(() => {
    if (!proposal) {
      setReveal({ id: null, length: 0 });
      return;
    }
    if (reduceMotion || revealProposalImmediately) {
      setReveal({ id: proposal.id, length: targetInsert.length });
      return;
    }
    setReveal((current) => (current.id === proposal.id ? current : { id: proposal.id, length: 0 }));
    const timer = window.setInterval(() => {
      setReveal((current) =>
        revealStep(current, proposal.id, revealTargetRef.current, proposalStreaming),
      );
    }, 16);
    return () => window.clearInterval(timer);
  }, [proposal?.id, proposalStreaming, reduceMotion, revealProposalImmediately]);
  useEffect(() => {
    if (!proposal || !reduceMotion) return;
    setReveal({ id: proposal.id, length: targetInsert.length });
  }, [proposal?.id, reduceMotion, targetInsert]);
  const visibleLength = proposal && reveal.id === proposal.id ? reveal.length : 0;
  return { visibleLength, revealUnfinished: visibleLength < targetInsert.length };
}

function revealStep(
  current: { id: string | null; length: number },
  proposalId: string,
  target: { id: string | null; text: string },
  streaming: boolean,
) {
  if (current.id !== proposalId || target.id !== proposalId || current.length >= target.text.length)
    return current;
  const remaining = target.text.length - current.length;
  const step = streaming ? 1 : Math.max(1, Math.ceil(remaining / 16));
  return { ...current, length: Math.min(target.text.length, current.length + step) };
}

function useEditorSync(
  viewRef: MutableRef<EditorView | null>,
  refs: EditorRefs,
  note: Note,
  proposal: EditProposal | null,
  proposals: readonly EditProposal[],
  projected: PendingProjection,
  acceptBlocked: boolean,
  disabled: boolean,
  readOnly: boolean,
  proposalStreaming: boolean,
  streamingProposalIds: ReadonlySet<string>,
  targetInsert: string,
  visibleLength: number,
) {
  const scrolledProposalRef = useRef<string | null>(null);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    syncEditorDocument(view, refs, note, projected);
    const actions = suggestionActions(refs);
    view.dispatch({
      effects: [
        suggestionEffect.of(createSuggestionDecorations(projected, proposals, actions)),
        previewEffect.of(markdownPreviewDecorations(projected.text)),
        provenanceValueEffect.of(note.provenance),
      ],
    });
    scrollToProposal(view, scrolledProposalRef, proposal);
  }, [
    viewRef,
    refs,
    note.markdown,
    note.revision,
    note.provenance,
    proposal,
    proposals,
    projected,
    acceptBlocked,
    disabled,
    readOnly,
    proposalStreaming,
    streamingProposalIds,
    targetInsert,
    visibleLength,
  ]);
}

function syncEditorDocument(
  view: EditorView,
  refs: EditorRefs,
  note: Note,
  projected: PendingProjection,
) {
  const current = view.state.doc.toString();
  if (current === projected.text) {
    refs.spans.current = note.provenance;
    return;
  }
  const caret = refs.caret.current;
  refs.caret.current = null;
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

function scrollToProposal(
  view: EditorView,
  scrolledProposalRef: MutableRef<string | null>,
  proposal: EditProposal | null,
) {
  const shouldScroll = Boolean(
    proposal && scrolledProposalRef.current !== proposal.id && !view.hasFocus,
  );
  if (shouldScroll && proposal) scrolledProposalRef.current = proposal.id;
  if (!proposal) scrolledProposalRef.current = null;
  if (shouldScroll)
    window.requestAnimationFrame(() => {
      const widget = view.dom.querySelector<HTMLElement>('.notes-editor__suggestion');
      widget?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    });
}

function useReadonly(viewRef: MutableRef<EditorView | null>, disabled: boolean, readOnly: boolean) {
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readonlyCompartment.reconfigure(EditorState.readOnly.of(disabled || readOnly)),
    });
  }, [viewRef, disabled, readOnly]);
}

function useRevealRange(
  viewRef: MutableRef<EditorView | null>,
  revealRange: NotesEditorProps['revealRange'],
) {
  useEffect(() => {
    if (!revealRange || !viewRef.current) return;
    const view = viewRef.current;
    const from = Math.min(revealRange.from, view.state.doc.length);
    const to = Math.min(revealRange.to, view.state.doc.length);
    const effects: StateEffect<unknown>[] = [captureRevealEffect.of({ from, to })];
    if (!view.hasFocus) effects.push(EditorView.scrollIntoView(from));
    view.dispatch({ effects });
    const timer = window.setTimeout(() => {
      if (viewRef.current === view) view.dispatch({ effects: captureRevealEffect.of(null) });
    }, 1_800);
    return () => window.clearTimeout(timer);
  }, [viewRef, revealRange?.key]);
}

function createEditorRefs(props: NotesEditorProps): EditorRefs {
  return {
    spans: { current: props.note.provenance },
    proposal: { current: props.proposal },
    proposals: { current: props.proposals },
    projection: { current: null },
    projectionChanges: { current: null },
    caret: { current: null },
    committed: { current: props.note.markdown },
    acceptBlocked: { current: false },
    disabled: { current: props.disabled ?? false },
    proposalStreaming: { current: props.proposalStreaming ?? false },
    streamingProposalIds: { current: props.streamingProposalIds ?? new Set() },
    callbacks: {
      current: {
        onChange: props.onChange,
        onAccept: props.onAccept,
        onDismiss: props.onDismiss,
        onUndo: props.onUndo,
        onRedo: props.onRedo,
      },
    },
  };
}

function updateEditorRefs(
  refs: EditorRefs,
  props: NotesEditorProps,
  projected: PendingProjection,
  projectionChanges: ChangeSet,
  acceptBlocked: boolean,
) {
  refs.spans.current = props.note.provenance;
  refs.proposal.current = props.proposal;
  refs.proposals.current = props.proposals;
  refs.projection.current = projected;
  refs.projectionChanges.current = projectionChanges;
  refs.committed.current = props.note.markdown;
  refs.acceptBlocked.current = acceptBlocked;
  refs.disabled.current = props.disabled ?? false;
  refs.proposalStreaming.current = props.proposalStreaming ?? false;
  refs.streamingProposalIds.current = props.streamingProposalIds ?? new Set();
  refs.callbacks.current = {
    onChange: props.onChange,
    onAccept: props.onAccept,
    onDismiss: props.onDismiss,
    onUndo: props.onUndo,
    onRedo: props.onRedo,
  };
}

function targetInsertFor(
  note: Note,
  proposal: EditProposal | null,
  projection: PendingProjection | null,
): string {
  if (!proposal) return '';
  const range = projection?.ranges.find((value) => value.proposalId === proposal.id);
  if (range && projection) return projection.text.slice(range.from, range.to);
  try {
    return displayEdit(note.markdown, proposal).insert;
  } catch {
    return '';
  }
}

export function useNoteEditor(host: HostRef, props: NotesEditorProps) {
  const refsRef = useRef<EditorRefs | null>(null);
  if (!refsRef.current) refsRef.current = createEditorRefs(props);
  const refs = refsRef.current;
  const fullProjection = projectPendingEdits(
    props.note.markdown,
    props.proposals,
    undefined,
    props.additionQueue ?? [],
  );
  const targetInsert = targetInsertFor(props.note, props.proposal, fullProjection);
  const reveal = useReveal(
    props.proposal,
    targetInsert,
    props.proposalStreaming ?? false,
    props.revealProposalImmediately ?? false,
  );
  const acceptBlocked =
    (props.disabled ?? false) || (props.proposalStreaming ?? false) || reveal.revealUnfinished;
  const projected = projectPendingEdits(
    props.note.markdown,
    props.proposals,
    props.proposal
      ? new Map([[props.proposal.id, targetInsert.slice(0, reveal.visibleLength)]])
      : new Map(),
    props.additionQueue ?? [],
  ) ?? { text: props.note.markdown, ranges: [], issues: [] };
  const projectionChanges = ChangeSet.of(
    projected.ranges.map((range) => ({
      from: range.sourceFrom,
      to: range.sourceTo,
      insert: range.insert,
    })),
    props.note.markdown.length,
  );
  updateEditorRefs(refs, props, projected, projectionChanges, acceptBlocked);
  const viewRef = useEditorMount(
    host,
    refs,
    props.note,
    projected,
    (props.disabled ?? false) || (props.readOnly ?? false),
  );
  useEditorSync(
    viewRef,
    refs,
    props.note,
    props.proposal,
    props.proposals,
    projected,
    acceptBlocked,
    props.disabled ?? false,
    props.readOnly ?? false,
    props.proposalStreaming ?? false,
    props.streamingProposalIds ?? new Set(),
    targetInsert,
    reveal.visibleLength,
  );
  useReadonly(viewRef, props.disabled ?? false, props.readOnly ?? false);
  useRevealRange(viewRef, props.revealRange);
  return { projected, revealUnfinished: reveal.revealUnfinished };
}

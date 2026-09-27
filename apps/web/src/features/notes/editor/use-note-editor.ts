import { ChangeSet, EditorState, type StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { EditProposal, Note, ProvenanceSpan } from '@walden/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { displayEdit } from '../proposals/NoteSuggestionList';
import { type PendingProjection, projectPendingEdits } from '../proposals/pending-projection';
import {
  captureRevealEffect,
  createEditorExtensions,
  type EditorRefs,
  type MutableRef,
  readonlyCompartment,
  redrawDecorations,
  syncEditorDocument,
} from './editor-extensions';

export type NotesEditorProps = {
  note: Note;
  proposal: EditProposal | null;
  proposals: EditProposal[];
  /** Every addition on the note in order, accepted ones included. */
  additionQueue?: readonly { id: string; text: string; accepted: boolean; at?: number }[];
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
type AdditionQueue = NonNullable<NotesEditorProps['additionQueue']>;

const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_QUEUE: AdditionQueue = [];

function mountEditor(
  host: HostRef,
  refs: EditorRefs,
  note: Note,
  projection: PendingProjection,
  readOnly: boolean,
) {
  if (!host.current) return undefined;
  const state = EditorState.create({
    doc: projection.text,
    extensions: createEditorExtensions(refs, readOnly),
  });
  const view = new EditorView({ state, parent: host.current });
  refs.spans.current = note.provenance;
  redrawDecorations(view, refs, projection, note.provenance);
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
  }, [host]);
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
    redrawDecorations(view, refs, projected, note.provenance);
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
    streamingProposalIds: { current: props.streamingProposalIds ?? EMPTY_SET },
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
  refs.streamingProposalIds.current = props.streamingProposalIds ?? EMPTY_SET;
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

/** The note with pending suggestions drawn in, the current one only as far as it has revealed. */
function useProjection(
  note: Note,
  proposals: EditProposal[],
  proposal: EditProposal | null,
  visibleInsert: string,
  additionQueue: AdditionQueue,
) {
  const projected = useMemo(
    () =>
      projectPendingEdits(
        note.markdown,
        proposals,
        proposal ? new Map([[proposal.id, visibleInsert]]) : new Map(),
        additionQueue,
      ) ?? { text: note.markdown, ranges: [], issues: [] },
    [note.markdown, proposals, proposal, visibleInsert, additionQueue],
  );
  const projectionChanges = useMemo(
    () =>
      ChangeSet.of(
        projected.ranges.map((range) => ({
          from: range.sourceFrom,
          to: range.sourceTo,
          insert: range.insert,
        })),
        note.markdown.length,
      ),
    [projected, note.markdown.length],
  );
  return { projected, projectionChanges };
}

export function useNoteEditor(host: HostRef, props: NotesEditorProps) {
  const refsRef = useRef<EditorRefs | null>(null);
  if (!refsRef.current) refsRef.current = createEditorRefs(props);
  const refs = refsRef.current;
  const { note, proposal, proposals } = props;
  const disabled = props.disabled ?? false;
  const readOnly = props.readOnly ?? false;
  const proposalStreaming = props.proposalStreaming ?? false;
  const additionQueue = props.additionQueue ?? EMPTY_QUEUE;
  const fullProjection = useMemo(
    () => projectPendingEdits(note.markdown, proposals, undefined, additionQueue),
    [note.markdown, proposals, additionQueue],
  );
  const targetInsert = targetInsertFor(note, proposal, fullProjection);
  const reveal = useReveal(
    proposal,
    targetInsert,
    proposalStreaming,
    props.revealProposalImmediately ?? false,
  );
  const { projected, projectionChanges } = useProjection(
    note,
    proposals,
    proposal,
    targetInsert.slice(0, reveal.visibleLength),
    additionQueue,
  );
  const acceptBlocked = disabled || proposalStreaming || reveal.revealUnfinished;
  updateEditorRefs(refs, props, projected, projectionChanges, acceptBlocked);
  const viewRef = useEditorMount(host, refs, note, projected, disabled || readOnly);
  useEditorSync(
    viewRef,
    refs,
    note,
    proposal,
    proposals,
    projected,
    acceptBlocked,
    disabled,
    readOnly,
    proposalStreaming,
    props.streamingProposalIds ?? EMPTY_SET,
    targetInsert,
    reveal.visibleLength,
  );
  useReadonly(viewRef, disabled, readOnly);
  useRevealRange(viewRef, props.revealRange);
  return { projected, revealUnfinished: reveal.revealUnfinished };
}

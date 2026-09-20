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
import { Decoration, EditorView, keymap, WidgetType } from '@codemirror/view';
import type { EditProposal, Note, ProvenanceSpan } from '@walden/contracts';
import { minimalEdit, resolveEdit, updateProvenance } from '@walden/domain';
import { useEffect, useRef, useState } from 'react';
import {
  markdownPreviewDecorations,
  markdownPreviewTheme,
  renderMarkdownPreview,
} from './markdown-preview';
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

const externalChange = StateEffect.define<void>();

/**
 * Where a position in the saved note sits in the document being rendered:
 * the same offset, pushed along by any pending suggestion inserted before it.
 */
function projectedPosition(
  canonical: number,
  projection: {
    ranges: readonly { sourceFrom: number; sourceTo: number; insert: string }[];
  } | null,
  document: string,
): number {
  const shift = (projection?.ranges ?? [])
    .filter((range) => range.sourceFrom <= canonical)
    .reduce((total, range) => total + range.insert.length - (range.sourceTo - range.sourceFrom), 0);
  return Math.max(0, Math.min(canonical + shift, document.length));
}
const suggestionEffect = StateEffect.define<DecorationSet>();
const previewEffect = StateEffect.define<DecorationSet>();
const captureRevealEffect = StateEffect.define<{ from: number; to: number } | null>();
const provenanceValueEffect = StateEffect.define<ProvenanceSpan[]>();
const readonlyCompartment = new Compartment();
type DecorationSet = ReturnType<typeof Decoration.set>;

class AddedText extends WidgetType {
  constructor(
    private readonly proposalId: string,
    private readonly text: string,
    private readonly onAccept: () => void,
    private readonly onDismiss: (reason: 'typing' | 'reject') => void,
    private readonly disabled: boolean,
    private readonly suggesting: boolean,
    private readonly deletion: boolean,
    private readonly from: number,
    private readonly to: number,
  ) {
    super();
  }
  private updateElement(element: HTMLElement) {
    element.dataset.proposalId = this.proposalId;
    element.dataset.from = String(this.from);
    element.dataset.to = String(this.to);
    element.setAttribute(
      'aria-label',
      this.text
        ? `Suggested text: ${this.text}`
        : this.deletion
          ? 'Suggested deletion'
          : this.suggesting
            ? 'Preparing suggested text'
            : 'Suggested insertion',
    );
    const label = element.querySelector<HTMLElement>('.notes-editor__suggestion-label');
    if (label) label.textContent = this.suggesting ? 'Suggesting…' : 'Suggested';
    const text = element.querySelector<HTMLElement>('.notes-editor__suggestion-text');
    if (text) renderMarkdownPreview(text, this.text || (this.deletion ? 'Delete' : ''));
    const accept = element.querySelector<HTMLButtonElement>('[aria-label="Accept suggestion"]');
    if (accept) {
      accept.disabled = this.disabled;
      accept.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.onAccept();
      };
    }
    const dismiss = element.querySelector<HTMLButtonElement>('[data-suggestion-dismiss]');
    if (dismiss) {
      dismiss.setAttribute(
        'aria-label',
        this.suggesting ? 'Cancel note suggestion' : 'Reject suggestion',
      );
      dismiss.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.onDismiss('reject');
      };
    }
  }
  toDOM(view: EditorView) {
    const element = document.createElement('span');
    element.className = 'notes-editor__suggestion';
    const label = document.createElement('span');
    label.className = 'notes-editor__suggestion-label sr-only';
    element.append(label);
    const text = document.createElement('span');
    text.className = 'notes-editor__suggestion-text';
    text.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const suggestion = text.parentElement;
      view.dispatch({
        selection: {
          anchor: Number(suggestion?.dataset.from ?? this.from),
          head: Number(suggestion?.dataset.to ?? this.to),
        },
      });
      view.focus();
    });
    element.append(text);
    const controls = document.createElement('span');
    controls.className = 'notes-editor__suggestion-actions';
    const accept = document.createElement('button');
    accept.type = 'button';
    accept.disabled = this.disabled;
    accept.setAttribute('aria-label', 'Accept suggestion');
    accept.innerHTML = 'Accept <kbd>Tab</kbd>';
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.dataset.suggestionDismiss = 'true';
    dismiss.setAttribute(
      'aria-label',
      this.suggesting ? 'Cancel note suggestion' : 'Reject suggestion',
    );
    dismiss.innerHTML = 'Reject <kbd>Esc</kbd>';
    controls.append(accept, dismiss);
    element.append(controls);
    this.updateElement(element);
    return element;
  }
  updateDOM(element: HTMLElement) {
    this.updateElement(element);
    return true;
  }
  eq(_other: WidgetType) {
    return false;
  }
  ignoreEvent() {
    return true;
  }
}

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
      if (effect.is(captureRevealEffect)) {
        return effect.value && effect.value.to > effect.value.from
          ? Decoration.set([
              Decoration.mark({ class: 'notes-editor__capture-reveal' }).range(
                effect.value.from,
                effect.value.to,
              ),
            ])
          : Decoration.none;
      }
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
    if (!transaction.docChanged || transaction.effects.some((effect) => effect.is(externalChange)))
      return value;
    const changes: Array<{ from: number; to: number; insert: string }> = [];
    transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) =>
      changes.push({ from: fromA, to: toA, insert: inserted.toString() }),
    );
    let next = value;
    for (const change of changes.reverse())
      next = updateProvenance(next, change.from, change.to, change.insert);
    return next;
  },
});

function isWordCharacter(value: string): boolean {
  return /^[\p{L}\p{N}_]$/u.test(value);
}

function previousCharacter(value: string, index: number): string {
  return Array.from(value.slice(0, index)).at(-1) ?? '';
}

function displayEdit(document: string, proposal: EditProposal) {
  const edit = resolveEdit(document, proposal.oldText, proposal.newText);
  if (
    !proposal.oldText ||
    (edit.from === edit.to && !isWordCharacter(Array.from(edit.insert)[0] ?? ''))
  )
    return edit;

  const matchFrom = document.indexOf(proposal.oldText);
  const matchTo = matchFrom + proposal.oldText.length;
  let from = edit.from;
  let to = edit.to;
  while (from > matchFrom) {
    const character = previousCharacter(document, from);
    if (!isWordCharacter(character)) break;
    from -= character.length;
  }
  while (to < matchTo) {
    const character = Array.from(document.slice(to))[0] ?? '';
    if (!isWordCharacter(character)) break;
    to += character.length;
  }
  return {
    from,
    to,
    insert: document.slice(from, edit.from) + edit.insert + document.slice(edit.to, to),
  };
}

function decorationsForProjection(
  projection: PendingProjection,
  proposals: readonly EditProposal[],
  actions: {
    onAccept: (proposal: EditProposal) => void;
    onDismiss: (proposal: EditProposal) => void;
    disabled: (proposal: EditProposal) => boolean;
    streaming: (proposal: EditProposal) => boolean;
  },
): DecorationSet {
  const byId = new Map(proposals.map((proposal) => [proposal.id, proposal]));
  const decorations: Array<ReturnType<ReturnType<typeof Decoration.mark>['range']>> = [];
  for (const range of projection.ranges) {
    const proposal = byId.get(range.proposalId);
    if (!proposal) continue;
    const pendingText = projection.text.slice(range.from, range.to);
    let displayFrom = range.from;
    let displayTo = range.to;
    if (
      isWordCharacter(Array.from(pendingText)[0] ?? '') &&
      isWordCharacter(Array.from(pendingText).at(-1) ?? '')
    ) {
      while (displayFrom > 0) {
        const character = previousCharacter(projection.text, displayFrom);
        if (!isWordCharacter(character)) break;
        displayFrom -= character.length;
      }
      while (displayTo < projection.text.length) {
        const character = Array.from(projection.text.slice(displayTo))[0] ?? '';
        if (!isWordCharacter(character)) break;
        displayTo += character.length;
      }
    }
    if (displayTo > displayFrom) {
      decorations.push(
        Decoration.mark({
          class: 'notes-editor__suggestion-text notes-editor__pending-text',
          attributes: { 'data-proposal-id': proposal.id },
        }).range(displayFrom, displayTo),
      );
    }
    let deletion = false;
    try {
      const finalEdit = resolveEdit(proposal.oldText, proposal.oldText, proposal.newText);
      deletion = finalEdit.to > finalEdit.from && finalEdit.insert.length === 0;
    } catch {
      deletion = false;
    }
    const widget = new AddedText(
      proposal.id,
      '',
      () => {
        if (!actions.disabled(proposal)) actions.onAccept(proposal);
      },
      () => actions.onDismiss(proposal),
      actions.disabled(proposal),
      actions.streaming(proposal),
      deletion,
      displayFrom,
      displayTo,
    );
    // Anchor the controls at the end of the line the suggestion ends on, not at
    // the exact character it ends at. Mid-text anchoring split the sentence it
    // was embedded in, and moved the buttons whenever another suggestion was
    // accepted and the text around them reflowed.
    const lineBreak = projection.text.indexOf('\n', displayTo);
    const controlsAt = lineBreak < 0 ? projection.text.length : lineBreak;
    decorations.push(Decoration.widget({ widget, side: 1 }).range(controlsAt));
  }
  return Decoration.set(decorations, true);
}

export function NotesEditor({
  revealRange = null,
  note,
  proposal,
  proposals,
  additionQueue = [],
  onChange,
  onAccept,
  onDismiss,
  onUndo,
  onRedo,
  disabled = false,
  readOnly = false,
  proposalStreaming = false,
  streamingProposalIds = new Set(),
  revealProposalImmediately = false,
}: NotesEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const spansRef = useRef<ProvenanceSpan[]>(note.provenance);
  const proposalRef = useRef<EditProposal | null>(proposal);
  const proposalsRef = useRef<readonly EditProposal[]>(proposals);
  const projectionRef = useRef<PendingProjection | null>(null);
  const projectionChangesRef = useRef<ChangeSet | null>(null);
  /** Caret position in the reader's own text, held across a document rebuild. */
  const caretRef = useRef<number | null>(null);
  const committedRef = useRef(note.markdown);
  const acceptBlockedRef = useRef(false);
  const disabledRef = useRef(disabled);
  const proposalStreamingRef = useRef(proposalStreaming);
  const streamingProposalIdsRef = useRef(streamingProposalIds);
  const callbacks = useRef({ onChange, onAccept, onDismiss, onUndo, onRedo });
  callbacks.current = { onChange, onAccept, onDismiss, onUndo, onRedo };
  spansRef.current = note.provenance;
  proposalRef.current = proposal;
  proposalsRef.current = proposals;
  const fullProjection = projectPendingEdits(note.markdown, proposals, undefined, additionQueue);

  const targetInsert = proposal
    ? (() => {
        const range = fullProjection?.ranges.find((value) => value.proposalId === proposal.id);
        if (range && fullProjection) return fullProjection.text.slice(range.from, range.to);
        try {
          return displayEdit(note.markdown, proposal).insert;
        } catch {
          return '';
        }
      })()
    : '';
  const [reveal, setReveal] = useState<{ id: string | null; length: number }>(() => ({
    id: revealProposalImmediately ? (proposal?.id ?? null) : null,
    length: revealProposalImmediately ? targetInsert.length : 0,
  }));
  const revealTargetRef = useRef({ id: proposal?.id ?? null, text: targetInsert });
  const scrolledProposalRef = useRef<string | null>(null);
  revealTargetRef.current = { id: proposal?.id ?? null, text: targetInsert };
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const visibleLength = proposal && reveal.id === proposal.id ? reveal.length : 0;
  const revealUnfinished = visibleLength < targetInsert.length;
  const acceptBlocked = disabled || proposalStreaming || revealUnfinished;
  acceptBlockedRef.current = acceptBlocked;
  disabledRef.current = disabled;
  proposalStreamingRef.current = proposalStreaming;
  streamingProposalIdsRef.current = streamingProposalIds;
  const projected = projectPendingEdits(
    note.markdown,
    proposals,
    proposal ? new Map([[proposal.id, targetInsert.slice(0, visibleLength)]]) : new Map(),
    additionQueue,
  );
  const projectionChanges = ChangeSet.of(
    // What was actually inserted, not the slice between the decorated bounds:
    // an addition's blank lines fall outside those, and dropping them left this
    // map two characters short per suggestion, so an edit below one deleted the
    // wrong span of the note.
    projected.ranges.map((range) => ({
      from: range.sourceFrom,
      to: range.sourceTo,
      insert: range.insert,
    })),
    note.markdown.length,
  );
  projectionRef.current = projected;
  projectionChangesRef.current = projectionChanges;
  committedRef.current = note.markdown;

  useEffect(() => {
    if (!proposal) {
      setReveal((current) =>
        current.id === null && current.length === 0 ? current : { id: null, length: 0 },
      );
      return;
    }
    if (reduceMotion || revealProposalImmediately) {
      setReveal({ id: proposal.id, length: targetInsert.length });
      return;
    }
    setReveal((current) => (current.id === proposal.id ? current : { id: proposal.id, length: 0 }));
    // Keep the timer alive: the final payload can grow after the last preview.
    // Read the current target without restarting the interval on every chunk.
    const timer = window.setInterval(() => {
      setReveal((current) => {
        const target = revealTargetRef.current;
        if (current.id !== proposal.id || target.id !== proposal.id) return current;
        if (current.length >= target.text.length) return current;
        const remaining = target.text.length - current.length;
        const step = proposalStreaming ? 1 : Math.max(1, Math.ceil(remaining / 16));
        return { ...current, length: Math.min(target.text.length, current.length + step) };
      });
    }, 16);
    return () => window.clearInterval(timer);
  }, [proposal?.id, proposalStreaming, reduceMotion, revealProposalImmediately]);

  useEffect(() => {
    if (!proposal || !reduceMotion) return;
    setReveal((current) =>
      current.id === proposal.id && current.length === targetInsert.length
        ? current
        : { id: proposal.id, length: targetInsert.length },
    );
  }, [proposal?.id, reduceMotion, targetInsert]);

  useEffect(() => {
    if (!host.current) return;
    const initialProjection = projectionRef.current;
    if (!initialProjection) return;
    const initialProposals = proposalsRef.current;
    const initialDecorations = decorationsForProjection(initialProjection, initialProposals, {
      onAccept: (candidate) =>
        callbacks.current.onAccept(
          proposalsRef.current.find((value) => value.id === candidate.id) ?? candidate,
        ),
      onDismiss: (candidate) => callbacks.current.onDismiss('reject', candidate),
      disabled: (candidate) =>
        disabledRef.current ||
        streamingProposalIdsRef.current.has(candidate.id) ||
        (candidate.id === proposalRef.current?.id && acceptBlockedRef.current),
      streaming: (candidate) =>
        streamingProposalIdsRef.current.has(candidate.id) ||
        (candidate.id === proposalRef.current?.id && proposalStreamingRef.current),
    });
    const state = EditorState.create({
      doc: initialProjection?.text ?? note.markdown,
      extensions: [
        history(),
        invertedEffects.of((transaction) => {
          if (
            !transaction.docChanged ||
            transaction.effects.some((effect) => effect.is(externalChange))
          )
            return [];
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
        readonlyCompartment.of(EditorState.readOnly.of(disabled || readOnly)),
        Prec.high(
          keymap.of([
            {
              key: 'Mod-z',
              run: () => {
                const action = callbacks.current.onUndo;
                if (!action) return false;
                if (!disabledRef.current) action();
                return true;
              },
              shift: () => {
                const action = callbacks.current.onRedo;
                if (!action) return false;
                if (!disabledRef.current) action();
                return true;
              },
            },
            {
              key: 'Mod-y',
              run: () => {
                const action = callbacks.current.onRedo;
                if (!action) return false;
                if (!disabledRef.current) action();
                return true;
              },
            },
            {
              key: 'Tab',
              run: (editor) => {
                const projection = projectionRef.current;
                if (!projection) return false;
                const selected = candidateOnLine(projection, editor.state.selection.main.head);
                if (selected.kind !== 'unique') return false;
                const candidate = proposalsRef.current.find(
                  (value) => value.id === selected.proposalId,
                );
                if (!candidate || disabledRef.current) return false;
                if (streamingProposalIdsRef.current.has(candidate.id)) return false;
                if (candidate.id === proposalRef.current?.id && acceptBlockedRef.current)
                  return false;
                callbacks.current.onAccept(candidate);
                return true;
              },
            },
            {
              key: 'Escape',
              run: (editor) => {
                const projection = projectionRef.current;
                if (!projection) return false;
                const selected = candidateOnLine(projection, editor.state.selection.main.head);
                if (selected.kind !== 'unique') return false;
                const candidate = proposalsRef.current.find(
                  (value) => value.id === selected.proposalId,
                );
                if (!candidate) return false;
                callbacks.current.onDismiss('reject', candidate);
                return true;
              },
            },
          ]),
        ),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((update) => {
          if (
            !update.docChanged ||
            update.transactions.some((transaction) =>
              transaction.effects.some((effect) => effect.is(externalChange)),
            )
          )
            return;
          const projection = projectionRef.current;
          const projectionChanges = projectionChangesRef.current;
          if (projection && projectionChanges) {
            const touched = new Set<string>();
            update.changes.iterChangedRanges((fromA, toA) => {
              for (const range of projection.ranges) {
                const touches =
                  range.from === range.to
                    ? fromA <= range.from && toA >= range.to
                    : fromA === toA
                      ? fromA > range.from && fromA < range.to
                      : fromA < range.to && toA > range.from;
                if (touches) touched.add(range.proposalId);
              }
            });
            for (const id of touched) {
              const candidate = proposalsRef.current.find((value) => value.id === id);
              if (candidate) callbacks.current.onDismiss('typing', candidate);
            }
            const canonicalChanges: Array<{ from: number; to: number; insert: string }> = [];
            update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
              canonicalChanges.push({
                from: projectionChanges.invertedDesc.mapPos(fromA, -1),
                to: projectionChanges.invertedDesc.mapPos(toA, 1),
                insert: inserted.toString(),
              });
            });
            // Where the caret belongs in the reader's own text, remembered
            // because the rendered document is about to be rebuilt around it.
            const lastChange = canonicalChanges.at(-1);
            caretRef.current = lastChange ? lastChange.from + lastChange.insert.length : null;
            const canonical = ChangeSet.of(canonicalChanges, committedRef.current.length).apply(
              EditorState.create({ doc: committedRef.current }).doc,
            );
            let changedSpans = spansRef.current;
            for (const change of [...canonicalChanges].reverse()) {
              changedSpans = updateProvenance(changedSpans, change.from, change.to, change.insert);
            }
            spansRef.current = changedSpans;
            callbacks.current.onChange(canonical.toString(), changedSpans);
            return;
          }
          const currentProposal = proposalRef.current;
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
          const changes: Array<{ from: number; to: number; insert: string }> = [];
          update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) =>
            changes.push({ from: fromA, to: toA, insert: inserted.toString() }),
          );
          for (const change of changes) {
            const touchesChangedRange =
              resolved &&
              (resolved.from === resolved.to
                ? change.from <= resolved.from && change.to >= resolved.to
                : change.from === change.to
                  ? change.from >= resolved.from && change.from <= resolved.to
                  : change.from < resolved.to && change.to > resolved.from);
            if (touchesChangedRange) callbacks.current.onDismiss('typing');
          }
          const changedSpans = update.state.field(provenanceState);
          spansRef.current = changedSpans;
          callbacks.current.onChange(update.state.doc.toString(), changedSpans);
        }),
      ],
    });
    const view = new EditorView({ state, parent: host.current });
    viewRef.current = view;
    view.dispatch({
      effects: [
        suggestionEffect.of(initialDecorations),
        previewEffect.of(markdownPreviewDecorations(initialProjection?.text ?? note.markdown)),
        provenanceValueEffect.of(note.provenance),
      ],
    });
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Fast Refresh recreates CodeMirror effect identities while preserving React hooks. Remount the
    // view so its state fields recognize effects dispatched by the refreshed module.
  }, [suggestionEffect, previewEffect, provenanceValueEffect, readonlyCompartment]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    const displayDocument = projected?.text ?? note.markdown;
    if (current !== displayDocument) {
      const caret = caretRef.current;
      caretRef.current = null;
      view.dispatch({
        // Only what actually changed, so an unrelated edit keeps the caret.
        changes: minimalEdit(current, displayDocument),
        // When the reader's own typing rebuilt this document, put the caret
        // back where their text ends. The old and new documents can share no
        // prefix at all — typing inside a suggestion replaces everything — and
        // CodeMirror has nowhere to map a caret inside a replaced span, so it
        // collapses and the next character lands somewhere else.
        ...(caret === null
          ? {}
          : { selection: { anchor: projectedPosition(caret, projected, displayDocument) } }),
        effects: [externalChange.of(undefined), provenanceValueEffect.of(note.provenance)],
        annotations: Transaction.addToHistory.of(false),
      });
    }
    spansRef.current = note.provenance;
    proposalRef.current = proposal;
    const projectedDecorations = decorationsForProjection(projected, proposals, {
      onAccept: (candidate) =>
        callbacks.current.onAccept(
          proposalsRef.current.find((value) => value.id === candidate.id) ?? candidate,
        ),
      onDismiss: (candidate) => callbacks.current.onDismiss('reject', candidate),
      disabled: (candidate) =>
        disabled ||
        streamingProposalIdsRef.current.has(candidate.id) ||
        (candidate.id === proposal?.id && acceptBlocked),
      streaming: (candidate) =>
        streamingProposalIdsRef.current.has(candidate.id) ||
        (candidate.id === proposal?.id && proposalStreaming),
    });
    const effects: StateEffect<unknown>[] = [
      suggestionEffect.of(projectedDecorations),
      previewEffect.of(markdownPreviewDecorations(displayDocument)),
      provenanceValueEffect.of(note.provenance),
    ];
    const shouldScroll = Boolean(
      proposal && scrolledProposalRef.current !== proposal.id && !view.hasFocus,
    );
    if (shouldScroll && proposal) scrolledProposalRef.current = proposal.id;
    if (!proposal) scrolledProposalRef.current = null;
    view.dispatch({
      effects,
    });
    if (shouldScroll)
      window.requestAnimationFrame(() => {
        const widget = view.dom.querySelector<HTMLElement>('.notes-editor__suggestion');
        widget?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      });
  }, [
    note.markdown,
    note.revision,
    note.provenance,
    proposal,
    acceptBlocked,
    disabled,
    proposalStreaming,
    streamingProposalIds,
    targetInsert,
    visibleLength,
    proposals,
  ]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readonlyCompartment.reconfigure(EditorState.readOnly.of(disabled || readOnly)),
    });
  }, [disabled, readOnly]);

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
  }, [revealRange?.key]);

  return (
    <div className={`notes-editor ${proposal ? 'has-proposal' : ''}`}>
      {projected.issues.map((issue) => {
        const candidate = proposals.find((value) => value.id === issue.proposalId);
        if (!candidate) return null;
        return (
          <div className="notes-editor__capture-status" role="status" key={candidate.id}>
            Suggestion could not be placed because it conflicts with another pending edit.
            <button type="button" onClick={() => onDismiss('reject', candidate)}>
              Reject
            </button>
          </div>
        );
      })}
      <div ref={host} aria-label="Markdown note editor" />
      {proposal && (
        <>
          <div className="sr-only" role="status" aria-live="polite">
            {proposalStreaming || revealUnfinished
              ? 'Preparing a note suggestion.'
              : 'Note suggestion ready. Accept with Tab or reject with Escape while editing the suggestion.'}
          </div>
        </>
      )}
    </div>
  );
}

export default NotesEditor;

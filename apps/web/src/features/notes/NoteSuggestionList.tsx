import { Decoration, type EditorView, WidgetType } from '@codemirror/view';
import type { EditProposal } from '@walden/contracts';
import { resolveEdit } from '@walden/domain';
import { renderMarkdownPreview } from './markdown-preview';
import type { PendingProjection } from './pending-projection';

export type SuggestionActions = {
  onAccept: (proposal: EditProposal) => void;
  onDismiss: (proposal: EditProposal) => void;
  disabled: (proposal: EditProposal) => boolean;
  streaming: (proposal: EditProposal) => boolean;
};

type DecorationSet = ReturnType<typeof Decoration.set>;
type SuggestionRange = PendingProjection['ranges'][number];

function isWordCharacter(value: string): boolean {
  return /^[\p{L}\p{N}_]$/u.test(value);
}

function previousCharacter(value: string, index: number): string {
  return Array.from(value.slice(0, index)).at(-1) ?? '';
}

export function displayEdit(document: string, proposal: EditProposal) {
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

function visibleSuggestionRange(projection: PendingProjection, range: SuggestionRange) {
  const pendingText = projection.text.slice(range.from, range.to);
  let from = range.from;
  let to = range.to;
  if (
    isWordCharacter(Array.from(pendingText)[0] ?? '') &&
    isWordCharacter(Array.from(pendingText).at(-1) ?? '')
  ) {
    while (from > 0) {
      const character = previousCharacter(projection.text, from);
      if (!isWordCharacter(character)) break;
      from -= character.length;
    }
    while (to < projection.text.length) {
      const character = Array.from(projection.text.slice(to))[0] ?? '';
      if (!isWordCharacter(character)) break;
      to += character.length;
    }
  }
  return { from, to };
}

function isDeletion(proposal: EditProposal): boolean {
  try {
    const edit = resolveEdit(proposal.oldText, proposal.oldText, proposal.newText);
    return edit.to > edit.from && edit.insert.length === 0;
  } catch {
    return false;
  }
}

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
    element.setAttribute('aria-label', suggestionLabel(this.text, this.deletion, this.suggesting));
    const label = element.querySelector<HTMLElement>('.notes-editor__suggestion-label');
    if (label) label.textContent = this.suggesting ? 'Suggesting…' : 'Suggested';
    const text = element.querySelector<HTMLElement>('.notes-editor__suggestion-text');
    if (text) renderMarkdownPreview(text, this.text || (this.deletion ? 'Delete' : ''));
    this.bindAccept(element);
    this.bindDismiss(element);
  }

  private bindAccept(element: HTMLElement) {
    const accept = element.querySelector<HTMLButtonElement>('[aria-label="Accept suggestion"]');
    if (!accept) return;
    accept.disabled = this.disabled;
    accept.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onAccept();
    };
  }

  private bindDismiss(element: HTMLElement) {
    const dismiss = element.querySelector<HTMLButtonElement>('[data-suggestion-dismiss]');
    if (!dismiss) return;
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
    controls.append(createAcceptButton(), createDismissButton(this.suggesting));
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

function suggestionLabel(text: string, deletion: boolean, suggesting: boolean): string {
  if (text) return `Suggested text: ${text}`;
  if (deletion) return 'Suggested deletion';
  if (suggesting) return 'Preparing suggested text';
  return 'Suggested insertion';
}

function createAcceptButton() {
  const accept = document.createElement('button');
  accept.type = 'button';
  accept.setAttribute('aria-label', 'Accept suggestion');
  accept.innerHTML = 'Accept <kbd>Tab</kbd>';
  return accept;
}

function createDismissButton(suggesting: boolean) {
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.dataset.suggestionDismiss = 'true';
  dismiss.setAttribute('aria-label', suggesting ? 'Cancel note suggestion' : 'Reject suggestion');
  dismiss.innerHTML = 'Reject <kbd>Esc</kbd>';
  return dismiss;
}

function createRangeDecorations(
  projection: PendingProjection,
  proposal: EditProposal,
  range: SuggestionRange,
  actions: SuggestionActions,
): Array<ReturnType<ReturnType<typeof Decoration.mark>['range']>> {
  const { from, to } = visibleSuggestionRange(projection, range);
  const decorations: Array<ReturnType<ReturnType<typeof Decoration.mark>['range']>> = [];
  if (to > from) {
    decorations.push(
      Decoration.mark({
        class: 'notes-editor__suggestion-text notes-editor__pending-text',
        attributes: { 'data-proposal-id': proposal.id },
      }).range(from, to),
    );
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
    isDeletion(proposal),
    from,
    to,
  );
  const lineBreak = projection.text.indexOf('\n', to);
  const controlsAt = lineBreak < 0 ? projection.text.length : lineBreak;
  decorations.push(Decoration.widget({ widget, side: 1 }).range(controlsAt));
  return decorations;
}

export function createSuggestionDecorations(
  projection: PendingProjection,
  proposals: readonly EditProposal[],
  actions: SuggestionActions,
): DecorationSet {
  const byId = new Map(proposals.map((proposal) => [proposal.id, proposal]));
  const decorations: Array<ReturnType<ReturnType<typeof Decoration.mark>['range']>> = [];
  for (const range of projection.ranges) {
    const proposal = byId.get(range.proposalId);
    if (proposal) decorations.push(...createRangeDecorations(projection, proposal, range, actions));
  }
  return Decoration.set(decorations, true);
}

export type NoteSuggestionListProps = {
  issues: PendingProjection['issues'];
  proposals: readonly EditProposal[];
  onDismiss: (reason: 'typing' | 'reject', proposal?: EditProposal) => void;
};

export function NoteSuggestionList({ issues, proposals, onDismiss }: NoteSuggestionListProps) {
  return (
    <>
      {issues.map((issue) => {
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
    </>
  );
}

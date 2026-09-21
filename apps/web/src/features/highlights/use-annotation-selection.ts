import type { Annotation, MessageHighlight } from '@walden/contracts';
import {
  type MouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import { type ContextualActionId } from './contextual-actions';

export type AnnotationMenu = {
  quote: string;
  kind?: Annotation['kind'];
  highlight?: MessageHighlight;
  sourceRange?: { start: number; end: number };
  clearSelection: boolean;
};

type AnnotationSelectionOptions = {
  text: string;
  annotations: Annotation[];
  markdown: boolean;
  highlights: MessageHighlight[];
  active: boolean;
  onAction(action: ContextualActionId, quote: string): void;
  onHighlight?(value: MessageHighlight): Promise<void> | void;
};

function selectionIsInside(root: HTMLDivElement, selection: Selection) {
  return (
    root.contains(selection.anchorNode) &&
    root.contains(selection.focusNode) &&
    !selection.isCollapsed &&
    selection.rangeCount > 0
  );
}

function selectedText(root: HTMLDivElement, markdown: boolean) {
  const selection = window.getSelection();
  if (!selection || !selectionIsInside(root, selection)) return null;
  const quote = selection.toString().trim();
  if (!quote) return null;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  const scrollBounds = root.closest('.chat-scroll')?.getBoundingClientRect();
  if (scrollBounds && (rect.bottom < scrollBounds.top || rect.top > scrollBounds.bottom))
    return null;
  return {
    quote,
    rect,
    sourceRange: markdown ? sourceRange(root, selection) : undefined,
  };
}

function sourceRange(root: HTMLDivElement, selection: Selection) {
  const anchor = sourcePoint(root, selection.anchorNode!, selection.anchorOffset);
  const focus = sourcePoint(root, selection.focusNode!, selection.focusOffset);
  if (!anchor || !focus) return undefined;
  return { start: Math.min(anchor.value, focus.value), end: Math.max(anchor.value, focus.value) };
}

function sourcePoint(root: HTMLDivElement, node: Node, offset: number) {
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  const span = element?.closest<HTMLElement>('[data-source-start][data-source-end]');
  if (!span || !root.contains(span)) return null;
  const start = Number(span.dataset.sourceStart);
  const end = Number(span.dataset.sourceEnd);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  const prefix = document.createRange();
  prefix.setStart(span, 0);
  prefix.setEnd(node, offset);
  return sourceValue(span, start, end, prefix.toString().length);
}

function sourceValue(span: HTMLElement, start: number, end: number, local: number) {
  const sourceMap = span.dataset.sourceMap
    ?.split(',')
    .map((value) => (value === '' ? null : Number(value)));
  if (sourceMap?.length) {
    const value = sourceMap[local];
    return value === undefined || value === null || !Number.isInteger(value) ? null : { value };
  }
  if (span.dataset.sourceLiteral !== 'true') {
    if (local === 0) return { value: start };
    if (local === span.textContent?.length) return { value: end };
    return null;
  }
  return { value: start + Math.min(local, end - start) };
}

function annotationMenu(
  target: EventTarget | null,
  root: HTMLDivElement,
  text: string,
  annotations: Annotation[],
  highlights: MessageHighlight[],
) {
  const mark =
    target instanceof Element
      ? target.closest<HTMLElement>('mark[data-annotation-id], mark[data-highlight-index]')
      : null;
  if (!mark || !root.contains(mark)) return null;
  const annotation = annotations.find((item) => item.id === mark.dataset.annotationId);
  const index = mark.dataset.highlightIndex;
  const highlight = index === undefined ? undefined : highlights[Number(index)];
  if (!annotation && !highlight) return null;
  const rangeStart = highlight?.start ?? (annotation ? text.indexOf(annotation.quote) : -1);
  const range =
    rangeStart >= 0
      ? {
          start: rangeStart,
          end: rangeStart + (annotation?.quote.length ?? highlight?.quote.length ?? 0),
        }
      : undefined;
  return {
    quote: highlight?.quote ?? annotation?.quote ?? '',
    ...(annotation ? { kind: annotation.kind } : {}),
    ...(highlight
      ? { highlight }
      : annotation && range
        ? {
            highlight: {
              ...range,
              quote: annotation.quote,
              color: null,
              origin: 'agent' as const,
              kind: annotation.kind,
            },
          }
        : {}),
    ...(range ? { sourceRange: range } : {}),
    clearSelection: false,
  } satisfies AnnotationMenu;
}

function markTarget(target: EventTarget | null) {
  return target instanceof Element
    ? target.closest<HTMLElement>('mark[data-annotation-id], mark[data-highlight-index]')
    : null;
}

function useSelectionEvents(
  root: RefObject<HTMLDivElement | null>,
  markdown: boolean,
  setMenu: (menu: AnnotationMenu | null) => void,
  menuRef: RefObject<AnnotationMenu | null>,
  anchorRect: RefObject<DOMRect>,
) {
  useEffect(() => {
    function updateSelection() {
      const container = root.current;
      if (!container) return;
      const selected = selectedText(container, markdown);
      if (!selected) {
        if (!menuRef.current?.kind && !menuRef.current?.highlight) {
          menuRef.current = null;
          setMenu(null);
        }
        return;
      }
      const next = {
        quote: selected.quote,
        clearSelection: true,
        ...(selected.sourceRange ? { sourceRange: selected.sourceRange } : {}),
      } satisfies AnnotationMenu;
      anchorRect.current = DOMRect.fromRect(selected.rect);
      menuRef.current = next;
      setMenu(next);
    }

    function handleScroll(event: Event) {
      const chatScroll = root.current?.closest('.chat-scroll');
      if (event.target !== document && event.target !== window && event.target !== chatScroll)
        return;
      if (menuRef.current) {
        menuRef.current = null;
        setMenu(null);
      }
    }

    document.addEventListener('selectionchange', updateSelection);
    document.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);
    return () => {
      document.removeEventListener('selectionchange', updateSelection);
      document.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
    };
  }, [markdown, menuRef, root, setMenu, anchorRect]);
}

type SetMenu = (menu: AnnotationMenu | null) => void;

function createDismiss(menuRef: RefObject<AnnotationMenu | null>, setMenu: SetMenu) {
  return (clearSelection = false) => {
    if (clearSelection && menuRef.current?.clearSelection) window.getSelection()?.removeAllRanges();
    menuRef.current = null;
    setMenu(null);
  };
}

function createSelectionHandlers({
  root,
  text,
  annotations,
  highlights,
  menuRef,
  returnFocus,
  anchorRect,
  setMenu,
  dismiss,
  onAction,
}: {
  root: RefObject<HTMLDivElement | null>;
  text: string;
  annotations: Annotation[];
  highlights: MessageHighlight[];
  menuRef: RefObject<AnnotationMenu | null>;
  returnFocus: RefObject<HTMLElement | null>;
  anchorRect: RefObject<DOMRect>;
  setMenu: SetMenu;
  dismiss(clearSelection?: boolean): void;
  onAction(action: ContextualActionId, quote: string): void;
}) {
  function openAnnotation(
    target: EventTarget | null,
    fromKeyboard = false,
    pointer?: { x: number; y: number },
  ) {
    const mark = markTarget(target);
    if (!mark || !root.current) return;
    const selected = window.getSelection();
    if (selected && selectionIsInside(root.current, selected)) return;
    const next = annotationMenu(target, root.current, text, annotations, highlights);
    if (!next) return;
    anchorRect.current = pointer
      ? DOMRect.fromRect({ x: pointer.x, y: pointer.y })
      : mark.getClientRects()[0] || mark.getBoundingClientRect();
    returnFocus.current = fromKeyboard ? mark : null;
    menuRef.current = next;
    setMenu(next);
  }

  function handleClick(event: MouseEvent<HTMLDivElement>) {
    if (markTarget(event.target)) {
      openAnnotation(event.target, false, { x: event.clientX, y: event.clientY });
      return;
    }
    const selected = window.getSelection();
    if (selected && root.current && selectionIsInside(root.current, selected)) return;
    dismiss();
  }

  function handleContextMenu(event: MouseEvent<HTMLDivElement>) {
    const mark = markTarget(event.target);
    const selected = window.getSelection();
    const overSelection = Boolean(
      selected && root.current && selectionIsInside(root.current, selected),
    );
    if (!mark && !overSelection) return;
    event.preventDefault();
    if (mark) openAnnotation(event.target, false, { x: event.clientX, y: event.clientY });
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target as HTMLElement;
    if (!target.matches('mark[data-annotation-id], mark[data-highlight-index]')) return;
    event.preventDefault();
    openAnnotation(target, true);
  }

  function act(action: ContextualActionId, menu: AnnotationMenu | null) {
    if (menu) onAction(action, menu.quote);
    if (action !== 'capture') dismiss(true);
  }

  return { openAnnotation, handleClick, handleContextMenu, handleKeyDown, act };
}

function useHighlightActions({
  text,
  menu,
  onHighlight,
  dismiss,
}: {
  text: string;
  menu: AnnotationMenu | null;
  onHighlight?(value: MessageHighlight): Promise<void> | void;
  dismiss(clearSelection?: boolean): void;
}) {
  const [highlightError, setHighlightError] = useState('');
  const [highlightPending, setHighlightPending] = useState(false);

  async function saveHighlight(value: MessageHighlight) {
    if (!onHighlight || highlightPending) return;
    setHighlightPending(true);
    setHighlightError('');
    try {
      await onHighlight(value);
      dismiss(true);
    } catch (error) {
      setHighlightError(error instanceof Error ? error.message : 'Highlight could not be saved.');
    } finally {
      setHighlightPending(false);
    }
  }

  function updateHighlight({ kind: _kind, ...value }: MessageHighlight) {
    return saveHighlight({ ...value, origin: 'user' });
  }

  function createHighlight(color: MessageHighlight['color']) {
    if (!menu?.sourceRange || !onHighlight) return;
    const { start, end } = menu.sourceRange;
    void updateHighlight({ start, end, quote: text.slice(start, end), color, origin: 'user' });
  }

  return { highlightError, highlightPending, createHighlight, updateHighlight, setHighlightError };
}

export function useAnnotationSelection({
  text,
  annotations,
  markdown,
  highlights,
  active,
  onAction,
  onHighlight,
}: AnnotationSelectionOptions) {
  const root = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const menuRef = useRef<AnnotationMenu | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const anchorRect = useRef<DOMRect>(new DOMRect());
  const virtualAnchor = useRef({ getBoundingClientRect: () => anchorRect.current });
  const [menu, setMenu] = useState<AnnotationMenu | null>(null);
  const dismiss = createDismiss(menuRef, setMenu);
  const interactions = createSelectionHandlers({
    root,
    text,
    annotations,
    highlights,
    menuRef,
    returnFocus,
    anchorRect,
    setMenu,
    dismiss,
    onAction,
  });
  const highlightActions = useHighlightActions({ text, menu, onHighlight, dismiss });

  useEffect(() => {
    if (active) return;
    setMenu(null);
    menuRef.current = null;
    returnFocus.current = null;
  }, [active]);
  useSelectionEvents(root, markdown, setMenu, menuRef, anchorRect);

  return {
    root,
    toolbar,
    virtualAnchor,
    returnFocus,
    menu,
    dismiss,
    ...interactions,
    act: (action: ContextualActionId) => interactions.act(action, menu),
    ...highlightActions,
  };
}

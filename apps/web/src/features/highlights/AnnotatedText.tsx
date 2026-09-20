import {
  type Annotation,
  HIGHLIGHT_COLORS,
  isActiveAnnotationKind,
  type MessageHighlight,
} from '@walden/contracts';
import { X } from 'lucide-react';
import {
  type ComponentProps,
  createContext,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { type Components, Streamdown } from 'streamdown';
import { Popover, PopoverAnchor, PopoverContent } from '../../components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../components/ui/tooltip';
import { createAnnotationPlugin } from './annotation-markdown';
import { type ContextualActionId, contextualActions } from './contextual-actions';
import { effectiveHighlights } from './highlight-ranges';

type Menu = {
  quote: string;
  kind?: Annotation['kind'];
  highlight?: MessageHighlight;
  sourceRange?: { start: number; end: number };
  clearSelection: boolean;
};

function kindLabel(kind: Annotation['kind']) {
  return kind[0].toUpperCase() + kind.slice(1);
}

const AnnotationTooltipDisabled = createContext(false);

function AnnotationMark({
  children,
  disabled,
  node: _node,
  onContextMenu,
  onFocus,
  onPointerLeave,
  onPointerMove,
  title,
  ...props
}: ComponentProps<'mark'> & { disabled?: boolean; children?: ReactNode; node?: unknown }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef({ alignOffset: 0, sideOffset: 5 });
  const contextMenuOpen = useRef(false);
  const contextDisabled = useContext(AnnotationTooltipDisabled);
  const tooltipDisabled = disabled ?? contextDisabled;

  function pointAt(x: number, y: number, mark: HTMLElement) {
    const bounds = mark.getBoundingClientRect();
    anchor.current = {
      alignOffset: x - bounds.left,
      sideOffset: bounds.top - y + 5,
    };
  }

  function handlePointerMove(event: PointerEvent<HTMLElement>) {
    pointAt(event.clientX, event.clientY, event.currentTarget);
    onPointerMove?.(event);
  }

  function handleFocus(event: FocusEvent<HTMLElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const first = event.currentTarget.getClientRects()[0] ?? bounds;
    pointAt(first.left, first.top, event.currentTarget);
    onFocus?.(event);
  }

  return (
    <Tooltip
      open={open && !tooltipDisabled}
      onOpenChange={(next) => {
        if (!next || !contextMenuOpen.current) setOpen(next);
      }}
    >
      <TooltipTrigger asChild>
        <mark
          {...props}
          onPointerMove={handlePointerMove}
          onPointerLeave={(event) => {
            contextMenuOpen.current = false;
            onPointerLeave?.(event);
          }}
          onFocus={handleFocus}
          onContextMenu={(event) => {
            contextMenuOpen.current = true;
            setOpen(false);
            onContextMenu?.(event);
          }}
        >
          {children}
        </mark>
      </TooltipTrigger>
      <TooltipContent
        className="annotation-tooltip"
        side="top"
        align="start"
        alignOffset={anchor.current.alignOffset}
        sideOffset={anchor.current.sideOffset}
      >
        {title}
      </TooltipContent>
    </Tooltip>
  );
}

const markdownComponents = { mark: AnnotationMark } satisfies Components;

export function AnnotatedText({
  text,
  annotations = [],
  animatedAnnotationIds,
  markdown = false,
  onAction,
  highlights = [],
  onHighlight,
  actionStatus,
  active = true,
}: {
  active?: boolean;
  text: string;
  annotations?: Annotation[];
  animatedAnnotationIds?: ReadonlySet<string>;
  markdown?: boolean;
  onAction(action: ContextualActionId, quote: string): void;
  highlights?: MessageHighlight[];
  onHighlight?(value: MessageHighlight): Promise<void> | void;
  /**
   * Progress or failure for an action dispatched from this menu. Shown in the
   * menu and holds it open: the reader asked from here, so this is where the
   * answer belongs, rather than in a row under the message they had to go
   * looking for.
   */
  actionStatus?: {
    pending: boolean;
    message?: string;
    alert?: boolean;
    onRetry?(): void;
    onDismiss?(): void;
  } | null;
}) {
  const root = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const menuRef = useRef<Menu | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const anchorRect = useRef<DOMRect>(new DOMRect());
  const virtualAnchor = useRef({ getBoundingClientRect: () => anchorRect.current });
  const [menu, setMenu] = useState<Menu | null>(null);
  const [highlightError, setHighlightError] = useState('');
  const [highlightPending, setHighlightPending] = useState(false);
  useEffect(() => {
    if (!active) {
      setMenu(null);
      menuRef.current = null;
      returnFocus.current = null;
    }
  }, [active]);

  function sourceRange(selection: Selection): { start: number; end: number } | null {
    const container = root.current;
    const anchor = selection.anchorNode;
    const focus = selection.focusNode;
    if (!container || !anchor || !focus) return null;
    const point = (node: Node, offset: number) => {
      const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
      const span = element?.closest<HTMLElement>('[data-source-start][data-source-end]');
      if (!span || !container.contains(span)) return null;
      const start = Number(span.dataset.sourceStart);
      const end = Number(span.dataset.sourceEnd);
      if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
      const prefix = document.createRange();
      prefix.setStart(span, 0);
      prefix.setEnd(node, offset);
      const local = prefix.toString().length;
      const sourceMap = span.dataset.sourceMap
        ?.split(',')
        .map((value) => (value === '' ? null : Number(value)));
      if (sourceMap?.length) {
        const value = sourceMap[local];
        return value === undefined || value === null || !Number.isInteger(value)
          ? null
          : { value, node };
      }
      if (span.dataset.sourceLiteral !== 'true') {
        if (local === 0) return { value: start, node };
        if (local === span.textContent?.length) return { value: end, node };
        return null;
      }
      return { value: start + Math.min(local, end - start), node };
    };
    const a = point(anchor, selection.anchorOffset);
    const b = point(focus, selection.focusOffset);
    if (!a || !b) return null;
    return { start: Math.min(a.value, b.value), end: Math.max(a.value, b.value) };
  }

  useEffect(() => {
    function updateSelection() {
      const selected = window.getSelection();
      const container = root.current;
      if (
        !container ||
        !selected ||
        selected.isCollapsed ||
        !selected.rangeCount ||
        !container.contains(selected.anchorNode) ||
        !container.contains(selected.focusNode)
      ) {
        if (!menuRef.current?.kind && !menuRef.current?.highlight) {
          menuRef.current = null;
          setMenu(null);
        }
        return;
      }
      const quote = selected.toString().trim();
      if (!quote) {
        menuRef.current = null;
        return setMenu(null);
      }
      const rect = selected.getRangeAt(0).getBoundingClientRect();
      const scrollBounds = container.closest('.chat-scroll')?.getBoundingClientRect();
      if (scrollBounds && (rect.bottom < scrollBounds.top || rect.top > scrollBounds.bottom)) {
        menuRef.current = null;
        setMenu(null);
        return;
      }
      const range = markdown ? sourceRange(selected) : null;
      const next = {
        quote,
        clearSelection: true,
        ...(range ? { sourceRange: range } : {}),
      };
      anchorRect.current = DOMRect.fromRect(rect);
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
  }, []);

  function dismiss(clearSelection = false) {
    if (clearSelection && menuRef.current?.clearSelection) window.getSelection()?.removeAllRanges();
    menuRef.current = null;
    setMenu(null);
  }

  function openAnnotation(
    target: EventTarget | null,
    fromKeyboard = false,
    pointer?: { x: number; y: number },
  ) {
    const mark =
      target instanceof Element
        ? target.closest<HTMLElement>('mark[data-annotation-id], mark[data-highlight-index]')
        : null;
    if (!mark || !root.current?.contains(mark)) return;
    const selected = window.getSelection();
    if (
      selected &&
      !selected.isCollapsed &&
      root.current.contains(selected.anchorNode) &&
      root.current.contains(selected.focusNode)
    )
      return;
    const annotation = annotations.find((item) => item.id === mark.dataset.annotationId);
    const index = mark.dataset.highlightIndex;
    const highlight = index === undefined ? undefined : highlights[Number(index)];
    if (!annotation && !highlight) return;
    const rangeStart = highlight?.start ?? (annotation ? text.indexOf(annotation.quote) : -1);
    const range =
      rangeStart >= 0
        ? {
            start: rangeStart,
            end: rangeStart + (annotation?.quote.length ?? highlight?.quote.length ?? 0),
          }
        : undefined;
    const next = {
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
    };
    anchorRect.current = pointer
      ? DOMRect.fromRect({ x: pointer.x, y: pointer.y })
      : mark.getClientRects()[0] || mark.getBoundingClientRect();
    returnFocus.current = fromKeyboard ? mark : null;
    menuRef.current = next;
    setMenu(next);
  }

  function handleClick(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.closest('mark[data-annotation-id], mark[data-highlight-index]')) {
      openAnnotation(target, false, { x: event.clientX, y: event.clientY });
    } else {
      const selected = window.getSelection();
      if (
        selected &&
        !selected.isCollapsed &&
        root.current?.contains(selected.anchorNode) &&
        root.current.contains(selected.focusNode)
      )
        return;
      menuRef.current = null;
      setMenu(null);
    }
  }

  function handleContextMenu(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const mark = target.closest('mark[data-annotation-id], mark[data-highlight-index]');
    const selected = window.getSelection();
    const overSelection =
      selected &&
      !selected.isCollapsed &&
      root.current?.contains(selected.anchorNode) &&
      root.current.contains(selected.focusNode);
    // Right-clicking a highlight or a selection should reach these actions the
    // way it reaches any other context menu; the browser's own menu offers
    // nothing useful here. Elsewhere in the response it is left alone.
    if (!mark && !overSelection) return;
    event.preventDefault();
    if (mark) openAnnotation(target, false, { x: event.clientX, y: event.clientY });
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target as HTMLElement;
    if (!target.matches('mark[data-annotation-id], mark[data-highlight-index]')) return;
    event.preventDefault();
    openAnnotation(target, true);
  }

  function act(action: ContextualActionId) {
    if (menu) onAction(action, menu.quote);
    // 'capture' reports back into this menu, so it stays open to show what
    // happened. Everything else is handed off elsewhere and the menu closes.
    if (action !== 'capture') dismiss(true);
  }

  // Anything the reader saves is theirs, including a removal of an agent mark.
  // Writing it as an agent row would let the next regenerate erase the removal.
  async function updateHighlight({ kind: _kind, ...value }: MessageHighlight) {
    const owned: MessageHighlight = { ...value, origin: 'user' };
    return saveHighlight(owned);
  }

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

  function createHighlight(color: MessageHighlight['color']) {
    if (!menu?.sourceRange || !onHighlight) return;
    const { start, end } = menu.sourceRange;
    void updateHighlight({ start, end, quote: text.slice(start, end), color, origin: 'user' });
  }

  return (
    <TooltipProvider delayDuration={150} skipDelayDuration={100}>
      <AnnotationTooltipDisabled.Provider value={!active || Boolean(menu)}>
        <div
          className="annotated"
          ref={root}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          onKeyDown={handleKeyDown}
        >
          {markdown ? (
            <div className="markdown-response">
              <Streamdown
                skipHtml
                linkSafety={{ enabled: false }}
                parseMarkdownIntoBlocksFn={(source) => [source]}
                rehypePlugins={[
                  createAnnotationPlugin(text, annotations, animatedAnnotationIds, highlights),
                ]}
                components={markdownComponents}
              >
                {text}
              </Streamdown>
            </div>
          ) : (
            <p>
              {annotatedSegments(text, annotations, highlights).map((segment) =>
                segment.kind || segment.highlightIndex !== undefined ? (
                  <AnnotationMark
                    key={segment.annotationId ?? segment.from}
                    className={`wash ${segment.kind ? `wash-${segment.kind}` : `wash-highlight-${segment.color}`}${segment.annotationId && animatedAnnotationIds?.has(segment.annotationId) ? ' wash-reveal' : ''}`}
                    title={segment.kind ? kindLabel(segment.kind) : 'Highlight'}
                    disabled={Boolean(menu)}
                    data-annotation-id={segment.annotationId}
                    {...(segment.highlightIndex === undefined
                      ? {}
                      : { 'data-highlight-index': segment.highlightIndex })}
                    role="button"
                    tabIndex={0}
                    aria-label={`${segment.kind ? `${kindLabel(segment.kind)} annotation` : 'Highlight'}: ${segment.text}`}
                  >
                    {segment.text}
                  </AnnotationMark>
                ) : (
                  <span key={segment.from}>{segment.text}</span>
                ),
              )}
            </p>
          )}
          <Popover open={active && Boolean(menu)} onOpenChange={(open) => !open && dismiss()}>
            <PopoverAnchor virtualRef={virtualAnchor} />
            <PopoverContent
              ref={toolbar}
              className="selection-actions"
              role="toolbar"
              aria-label={
                menu?.kind
                  ? `Actions for ${kindLabel(menu.kind)} annotation`
                  : menu?.highlight
                    ? 'Actions for Highlight'
                    : 'Actions for selected text'
              }
              side="bottom"
              align="start"
              onPointerDown={(event) => event.preventDefault()}
              onClick={(event) => event.stopPropagation()}
              onEscapeKeyDown={() => {
                returnFocus.current?.focus();
                returnFocus.current = null;
              }}
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                if (returnFocus.current) {
                  toolbar.current
                    ?.querySelector<HTMLButtonElement>('.selection-actions-buttons button')
                    ?.focus();
                }
              }}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                returnFocus.current?.focus();
                returnFocus.current = null;
              }}
            >
              <div className="selection-actions-header">
                <span className="selection-actions-label">
                  {menu?.kind
                    ? kindLabel(menu.kind)
                    : menu?.highlight
                      ? 'Highlight'
                      : 'Selected text'}
                </span>
                <button
                  className="selection-actions-close"
                  type="button"
                  aria-label="Close selection actions"
                  onClick={() => dismiss(true)}
                >
                  <X size={12} aria-hidden />
                </button>
              </div>
              {onHighlight && menu?.sourceRange && !menu.highlight && (
                <div className="selection-actions-highlights" aria-label="Highlight colors">
                  {HIGHLIGHT_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      className={`highlight-swatch highlight-swatch-${color}`}
                      aria-label={`Highlight ${color}`}
                      disabled={highlightPending}
                      onClick={() => createHighlight(color)}
                    />
                  ))}
                </div>
              )}
              {onHighlight && menu?.highlight && (
                <div className="selection-actions-highlights" aria-label="Highlight colors">
                  {!menu.kind &&
                    HIGHLIGHT_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        className={`highlight-swatch highlight-swatch-${color}`}
                        aria-label={`Recolor highlight ${color}`}
                        disabled={highlightPending}
                        onClick={() => void updateHighlight({ ...menu.highlight!, color })}
                      />
                    ))}
                </div>
              )}
              {highlightError && (
                <div role="alert" className="selection-actions-error">
                  {highlightError}
                  <button type="button" onClick={() => setHighlightError('')}>
                    Dismiss
                  </button>
                </div>
              )}
              {actionStatus && (actionStatus.pending || actionStatus.message) && (
                <div
                  role={actionStatus.alert ? 'alert' : 'status'}
                  aria-live="polite"
                  className={`selection-actions-status${
                    actionStatus.alert ? ' selection-actions-status-alert' : ''
                  }`}
                >
                  <span>{actionStatus.pending ? 'Adding to note…' : actionStatus.message}</span>
                  {!actionStatus.pending && actionStatus.onRetry && (
                    <button type="button" onClick={actionStatus.onRetry}>
                      Try again
                    </button>
                  )}
                  {!actionStatus.pending && actionStatus.onDismiss && (
                    <button type="button" onClick={actionStatus.onDismiss}>
                      Dismiss
                    </button>
                  )}
                </div>
              )}
              <div className="selection-actions-buttons">
                {contextualActions(menu?.kind).map((action) => (
                  <button key={action.id} type="button" onClick={() => act(action.id)}>
                    {action.label}
                  </button>
                ))}
              </div>
              {onHighlight && menu?.highlight && (
                // Last and set apart: removing a highlight is the one
                // destructive action here, and it sat inline with the colour
                // swatches where it read as just another colour.
                <button
                  type="button"
                  className="selection-actions-remove"
                  disabled={highlightPending}
                  onClick={() => void updateHighlight({ ...menu.highlight!, color: null })}
                >
                  Remove highlight
                </button>
              )}
            </PopoverContent>
          </Popover>
        </div>
      </AnnotationTooltipDisabled.Provider>
    </TooltipProvider>
  );
}

export function annotatedSegments(
  text: string,
  annotations: Annotation[],
  highlights: MessageHighlight[] = [],
) {
  type SegmentRange = {
    from: number;
    to: number;
    kind?: Annotation['kind'];
    annotationId?: string;
    highlightIndex?: number;
    color?: MessageHighlight['color'];
  };
  const activeHighlights = highlights.filter((highlight) => highlight.end > highlight.start);
  const visibleHighlights = effectiveHighlights(activeHighlights);
  const overlaps = (from: number, to: number) =>
    activeHighlights.some((highlight) => from < highlight.end && to > highlight.start);
  const modelRanges = annotations
    .filter(
      (item) =>
        item.whose === 'assistant' && item.quote.length > 0 && isActiveAnnotationKind(item.kind),
    )
    .map((item) => ({
      annotationId: item.id,
      from: text.indexOf(item.quote),
      to: text.indexOf(item.quote) + item.quote.length,
      kind: item.kind,
      highlightIndex: undefined,
      color: undefined,
    }))
    .filter((item) => item.from >= 0 && !overlaps(item.from, item.to))
    .sort((a, b) => a.from - b.from || b.to - a.to);
  const ranges: SegmentRange[] = [
    ...modelRanges,
    ...visibleHighlights
      .filter((highlight) => highlight.color)
      .map((highlight) => ({
        from: highlight.start,
        to: highlight.end,
        highlightIndex: highlights.indexOf(highlight),
        color: highlight.color!,
      })),
  ].sort((a, b) => a.from - b.from || b.to - a.to);
  const segments: Array<Omit<SegmentRange, 'to'> & { text: string }> = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.from < cursor) continue;
    if (range.from > cursor) segments.push({ from: cursor, text: text.slice(cursor, range.from) });
    segments.push({
      from: range.from,
      text: text.slice(range.from, range.to),
      kind: range.kind,
      annotationId: range.annotationId,
      highlightIndex: range.highlightIndex,
      color: range.color,
    });
    cursor = range.to;
  }
  if (cursor < text.length) segments.push({ from: cursor, text: text.slice(cursor) });
  return segments;
}

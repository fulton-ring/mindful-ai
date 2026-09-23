import { type Annotation, isActiveAnnotationKind, type MessageHighlight } from '@walden/contracts';
import {
  type ComponentProps,
  createContext,
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
  useContext,
  useRef,
  useState,
} from 'react';
import { type Components, Streamdown } from 'streamdown';
import { math } from '../../components/ai-elements/math';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../components/ui/tooltip';
import { type AnnotationActionStatus, AnnotationActions } from './AnnotationActions';
import { createAnnotationPlugin } from './annotation-markdown';
import { type ContextualActionId } from './contextual-actions';
import { effectiveHighlights } from './highlight-ranges';
import { useAnnotationSelection } from './use-annotation-selection';

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

type AnnotatedTextProps = {
  active?: boolean;
  text: string;
  annotations?: Annotation[];
  animatedAnnotationIds?: ReadonlySet<string>;
  markdown?: boolean;
  onAction(action: ContextualActionId, quote: string): void;
  highlights?: MessageHighlight[];
  onHighlight?(value: MessageHighlight): Promise<void> | void;
  actionStatus?: AnnotationActionStatus | null;
};

function kindLabel(kind: Annotation['kind']) {
  return kind[0].toUpperCase() + kind.slice(1);
}

function AnnotationContent({
  text,
  annotations = [],
  highlights = [],
  markdown = false,
  animatedAnnotationIds,
  menuOpen,
}: Pick<
  AnnotatedTextProps,
  'text' | 'annotations' | 'highlights' | 'markdown' | 'animatedAnnotationIds'
> & { menuOpen: boolean }) {
  if (markdown) {
    return (
      <div className="markdown-response">
        <Streamdown
          skipHtml
          plugins={{ math }}
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
    );
  }
  return (
    <p>
      {annotatedSegments(text, annotations, highlights).map((segment) =>
        renderSegment(segment, animatedAnnotationIds, menuOpen),
      )}
    </p>
  );
}

function renderSegment(
  segment: ReturnType<typeof annotatedSegments>[number],
  animatedAnnotationIds: ReadonlySet<string> | undefined,
  menuOpen: boolean,
) {
  if (!segment.kind && segment.highlightIndex === undefined) {
    return <span key={segment.from}>{segment.text}</span>;
  }
  const label = segment.kind ? kindLabel(segment.kind) : 'Highlight';
  return (
    <AnnotationMark
      key={segment.annotationId ?? segment.from}
      className={`wash ${segment.kind ? `wash-${segment.kind}` : `wash-highlight-${segment.color}`}${segment.annotationId && animatedAnnotationIds?.has(segment.annotationId) ? ' wash-reveal' : ''}`}
      title={label}
      disabled={menuOpen}
      data-annotation-id={segment.annotationId}
      {...(segment.highlightIndex === undefined
        ? {}
        : { 'data-highlight-index': segment.highlightIndex })}
      role="button"
      tabIndex={0}
      aria-label={`${label}${segment.kind ? ' annotation' : ''}: ${segment.text}`}
    >
      {segment.text}
    </AnnotationMark>
  );
}

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
}: AnnotatedTextProps) {
  const selection = useAnnotationSelection({
    text,
    annotations,
    markdown,
    highlights,
    active,
    onAction,
    onHighlight,
  });
  return (
    <TooltipProvider delayDuration={150} skipDelayDuration={100}>
      <AnnotationTooltipDisabled.Provider value={!active || Boolean(selection.menu)}>
        <div
          className="annotated"
          ref={selection.root}
          onClick={selection.handleClick}
          onContextMenu={selection.handleContextMenu}
          onKeyDown={selection.handleKeyDown}
        >
          <AnnotationContent
            text={text}
            annotations={annotations}
            highlights={highlights}
            markdown={markdown}
            animatedAnnotationIds={animatedAnnotationIds}
            menuOpen={Boolean(selection.menu)}
          />
          <AnnotationActions
            active={active}
            menu={selection.menu}
            toolbar={selection.toolbar}
            virtualAnchor={selection.virtualAnchor}
            returnFocus={selection.returnFocus}
            onDismiss={selection.dismiss}
            onAction={selection.act}
            onCreateHighlight={onHighlight ? selection.createHighlight : undefined}
            onUpdateHighlight={onHighlight ? selection.updateHighlight : undefined}
            highlightPending={selection.highlightPending}
            highlightError={selection.highlightError}
            onClearHighlightError={() => selection.setHighlightError('')}
            actionStatus={actionStatus}
          />
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

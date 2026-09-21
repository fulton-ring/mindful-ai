import { type Annotation, isActiveAnnotationKind, type MessageHighlight } from '@walden/contracts';
import type { Element, Root, RootContent, Text } from 'hast';
import { decodeString } from 'micromark-util-decode-string';
import { effectiveHighlights } from './highlight-ranges';

type SourceMap = Array<number | null>;
type AnnotationRange = {
  annotation?: Annotation;
  highlight?: MessageHighlight;
  from: number;
  to: number;
};

function entityEnd(raw: string, start: number): number | null {
  const limit = Math.min(raw.length, start + 34);
  for (let candidate = start + 1; candidate < limit; candidate += 1) {
    if (
      raw[candidate] === ';' &&
      decodeString(raw.slice(start, candidate + 1)) !== raw.slice(start, candidate + 1)
    )
      return candidate + 1;
  }
  return null;
}

function decodedChunk(raw: string, start: number): { end: number; value: string } {
  const escaped =
    raw[start] === '\\' &&
    start + 1 < raw.length &&
    decodeString(raw.slice(start, start + 2)) !== raw.slice(start, start + 2);
  const end = escaped
    ? start + 2
    : raw[start] === '&'
      ? (entityEnd(raw, start) ?? start + 1)
      : start + 1;
  return { end, value: decodeString(raw.slice(start, end)) };
}

function appendSourceMap(map: SourceMap, start: number, end: number, value: string): void {
  if (end - start > 1 && value.length > 1) {
    for (let offset = 1; offset < value.length; offset += 1) map.push(null);
    map.push(end);
    return;
  }
  for (let offset = 1; offset <= value.length; offset += 1) map.push(end);
}

function decodedSourceMap(raw: string, display: string): SourceMap | null {
  if (decodeString(raw) !== display) return null;
  const map: Array<number | null> = [0];
  let rawOffset = 0;
  let displayOffset = 0;
  while (rawOffset < raw.length) {
    const chunk = decodedChunk(raw, rawOffset);
    if (display.slice(displayOffset, displayOffset + chunk.value.length) !== chunk.value)
      return null;
    appendSourceMap(map, rawOffset, chunk.end, chunk.value);
    rawOffset = chunk.end;
    displayOffset += chunk.value.length;
  }
  return displayOffset === display.length ? map : null;
}

/** Apply marks to parsed Markdown, preserving its elements and React's ownership of the DOM. */
export function createAnnotationPlugin(
  source: string,
  annotations: Annotation[],
  animatedIds?: ReadonlySet<string>,
  highlights: MessageHighlight[] = [],
): [typeof annotationPlugin, AnnotationOptions] {
  // Streamdown caches processors by plugin name and serialized options. Keep changing
  // annotations in options, not a closure that would reuse an earlier processor.
  return [
    annotationPlugin,
    { source, annotations, animatedIds: [...(animatedIds ?? [])], highlights },
  ];
}

type AnnotationOptions = {
  source: string;
  annotations: Annotation[];
  animatedIds: string[];
  highlights: MessageHighlight[];
};

function overlapsHighlight(highlights: MessageHighlight[], from: number, to: number): boolean {
  return highlights.some((highlight) => from < highlight.end && to > highlight.start);
}

function removeOverlaps(ranges: AnnotationRange[]): AnnotationRange[] {
  return ranges.filter(
    (range, index, all) => !all.slice(0, index).some((prior) => prior.to > range.from),
  );
}

function annotationRanges(
  source: string,
  annotations: Annotation[],
  activeHighlights: MessageHighlight[],
): AnnotationRange[] {
  return removeOverlaps(
    annotations
      .filter(
        (annotation) =>
          annotation.whose === 'assistant' &&
          annotation.quote.length > 0 &&
          isActiveAnnotationKind(annotation.kind),
      )
      .map((annotation) => ({
        annotation,
        from: source.indexOf(annotation.quote),
        to: source.indexOf(annotation.quote) + annotation.quote.length,
      }))
      .filter(
        (range) => range.from >= 0 && !overlapsHighlight(activeHighlights, range.from, range.to),
      )
      .sort((a, b) => a.from - b.from || b.to - a.to),
  );
}

function highlightRanges(highlights: MessageHighlight[]): AnnotationRange[] {
  return highlights
    .filter((highlight) => highlight.color)
    .map((highlight) => ({ highlight, from: highlight.start, to: highlight.end }));
}

function sourceRanges(
  source: string,
  annotations: Annotation[],
  highlights: MessageHighlight[],
): AnnotationRange[] {
  const activeHighlights = highlights.filter((highlight) => highlight.end > highlight.start);
  return removeOverlaps(
    [
      ...annotationRanges(source, annotations, activeHighlights),
      ...highlightRanges(effectiveHighlights(activeHighlights)),
    ].sort((a, b) => a.from - b.from || b.to - a.to),
  );
}

type TextContext = {
  node: Text;
  start: number;
  end: number;
  literal: boolean;
  mapping: SourceMap | null;
  animatedIds: string[];
  highlights: MessageHighlight[];
};

function textContext(
  source: string,
  node: Text,
  animatedIds: string[],
  highlights: MessageHighlight[],
): TextContext | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return null;
  const literal = source.slice(start, end) === node.value;
  const mapping = literal
    ? Array.from({ length: node.value.length + 1 }, (_, offset) => start + offset)
    : (decodedSourceMap(source.slice(start, end), node.value)?.map((offset) =>
        offset === null ? null : start + offset,
      ) ?? null);
  return { node, start, end, literal, mapping, animatedIds, highlights };
}

function sourceProperties(context: TextContext, from: number, to: number) {
  const { start, end, literal, mapping } = context;
  return {
    'data-source-start': mapping?.[from] ?? start,
    'data-source-end': mapping?.[to] ?? end,
    'data-source-literal': literal ? 'true' : 'false',
    ...(mapping && !literal ? { 'data-source-map': mapping.slice(from, to + 1).join(',') } : {}),
  };
}

function plainSpan(context: TextContext, from: number, to: number): Element {
  const { node } = context;
  return {
    type: 'element',
    tagName: 'span',
    properties: sourceProperties(context, from, to),
    children: [{ type: 'text', value: node.value.slice(from, to) }],
  };
}

function unmarkedSpan(context: TextContext): Element {
  const { node } = context;
  return {
    type: 'element',
    tagName: 'span',
    properties: sourceProperties(context, 0, node.value.length),
    children: [node],
  };
}

function markSpan(context: TextContext, range: AnnotationRange, from: number, to: number): Element {
  const { node, animatedIds, highlights } = context;
  const { annotation, highlight } = range;
  const label = annotation
    ? annotation.kind[0].toUpperCase() + annotation.kind.slice(1)
    : 'Highlight';
  return {
    type: 'element',
    tagName: 'mark',
    properties: {
      className: [
        'wash',
        ...(annotation ? [`wash-${annotation.kind}`] : [`wash-highlight-${highlight?.color}`]),
        ...(annotation && animatedIds.includes(annotation.id) ? ['wash-reveal'] : []),
      ],
      title: label,
      ...(annotation ? { 'data-annotation-id': annotation.id } : {}),
      ...(highlight ? { 'data-highlight-index': highlights.indexOf(highlight) } : {}),
      role: 'button',
      tabIndex: 0,
      'aria-label': annotation
        ? `${label} annotation: ${node.value.slice(from, to)}`
        : `Highlight: ${node.value.slice(from, to)}`,
      ...sourceProperties(context, from, to),
    },
    children: [{ type: 'text', value: node.value.slice(from, to) }],
  };
}

function mappedBounds(context: TextContext, range: AnnotationRange): [number, number] | null {
  const { mapping, start, end } = context;
  const left = mapping?.indexOf(Math.max(range.from, start)) ?? -1;
  const right = mapping?.indexOf(Math.min(range.to, end)) ?? -1;
  return left < 0 || right < 0 || left >= right ? null : [left, right];
}

function splitText(context: TextContext, matching: AnnotationRange[]): RootContent[] {
  const result: RootContent[] = [];
  let cursor = 0;
  for (const range of matching) {
    const bounds = mappedBounds(context, range);
    if (!bounds) continue;
    const [left, right] = bounds;
    if (left > cursor) result.push(plainSpan(context, cursor, left));
    result.push(markSpan(context, range, left, right));
    cursor = right;
  }
  if (cursor < context.node.value.length)
    result.push(plainSpan(context, cursor, context.node.value.length));
  return result.length ? result : [context.node];
}

function markText(
  node: Text,
  source: string,
  ranges: AnnotationRange[],
  animatedIds: string[],
  highlights: MessageHighlight[],
): RootContent[] {
  const context = textContext(source, node, animatedIds, highlights);
  if (!context) return [node];
  const matching = ranges.filter((range) => range.from < context.end && range.to > context.start);
  return matching.length ? splitText(context, matching) : [unmarkedSpan(context)];
}

function visitTree(
  parent: Root | Element,
  source: string,
  ranges: AnnotationRange[],
  animatedIds: string[],
  highlights: MessageHighlight[],
): void {
  if (parent.type === 'element' && ['a', 'code', 'pre', 'mark'].includes(parent.tagName)) return;
  parent.children = parent.children.flatMap((child) => {
    if (child.type === 'element') visitTree(child, source, ranges, animatedIds, highlights);
    return child.type === 'text'
      ? markText(child, source, ranges, animatedIds, highlights)
      : [child];
  }) as typeof parent.children;
}

function annotationPlugin({ source, annotations, animatedIds, highlights }: AnnotationOptions) {
  const ranges = sourceRanges(source, annotations, highlights);
  return (tree: Root) => visitTree(tree, source, ranges, animatedIds, highlights);
}

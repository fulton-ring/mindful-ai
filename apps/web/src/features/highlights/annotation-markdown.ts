import { type Annotation, isActiveAnnotationKind, type MessageHighlight } from '@walden/contracts';
import type { Element, Root, RootContent, Text } from 'hast';
import { decodeString } from 'micromark-util-decode-string';
import { effectiveHighlights } from './highlight-ranges';

function decodedSourceMap(raw: string, display: string): Array<number | null> | null {
  if (decodeString(raw) !== display) return null;
  const map: Array<number | null> = [0];
  let rawOffset = 0;
  let displayOffset = 0;
  while (rawOffset < raw.length) {
    let consumed = 1;
    if (
      raw[rawOffset] === '\\' &&
      rawOffset + 1 < raw.length &&
      decodeString(raw.slice(rawOffset, rawOffset + 2)) !== raw.slice(rawOffset, rawOffset + 2)
    )
      consumed = 2;
    else if (raw[rawOffset] === '&') {
      const limit = Math.min(raw.length, rawOffset + 34);
      for (let candidate = rawOffset + 1; candidate < limit; candidate += 1) {
        if (raw[candidate] !== ';') continue;
        const decoded = decodeString(raw.slice(rawOffset, candidate + 1));
        if (decoded !== raw.slice(rawOffset, candidate + 1)) {
          consumed = candidate + 1 - rawOffset;
          break;
        }
      }
    }
    const decoded = decodeString(raw.slice(rawOffset, rawOffset + consumed));
    if (display.slice(displayOffset, displayOffset + decoded.length) !== decoded) return null;
    if (consumed > 1 && decoded.length > 1) {
      for (let offset = 1; offset < decoded.length; offset += 1) map.push(null);
      map.push(rawOffset + consumed);
    } else
      for (let offset = 1; offset <= decoded.length; offset += 1) map.push(rawOffset + consumed);
    rawOffset += consumed;
    displayOffset += decoded.length;
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

function annotationPlugin({ source, annotations, animatedIds, highlights }: AnnotationOptions) {
  const activeHighlights = highlights.filter((highlight) => highlight.end > highlight.start);
  const visibleHighlights = effectiveHighlights(activeHighlights);
  const overlaps = (from: number, to: number) =>
    activeHighlights.some((highlight) => from < highlight.end && to > highlight.start);
  const ranges = annotations
    .filter(
      (annotation) =>
        annotation.whose === 'assistant' &&
        annotation.quote.length > 0 &&
        isActiveAnnotationKind(annotation.kind),
    )
    .map((annotation) => ({
      annotation,
      highlight: undefined,
      from: source.indexOf(annotation.quote),
      to: source.indexOf(annotation.quote) + annotation.quote.length,
    }))
    .filter((range) => range.from >= 0 && !overlaps(range.from, range.to))
    .sort((a, b) => a.from - b.from || b.to - a.to)
    .filter((range, index, all) => !all.slice(0, index).some((prior) => prior.to > range.from));
  const highlightRanges = visibleHighlights
    .filter((highlight) => highlight.color)
    .map((highlight) => ({
      annotation: null,
      highlight,
      from: highlight.start,
      to: highlight.end,
    }));
  const allRanges = [...ranges, ...highlightRanges]
    .sort((a, b) => a.from - b.from || b.to - a.to)
    .filter((range, index, all) => !all.slice(0, index).some((prior) => prior.to > range.from));

  return (tree: Root) => {
    function markText(node: Text): RootContent[] {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return [node];
      const matching = allRanges.filter((range) => range.from < end && range.to > start);
      const literal = source.slice(start, end) === node.value;
      const mapping = literal
        ? Array.from({ length: node.value.length + 1 }, (_, offset) => start + offset)
        : decodedSourceMap(source.slice(start, end), node.value)?.map((offset) =>
            offset === null ? null : start + offset,
          );
      const properties = (from: number, to: number) => ({
        'data-source-start': mapping?.[from] ?? start,
        'data-source-end': mapping?.[to] ?? end,
        'data-source-literal': literal ? 'true' : 'false',
        ...(mapping && !literal
          ? { 'data-source-map': mapping.slice(from, to + 1).join(',') }
          : {}),
      });
      const plain = (from: number, to: number): Element => ({
        type: 'element',
        tagName: 'span',
        properties: properties(from, to),
        children: [{ type: 'text', value: node.value.slice(from, to) }],
      });
      if (!matching.length)
        return [
          {
            type: 'element',
            tagName: 'span',
            properties: properties(0, node.value.length),
            children: [node],
          },
        ];
      const result: RootContent[] = [];
      let cursor = 0;
      for (const { from, to, annotation, highlight } of matching) {
        const left = mapping?.indexOf(Math.max(from, start)) ?? -1;
        const right = mapping?.indexOf(Math.min(to, end)) ?? -1;
        if (left < 0 || right < 0 || left >= right) continue;
        if (left > cursor) result.push(plain(cursor, left));
        result.push({
          type: 'element',
          tagName: 'mark',
          properties: {
            className: [
              'wash',
              ...(annotation
                ? [`wash-${annotation.kind}`]
                : [`wash-highlight-${highlight?.color}`]),
              ...(annotation && animatedIds.includes(annotation.id) ? ['wash-reveal'] : []),
            ],
            title: annotation
              ? annotation.kind[0].toUpperCase() + annotation.kind.slice(1)
              : 'Highlight',
            ...(annotation ? { 'data-annotation-id': annotation.id } : {}),
            ...(highlight ? { 'data-highlight-index': highlights.indexOf(highlight) } : {}),
            role: 'button',
            tabIndex: 0,
            'aria-label': annotation
              ? `${annotation.kind[0].toUpperCase() + annotation.kind.slice(1)} annotation: ${node.value.slice(left, right)}`
              : `Highlight: ${node.value.slice(left, right)}`,
            ...properties(left, right),
          },
          children: [{ type: 'text', value: node.value.slice(left, right) }],
        });
        cursor = right;
      }
      if (cursor < node.value.length) result.push(plain(cursor, node.value.length));
      return result.length ? result : [node];
    }

    function visit(parent: Root | Element) {
      if (parent.type === 'element' && ['a', 'code', 'pre', 'mark'].includes(parent.tagName))
        return;
      parent.children = parent.children.flatMap((child) => {
        if (child.type === 'element') visit(child);
        return child.type === 'text' ? markText(child) : [child];
      }) as typeof parent.children;
    }
    visit(tree);
  };
}

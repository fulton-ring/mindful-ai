import { markdownLanguage } from '@codemirror/lang-markdown';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';

export type MarkdownSyntax = {
  from: number;
  to: number;
  kind: 'heading' | 'bullet' | 'strong' | 'emphasis' | 'code' | 'fence' | 'link';
  replacement?: string;
  href?: string;
};

class TextMarker extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly href?: string,
  ) {
    super();
  }
  toDOM() {
    const element = document.createElement(this.href ? 'a' : 'span');
    element.className = 'cm-markdown-marker';
    element.textContent = this.text;
    if (this.href && element instanceof HTMLAnchorElement) {
      element.href = this.href;
      element.target = '_blank';
      element.rel = 'noreferrer';
      element.addEventListener('click', (event) => {
        if (!event.metaKey && !event.ctrlKey) event.preventDefault();
      });
    }
    return element;
  }
  ignoreEvent() {
    return true;
  }
}

function lineStarts(markdown: string): number[] {
  const starts = [0];
  for (let index = markdown.indexOf('\n'); index !== -1; index = markdown.indexOf('\n', index + 1))
    starts.push(index + 1);
  return starts;
}

/** Return source ranges that receive a visual Markdown treatment. */
export function markdownSyntax(markdown: string): MarkdownSyntax[] {
  const syntax: MarkdownSyntax[] = [];
  const fenced: Array<{ from: number; to: number }> = [];
  let openFence = -1;
  for (const from of lineStarts(markdown)) {
    const end =
      markdown.indexOf('\n', from) === -1 ? markdown.length : markdown.indexOf('\n', from);
    const line = markdown.slice(from, end);
    const heading = /^(#{1,6})(\s+)/.exec(line);
    if (heading) {
      syntax.push({ from, to: from + heading[0].length, kind: 'heading', replacement: '' });
    }
    const bullet = /^(\s*)([-*+])(\s+)/.exec(line);
    if (bullet) {
      syntax.push({
        from: from + bullet[1].length,
        to: from + bullet[0].length,
        kind: 'bullet',
        replacement: '• ',
      });
    }
    const fence = /^(\s*)(```+|~~~+).*$/.exec(line);
    if (fence) {
      syntax.push({
        from: from + fence[1].length,
        to: from + line.length,
        kind: 'fence',
        replacement: '',
      });
      if (openFence < 0) openFence = from;
      else {
        fenced.push({ from: openFence, to: from + line.length });
        openFence = -1;
      }
    }
  }
  if (openFence >= 0) fenced.push({ from: openFence, to: markdown.length });
  const inline = /(`+[^`\n]+`+|\*\*[^*\n]+\*\*|__[^_\n]+__|(?<!\*)\*[^*\n]+\*(?!\*))/g;
  for (const match of markdown.matchAll(inline)) {
    const value = match[0];
    const from = match.index ?? 0;
    if (fenced.some((range) => from >= range.from && from < range.to)) continue;
    if (value.startsWith('`')) syntax.push({ from, to: from + value.length, kind: 'code' });
    else if (value.startsWith('**') || value.startsWith('__'))
      syntax.push({ from, to: from + value.length, kind: 'strong' });
    else syntax.push({ from, to: from + value.length, kind: 'emphasis' });
  }
  const links: MarkdownSyntax[] = [];
  const cursor = markdownLanguage.parser.parse(markdown).cursor();
  do {
    if (cursor.name !== 'Link') continue;
    const source = markdown.slice(cursor.from, cursor.to);
    const separator = source.lastIndexOf('](');
    if (!source.startsWith('[') || separator < 0 || !source.endsWith(')')) continue;
    const href = source.slice(separator + 2, -1);
    let safeUrl: URL;
    try {
      safeUrl = new URL(href);
    } catch {
      continue;
    }
    if (safeUrl.protocol !== 'http:' && safeUrl.protocol !== 'https:') continue;
    links.push({
      from: cursor.from,
      to: cursor.to,
      kind: 'link',
      replacement: source.slice(1, separator),
      href: safeUrl.href,
    });
  } while (cursor.next());
  const visibleSyntax = syntax.filter(
    (item) =>
      item.kind === 'fence' ||
      !fenced.some((range) => item.from >= range.from && item.from < range.to),
  );
  return [
    ...visibleSyntax.filter(
      (item) => !links.some((link) => item.from >= link.from && item.to <= link.to),
    ),
    ...links,
  ];
}

export const markdownPreviewTheme = EditorView.baseTheme({
  '.cm-markdown-heading': { fontWeight: '700', fontSize: '1.08em' },
  '.cm-markdown-strong': { fontWeight: '700' },
  '.cm-markdown-emphasis': { fontStyle: 'italic' },
  '.cm-markdown-code': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    backgroundColor: 'color-mix(in srgb, currentColor 8%, transparent)',
  },
  '.cm-markdown-marker': { color: 'currentColor', fontWeight: '600' },
});

export function markdownPreviewDecorations(markdown: string): DecorationSet {
  const decorations = markdownSyntax(markdown)
    .map((item) => {
      if (item.kind === 'bullet') {
        return Decoration.replace({ widget: new TextMarker(item.replacement ?? '• ') }).range(
          item.from,
          item.to,
        );
      }
      if (item.kind === 'link') {
        return Decoration.replace({
          widget: new TextMarker(item.replacement ?? '', item.href),
        }).range(item.from, item.to);
      }
      const className = `cm-markdown-${item.kind}`;
      if (item.kind === 'heading') {
        const lineEnd = markdown.indexOf('\n', item.to);
        return [
          Decoration.replace({}).range(item.from, item.to),
          ...(item.to < (lineEnd === -1 ? markdown.length : lineEnd)
            ? [
                Decoration.mark({ class: className }).range(
                  item.to,
                  lineEnd === -1 ? markdown.length : lineEnd,
                ),
              ]
            : []),
        ];
      }
      if (item.kind === 'fence') return Decoration.replace({}).range(item.from, item.to);
      const delimiterSize = item.kind === 'code' || item.kind === 'emphasis' ? 1 : 2;
      const innerStart = item.from + delimiterSize;
      const innerEnd = item.to - delimiterSize;
      return [
        Decoration.replace({}).range(item.from, innerStart),
        Decoration.mark({ class: className }).range(innerStart, innerEnd),
        Decoration.replace({}).range(innerEnd, item.to),
      ];
    })
    .flat();
  return Decoration.set(decorations, true);
}

/** Render the same lightweight Markdown treatment used by the editor into a safe DOM container. */
export function renderMarkdownPreview(container: HTMLElement, value: string): void {
  container.replaceChildren();
  let cursor = 0;
  const syntax = markdownSyntax(value).sort((a, b) => a.from - b.from || a.to - b.to);
  for (const item of syntax) {
    if (item.from < cursor) continue;
    if (item.from > cursor)
      container.append(document.createTextNode(value.slice(cursor, item.from)));
    if (item.kind === 'link' && item.replacement !== undefined && item.href) {
      const link = document.createElement('a');
      link.href = item.href;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = item.replacement;
      link.addEventListener('click', (event) => {
        if (!event.metaKey && !event.ctrlKey) event.preventDefault();
      });
      container.append(link);
    } else if (item.replacement !== undefined) {
      container.append(document.createTextNode(item.replacement));
    } else if (item.kind !== 'fence') {
      const delimiters =
        item.kind === 'strong' ? 2 : item.kind === 'emphasis' || item.kind === 'code' ? 1 : 0;
      const element = document.createElement(
        item.kind === 'strong'
          ? 'strong'
          : item.kind === 'emphasis'
            ? 'em'
            : item.kind === 'code'
              ? 'code'
              : 'span',
      );
      element.className = `cm-markdown-${item.kind}`;
      element.textContent = value.slice(item.from + delimiters, item.to - delimiters);
      container.append(element);
    }
    cursor = item.to;
  }
  if (cursor < value.length) container.append(document.createTextNode(value.slice(cursor)));
}

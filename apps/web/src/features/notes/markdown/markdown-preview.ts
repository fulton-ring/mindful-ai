import { markdownLanguage } from '@codemirror/lang-markdown';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import katex from 'katex';

export type MarkdownSyntax = {
  from: number;
  to: number;
  kind: 'heading' | 'bullet' | 'strong' | 'emphasis' | 'code' | 'fence' | 'link' | 'math';
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

class MathMarker extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly from: number,
  ) {
    super();
  }
  toDOM(view: EditorView) {
    const element = document.createElement('span');
    element.className = 'cm-markdown-math';
    renderMath(element, this.source);
    element.addEventListener('click', () => {
      view.dispatch({ selection: { anchor: this.from + 1 } });
      view.focus();
    });
    return element;
  }
  ignoreEvent() {
    return true;
  }
}

function renderMath(element: HTMLElement, source: string): void {
  katex.render(source.slice(1, -1), element, { throwOnError: false, trust: false });
}

function lineStarts(markdown: string): number[] {
  const starts = [0];
  for (let index = markdown.indexOf('\n'); index !== -1; index = markdown.indexOf('\n', index + 1))
    starts.push(index + 1);
  return starts;
}

type FenceRange = { from: number; to: number };

function blockSyntax(markdown: string): { syntax: MarkdownSyntax[]; fenced: FenceRange[] } {
  const syntax: MarkdownSyntax[] = [];
  const fenced: FenceRange[] = [];
  let openFence = -1;
  for (const from of lineStarts(markdown)) {
    const lineEnd = markdown.indexOf('\n', from);
    const line = markdown.slice(from, lineEnd === -1 ? markdown.length : lineEnd);
    const heading = /^(#{1,6})(\s+)/.exec(line);
    if (heading)
      syntax.push({ from, to: from + heading[0].length, kind: 'heading', replacement: '' });
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
    if (!fence) continue;
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
  if (openFence >= 0) fenced.push({ from: openFence, to: markdown.length });
  return { syntax, fenced };
}

function inlineSyntax(markdown: string, fenced: FenceRange[]): MarkdownSyntax[] {
  const syntax: MarkdownSyntax[] = [];
  const inline = /(`+[^`\n]+`+|\*\*[^*\n]+\*\*|__[^_\n]+__|(?<!\*)\*[^*\n]+\*(?!\*))/g;
  for (const match of markdown.matchAll(inline)) {
    const value = match[0];
    const from = match.index ?? 0;
    if (fenced.some((range) => from >= range.from && from < range.to)) continue;
    const kind = value.startsWith('`')
      ? 'code'
      : value.startsWith('**') || value.startsWith('__')
        ? 'strong'
        : 'emphasis';
    syntax.push({ from, to: from + value.length, kind });
  }
  return syntax;
}

function linkSyntax(markdown: string): MarkdownSyntax[] {
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
  return links;
}

function mathSyntax(markdown: string, excluded: MarkdownSyntax[], fenced: FenceRange[]) {
  const equations: MarkdownSyntax[] = [];
  for (const match of markdown.matchAll(/\$([^$\n]+)\$/g)) {
    const from = match.index ?? 0;
    const to = from + match[0].length;
    const expression = match[1];
    if (
      markdown[from - 1] === '\\' ||
      markdown[from - 1] === '$' ||
      markdown[to] === '$' ||
      /^\s|\s$/.test(expression) ||
      excluded.some((item) => from < item.to && to > item.from) ||
      fenced.some((range) => from < range.to && to > range.from)
    )
      continue;
    equations.push({ from, to, kind: 'math' });
  }
  return equations;
}

/** Return source ranges that receive a visual Markdown treatment. */
export function markdownSyntax(markdown: string): MarkdownSyntax[] {
  const { syntax, fenced } = blockSyntax(markdown);
  syntax.push(...inlineSyntax(markdown, fenced));
  const links = linkSyntax(markdown);
  const equations = mathSyntax(markdown, [...syntax, ...links], fenced);
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
    ...equations,
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
  '.cm-markdown-math': { cursor: 'text' },
});

function syntaxDecorations(markdown: string, item: MarkdownSyntax) {
  if (item.kind === 'math')
    return Decoration.replace({
      widget: new MathMarker(markdown.slice(item.from, item.to), item.from),
    }).range(item.from, item.to);
  if (item.kind === 'bullet') {
    return Decoration.replace({ widget: new TextMarker(item.replacement ?? '• ') }).range(
      item.from,
      item.to,
    );
  }
  if (item.kind === 'link') {
    return Decoration.replace({ widget: new TextMarker(item.replacement ?? '', item.href) }).range(
      item.from,
      item.to,
    );
  }
  const className = `cm-markdown-${item.kind}`;
  if (item.kind === 'heading') {
    const lineEnd = markdown.indexOf('\n', item.to);
    const end = lineEnd === -1 ? markdown.length : lineEnd;
    return [
      Decoration.replace({}).range(item.from, item.to),
      ...(item.to < end ? [Decoration.mark({ class: className }).range(item.to, end)] : []),
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
}

export function markdownPreviewDecorations(markdown: string, cursor = -1): DecorationSet {
  const decorations = markdownSyntax(markdown)
    .filter((item) => item.kind !== 'math' || cursor <= item.from || cursor >= item.to)
    .map((item) => syntaxDecorations(markdown, item))
    .flat();
  return Decoration.set(decorations, true);
}

function appendRenderedSyntax(container: HTMLElement, value: string, item: MarkdownSyntax): void {
  if (item.kind === 'math') {
    const math = document.createElement('span');
    math.className = 'cm-markdown-math';
    renderMath(math, value.slice(item.from, item.to));
    container.append(math);
  } else if (item.kind === 'link' && item.replacement !== undefined && item.href) {
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
    appendRenderedSyntax(container, value, item);
    cursor = item.to;
  }
  if (cursor < value.length) container.append(document.createTextNode(value.slice(cursor)));
}

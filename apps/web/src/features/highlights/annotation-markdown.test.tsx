import { renderToStaticMarkup } from 'react-dom/server';
import { Streamdown } from 'streamdown';
import { describe, expect, it } from 'vitest';
import { createAnnotationPlugin } from './annotation-markdown';

describe('Markdown annotations', () => {
  it('updates cached Markdown when classification arrives after the answer', () => {
    const source = 'Ice floats.';
    const first = renderToStaticMarkup(
      <Streamdown mode="static" rehypePlugins={[createAnnotationPlugin(source, [])]}>
        {source}
      </Streamdown>,
    );
    const second = renderToStaticMarkup(
      <Streamdown
        mode="static"
        rehypePlugins={[
          createAnnotationPlugin(source, [
            { id: 'late', whose: 'assistant', kind: 'fact', quote: source },
          ]),
        ]}
      >
        {source}
      </Streamdown>,
    );
    expect(first).not.toContain('<mark');
    expect(second).toContain('<mark');
  });
  it('preserves Markdown structure while highlighting a quote across bold text', () => {
    const source = '# Ice\n\n* **Ice** is less dense than water.\n\n[Source](https://example.com)';
    const plugin = createAnnotationPlugin(source, [
      {
        id: 'a',
        whose: 'assistant',
        kind: 'fact',
        quote: '**Ice** is less dense than water.',
      },
    ]);
    const html = renderToStaticMarkup(
      <Streamdown mode="static" skipHtml linkSafety={{ enabled: false }} rehypePlugins={[plugin]}>
        {source}
      </Streamdown>,
    );
    expect(html).toContain('<h1');
    expect(html).toContain('<li');
    expect(html).toMatch(/<span[^>]*data-streamdown="strong"[^>]*><mark[^>]*>Ice<\/mark><\/span>/);
    expect(html).toMatch(/<mark[^>]*> is less dense than water\.<\/mark>/);
    expect(html).not.toContain('**Ice**');
    expect(html).toContain('href="https://example.com"');
  });

  it('does not highlight code or render raw HTML', () => {
    const source = '`example`\n\n<script>alert(1)</script>';
    const plugin = createAnnotationPlugin(source, [
      { id: 'a', whose: 'assistant', kind: 'claim', quote: 'example' },
    ]);
    const html = renderToStaticMarkup(
      <Streamdown mode="static" skipHtml rehypePlugins={[plugin]}>
        {source}
      </Streamdown>,
    );
    expect(html).toContain('example');
    expect(html).not.toContain('<mark');
    expect(html).not.toContain('<script');
  });

  it('does not turn text inside a link into an annotation control', () => {
    const source = '[Source](https://example.com)';
    const plugin = createAnnotationPlugin(source, [
      { id: 'a', whose: 'assistant', kind: 'source', quote: 'Source' },
    ]);
    const html = renderToStaticMarkup(
      <Streamdown mode="static" linkSafety={{ enabled: false }} rehypePlugins={[plugin]}>
        {source}
      </Streamdown>,
    );

    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain('<mark');
  });
});

describe('Markdown annotation source mapping', () => {
  it.each([
    ['Fish &amp; chips', 5, 10, '&'],
    ['Escaped \\*text', 8, 10, '*'],
    ['Literal \\a', 8, 10, '\\a'],
    ['Hi &#x1F600;', 3, 12, '😀'],
    ['Multi &NotEqualTilde;', 6, 21, '≂̸'],
  ])('maps a saved highlight through encoded Markdown text: %s', (source, start, end, display) => {
    const html = renderToStaticMarkup(
      <Streamdown
        mode="static"
        rehypePlugins={[
          createAnnotationPlugin(source, [], undefined, [
            { start, end, quote: display, color: 'blue', origin: 'user' as const },
          ]),
        ]}
      >
        {source}
      </Streamdown>,
    );
    expect(html).toContain(`<mark`);
    expect(html).toContain(`>${display === '&' ? '&amp;' : display}</mark>`);
    expect(html).toContain(`data-source-start="${start}"`);
    expect(html).toContain(`data-source-end="${end}"`);
  });
});

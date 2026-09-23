// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { markdownSyntax, renderMarkdownPreview } from '../markdown/markdown-preview';

describe('markdown preview syntax', () => {
  it('recognizes source ranges for headings and bullets', () => {
    expect(markdownSyntax('# Title\n* item')).toEqual([
      { from: 0, to: 2, kind: 'heading', replacement: '' },
      { from: 8, to: 10, kind: 'bullet', replacement: '• ' },
    ]);
  });

  it('recognizes inline emphasis, code, and fences without changing offsets', () => {
    const result = markdownSyntax('**bold** `code`\n```\ntext\n```');
    expect(result).toEqual(
      expect.arrayContaining([
        { from: 0, to: 8, kind: 'strong' },
        { from: 9, to: 15, kind: 'code' },
        { from: 16, to: 19, kind: 'fence', replacement: '' },
        { from: 25, to: 28, kind: 'fence', replacement: '' },
      ]),
    );
  });
});

describe('Markdown links', () => {
  it('recognizes safe inline links through the Markdown parser', () => {
    expect(markdownSyntax('[Example Domain](https://example.com/)')).toContainEqual({
      from: 0,
      to: 38,
      kind: 'link',
      replacement: 'Example Domain',
      href: 'https://example.com/',
    });
  });

  it('renders safe labels without interpreting HTML or unsafe URLs', () => {
    const container = document.createElement('div');
    renderMarkdownPreview(
      container,
      '[Example <img>](https://example.com/) [Unsafe](javascript:alert(1))',
    );

    const link = container.querySelector('a');
    expect(link?.textContent).toBe('Example <img>');
    expect(link?.href).toBe('https://example.com/');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('[Unsafe](javascript:alert(1))');
  });
});

describe('Markdown equations', () => {
  it('renders inline LaTeX while preserving the source range for editing', () => {
    const source = 'Water is $H_2O$ and protons are $H^+$.';
    expect(markdownSyntax(source)).toEqual(
      expect.arrayContaining([
        { from: 9, to: 15, kind: 'math' },
        { from: 32, to: 37, kind: 'math' },
      ]),
    );
    const container = document.createElement('div');
    renderMarkdownPreview(container, source);
    expect(container.querySelectorAll('.katex')).toHaveLength(2);
    expect(container.textContent).not.toContain('$H_2O$');
  });

  it('leaves currency and code samples as text', () => {
    const container = document.createElement('div');
    renderMarkdownPreview(container, 'Costs $5 and $10; code: `$H_2O$`.');
    expect(container.querySelector('.katex')).toBeNull();
    expect(container.textContent).toContain('$5 and $10');
    expect(container.textContent).toContain('$H_2O$');
  });
});

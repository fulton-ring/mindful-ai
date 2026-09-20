// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnnotatedText, annotatedSegments } from './AnnotatedText';

vi.mock('../../components/ui/tooltip', async () => {
  const React = await import('react');
  const ReactDOM = await import('react-dom');
  const TooltipContext = React.createContext<{
    open: boolean;
    onOpenChange(open: boolean): void;
  }>({ open: false, onOpenChange: () => {} });
  return {
    TooltipProvider: ({ children }: React.PropsWithChildren) => children,
    Tooltip: ({
      open,
      onOpenChange,
      children,
    }: React.PropsWithChildren<{ open: boolean; onOpenChange(open: boolean): void }>) => (
      <TooltipContext.Provider value={{ open, onOpenChange }}>{children}</TooltipContext.Provider>
    ),
    TooltipTrigger: ({ children }: React.PropsWithChildren) => {
      const { onOpenChange } = React.useContext(TooltipContext);
      const child = children as React.ReactElement<React.HTMLAttributes<HTMLElement>>;
      return React.cloneElement(child, {
        onPointerEnter: (event: React.PointerEvent<HTMLElement>) => {
          child.props.onPointerEnter?.(event);
          onOpenChange(true);
        },
        onPointerLeave: (event: React.PointerEvent<HTMLElement>) => {
          child.props.onPointerLeave?.(event);
          onOpenChange(false);
        },
        onFocus: (event: React.FocusEvent<HTMLElement>) => {
          child.props.onFocus?.(event);
          onOpenChange(true);
        },
        onBlur: (event: React.FocusEvent<HTMLElement>) => {
          child.props.onBlur?.(event);
          onOpenChange(false);
        },
      } as React.HTMLAttributes<HTMLElement>);
    },
    TooltipContent: ({
      children,
      alignOffset,
      sideOffset,
    }: React.PropsWithChildren<{ alignOffset?: number; sideOffset?: number }>) => {
      const { open } = React.useContext(TooltipContext);
      return open
        ? ReactDOM.createPortal(
            <div role="tooltip" data-align-offset={alignOffset} data-side-offset={sideOffset}>
              {children}
            </div>,
            document.body,
          )
        : null;
    },
  };
});

vi.mock('../../components/ui/popover', async () => {
  const React = await import('react');
  const PopoverContext = React.createContext<{
    open: boolean;
    close(): void;
  }>({ open: false, close: () => {} });
  return {
    Popover: ({
      open,
      onOpenChange,
      children,
    }: React.PropsWithChildren<{ open: boolean; onOpenChange(open: boolean): void }>) => (
      <PopoverContext.Provider value={{ open, close: () => onOpenChange(false) }}>
        {children}
      </PopoverContext.Provider>
    ),
    PopoverAnchor: () => null,
    PopoverContent: React.forwardRef<
      HTMLDivElement,
      React.HTMLAttributes<HTMLDivElement> & {
        onEscapeKeyDown?: (event: { preventDefault(): void }) => void;
        onOpenAutoFocus?: (event: { preventDefault(): void }) => void;
        onCloseAutoFocus?: (event: { preventDefault(): void }) => void;
      }
    >(function TestPopoverContent(
      { onEscapeKeyDown, onOpenAutoFocus, onCloseAutoFocus, ...props },
      forwardedRef,
    ) {
      const { open, close } = React.useContext(PopoverContext);
      React.useEffect(() => {
        if (!open) return;
        onOpenAutoFocus?.({ preventDefault() {} });
        const dismiss = (event: KeyboardEvent) => {
          if (event.key !== 'Escape') return;
          onEscapeKeyDown?.({ preventDefault() {} });
          close();
          onCloseAutoFocus?.({ preventDefault() {} });
        };
        document.addEventListener('keydown', dismiss);
        return () => document.removeEventListener('keydown', dismiss);
      }, [close, onCloseAutoFocus, onEscapeKeyDown, onOpenAutoFocus, open]);
      return open ? <div ref={forwardedRef} {...props} /> : null;
    }),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const fact = {
  id: 'ice-fact',
  whose: 'assistant' as const,
  kind: 'fact' as const,
  quote: 'Ice is less dense than water.',
};

describe('annotation actions', () => {
  it('keeps a keyboard-opened highlight menu visible when saving fails', async () => {
    const highlight = {
      start: 0,
      end: 3,
      quote: 'Ice',
      color: 'yellow' as const,
      origin: 'user' as const,
    };
    const view = render(
      <AnnotatedText
        text="Ice floats."
        markdown
        highlights={[highlight]}
        onHighlight={vi.fn().mockRejectedValue(new Error('Could not save highlight'))}
        onAction={() => {}}
      />,
    );
    fireEvent.keyDown(view.getByRole('button', { name: 'Highlight: Ice' }), { key: 'Enter' });
    fireEvent.click(view.getByRole('button', { name: 'Remove highlight' }));
    await waitFor(() =>
      expect(view.getByRole('alert').textContent).toContain('Could not save highlight'),
    );
    expect(view.getByRole('toolbar')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Dismiss' }));
    expect(view.queryByRole('alert')).toBeNull();
  });
  it.each([
    ['same here; same here', 'same here; same here', 'same', false],
    ['Before highlighted words after', 'highlighted words', 'words', true],
    ['Before highlighted words after', ' after', 'after', true],
  ])('saves the selected source occurrence in %s (%s)', async (text, leaf, selected, marked) => {
    const onHighlight = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <AnnotatedText
        text={text}
        markdown
        annotations={marked ? [{ ...fact, quote: 'highlighted words' }] : []}
        onHighlight={onHighlight}
        onAction={() => {}}
      />,
    );
    const element = Array.from(view.container.querySelectorAll('[data-source-start]')).find(
      (item) => item.textContent === leaf,
    )!;
    const node = element.firstChild!;
    const from = leaf.lastIndexOf(selected);
    vi.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: node,
      focusNode: node,
      anchorOffset: from,
      focusOffset: from + selected.length,
      isCollapsed: false,
      rangeCount: 1,
      toString: () => selected,
      getRangeAt: () => ({
        getBoundingClientRect: () => DOMRect.fromRect({ x: 20, y: 20, width: 50, height: 20 }),
      }),
      removeAllRanges: vi.fn(),
    } as unknown as Selection);
    fireEvent(document, new Event('selectionchange'));
    fireEvent.click(view.getByRole('button', { name: 'Highlight blue' }));
    await waitFor(() =>
      expect(onHighlight).toHaveBeenCalledWith({
        start: text.lastIndexOf(selected),
        end: text.lastIndexOf(selected) + selected.length,
        quote: selected,
        color: 'blue',
        origin: 'user',
      }),
    );
  });

  it('maps a partial selection inside an entity leaf to its raw source range', async () => {
    const source = 'Fish &amp; chips';
    const onHighlight = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <AnnotatedText text={source} markdown onHighlight={onHighlight} onAction={() => {}} />,
    );
    const element = Array.from(view.container.querySelectorAll('[data-source-start]')).find(
      (item) => item.textContent === 'Fish & chips',
    )!;
    const node = element.firstChild!;
    vi.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: node,
      focusNode: node,
      anchorOffset: 5,
      focusOffset: 6,
      isCollapsed: false,
      rangeCount: 1,
      toString: () => '&',
      getRangeAt: () => ({
        getBoundingClientRect: () => DOMRect.fromRect({ x: 20, y: 20, width: 20, height: 20 }),
      }),
      removeAllRanges: vi.fn(),
    } as unknown as Selection);
    fireEvent(document, new Event('selectionchange'));
    fireEvent.click(view.getByRole('button', { name: 'Highlight blue' }));
    await waitFor(() =>
      expect(onHighlight).toHaveBeenCalledWith({
        start: 5,
        end: 10,
        quote: '&amp;',
        color: 'blue',
        origin: 'user',
      }),
    );
  });

  it('keeps a removal tombstone suppressing an overlapping agent mark', () => {
    const segments = annotatedSegments(
      'same here',
      [{ ...fact, quote: 'same' }],
      [{ start: 0, end: 4, quote: 'same', color: null, origin: 'user' }],
    );
    expect(segments.some((segment) => segment.annotationId)).toBe(false);
    expect(segments.map((segment) => segment.text).join('')).toBe('same here');
  });

  it('lets the newest overlapping manual edit win without resurrecting the older one', () => {
    const text = 'one two three';
    const segments = annotatedSegments(
      text,
      [],
      [
        { start: 0, end: 7, quote: 'one two', color: 'yellow', origin: 'user' },
        { start: 4, end: 13, quote: 'two three', color: 'blue', origin: 'user' },
      ],
    );
    expect(
      segments.filter((segment) => segment.highlightIndex !== undefined).map((s) => s.text),
    ).toEqual(['two three']);
  });

  it('keeps earlier Markdown highlights mounted when the next batch arrives', () => {
    const first = { ...fact, id: 'first', quote: 'Ice floats.' };
    const second = { ...fact, id: 'second', quote: 'Water expands.' };
    const text = 'Ice floats. Water expands.';
    const onAction = vi.fn();
    const view = render(
      <AnnotatedText
        text={text}
        annotations={[first]}
        animatedAnnotationIds={new Set(['first'])}
        markdown
        onAction={onAction}
      />,
    );
    const firstMark = view.getByRole('button', { name: 'Fact annotation: Ice floats.' });
    view.rerender(
      <AnnotatedText
        text={text}
        annotations={[first, second]}
        animatedAnnotationIds={new Set(['second'])}
        markdown
        onAction={onAction}
      />,
    );
    expect(view.getByRole('button', { name: 'Fact annotation: Ice floats.' })).toBe(firstMark);
    expect(firstMark.classList.contains('wash-reveal')).toBe(false);
    expect(
      view
        .getByRole('button', { name: 'Fact annotation: Water expands.' })
        .classList.contains('wash-reveal'),
    ).toBe(true);
  });

  it('keeps a removed Markdown passage unmarked when a new classification arrives', async () => {
    const text = '**Ice** floats. Water expands.';
    const quote = '**Ice** floats.';
    const onHighlight = vi.fn().mockResolvedValue(undefined);
    const props = { text, markdown: true, onHighlight, onAction: vi.fn() };
    const original = { ...fact, id: 'original', quote };
    const view = render(<AnnotatedText {...props} annotations={[original]} />);
    fireEvent.click(view.getByRole('button', { name: 'Fact annotation: Ice' }));
    fireEvent.click(view.getByRole('button', { name: 'Remove highlight' }));
    const removed = { start: 0, end: quote.length, quote, color: null, origin: 'user' as const };
    expect(onHighlight).toHaveBeenCalledWith(removed);
    await waitFor(() => expect(view.queryByRole('toolbar')).toBeNull());
    view.rerender(
      <AnnotatedText
        {...props}
        highlights={[removed]}
        annotations={[
          { ...original, id: 'reclassified', kind: 'claim' },
          { ...fact, id: 'later', quote: 'Water expands.' },
        ]}
      />,
    );
    expect(view.queryByRole('button', { name: /^Claim annotation:/ })).toBeNull();
    expect(view.getByRole('button', { name: 'Fact annotation: Water expands.' })).toBeTruthy();
    expect(view.container.textContent).toContain('Ice floats. Water expands.');
    expect(view.container.querySelector('[data-streamdown="strong"]')?.textContent).toBe('Ice');
  });

  it('opens a saved manual highlight and supports recolor and removal', async () => {
    const onHighlight = vi.fn().mockResolvedValue(undefined);
    const highlight = {
      start: 0,
      end: 4,
      quote: 'Ice ',
      color: 'yellow' as const,
      origin: 'user' as const,
    };
    const view = render(
      <AnnotatedText
        text="Ice floats."
        highlights={[highlight]}
        onHighlight={onHighlight}
        onAction={() => {}}
      />,
    );
    fireEvent.click(view.getByRole('button', { name: /Highlight: Ice/ }));
    fireEvent.click(view.getByRole('button', { name: 'Recolor highlight blue' }));
    expect(onHighlight).toHaveBeenCalledWith({ ...highlight, color: 'blue' });
    await waitFor(() => expect(view.queryByRole('toolbar')).toBeNull());
    fireEvent.click(view.getByRole('button', { name: /Highlight: Ice/ }));
    fireEvent.click(view.getByRole('button', { name: 'Remove highlight' }));
    expect(onHighlight).toHaveBeenLastCalledWith({ ...highlight, color: null });
  });

  it('opens an agent mark with a removal action while retaining its classification label', () => {
    const onHighlight = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <AnnotatedText
        text={fact.quote}
        annotations={[fact]}
        onHighlight={onHighlight}
        onAction={() => {}}
      />,
    );
    fireEvent.click(view.getByRole('button', { name: `Fact annotation: ${fact.quote}` }));
    expect(view.getByRole('toolbar', { name: 'Actions for Fact annotation' })).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Remove highlight' }));
    expect(onHighlight).toHaveBeenCalledWith({
      start: 0,
      end: fact.quote.length,
      quote: fact.quote,
      color: null,
      origin: 'user',
    });
  });

  it('shows the annotation classification on hover and focus', () => {
    const view = render(
      <AnnotatedText text={fact.quote} annotations={[fact]} onAction={() => {}} />,
    );
    const mark = view.getByText(fact.quote);

    fireEvent.pointerEnter(mark);
    expect(view.getByRole('tooltip').textContent).toBe('Fact');

    fireEvent.pointerLeave(mark);
    fireEvent.focus(mark);
    expect(view.getByRole('tooltip').textContent).toBe('Fact');

    fireEvent.click(mark);
    expect(view.queryByRole('tooltip')).toBeNull();
    expect(view.getByRole('toolbar', { name: 'Actions for Fact annotation' })).toBeTruthy();
  });

  it('anchors a multiline annotation tooltip just above the pointer', () => {
    const view = render(
      <AnnotatedText text={fact.quote} annotations={[fact]} onAction={() => {}} />,
    );
    const mark = view.getByText(fact.quote);
    vi.spyOn(mark, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 20, y: 30, width: 180, height: 120 }),
    );

    fireEvent(mark, new MouseEvent('pointermove', { bubbles: true, clientX: 95, clientY: 125 }));
    fireEvent.pointerEnter(mark);

    const tooltip = view.getByRole('tooltip');
    expect(tooltip.dataset.alignOffset).toBe('75');
    expect(tooltip.dataset.sideOffset).toBe('-90');
  });

  it('opens the annotation actions on right click, replacing the hover tooltip', () => {
    // Right-clicking a highlight should reach these actions the way it reaches
    // any other context menu; the browser's own menu offers nothing here.
    const view = render(
      <AnnotatedText text={fact.quote} annotations={[fact]} onAction={() => {}} />,
    );
    const mark = view.getByText(fact.quote);

    fireEvent.pointerEnter(mark);
    expect(view.getByRole('tooltip')).toBeTruthy();

    const prevented = !fireEvent.contextMenu(mark);
    expect(prevented).toBe(true);
    expect(view.getByRole('toolbar', { name: 'Actions for Fact annotation' })).toBeTruthy();
    expect(view.queryByRole('tooltip')).toBeNull();

    // The tooltip stays suppressed while the actions are open, so the two
    // never stack on the same mark.
    fireEvent.pointerLeave(mark);
    fireEvent.pointerEnter(mark);
    expect(view.queryByRole('tooltip')).toBeNull();
  });

  it('keeps historical reasoning, number, and source text without misleading highlight labels', () => {
    const text = 'Because demand increased. 42 people. A report.';
    const annotations = [
      {
        id: 'r',
        whose: 'assistant' as const,
        kind: 'reasoning' as const,
        quote: 'Because demand increased.',
      },
      { id: 'n', whose: 'assistant' as const, kind: 'number' as const, quote: '42 people.' },
      { id: 's', whose: 'assistant' as const, kind: 'source' as const, quote: 'A report.' },
    ];
    const view = render(
      <AnnotatedText text={text} annotations={annotations} markdown onAction={vi.fn()} />,
    );
    expect(view.container.textContent).toBe(text);
    expect(view.container.querySelector('mark')).toBeNull();
    view.rerender(<AnnotatedText text={text} annotations={annotations} onAction={vi.fn()} />);
    expect(view.container.textContent).toBe(text);
    expect(view.container.querySelector('mark')).toBeNull();
  });
  it('opens a labeled menu from a click and acts on the complete annotation quote', () => {
    const onAction = vi.fn();
    const view = render(
      <AnnotatedText text={fact.quote} annotations={[fact]} onAction={onAction} />,
    );

    fireEvent.click(view.getByText(fact.quote));
    fireEvent(document, new Event('selectionchange'));

    expect(view.getByRole('toolbar', { name: 'Actions for Fact annotation' })).toBeTruthy();
    expect(view.getByText('Fact')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Dig deeper' }));
    expect(onAction).toHaveBeenCalledWith('deeper', fact.quote);
  });

  it('labels an explanation annotation and acts on its complete quote', () => {
    const onAction = vi.fn();
    const explanation = { ...fact, id: 'ice-explanation', kind: 'explanation' as const };
    const view = render(
      <AnnotatedText text={explanation.quote} annotations={[explanation]} onAction={onAction} />,
    );

    fireEvent.click(view.getByText(explanation.quote));
    expect(view.getByRole('toolbar', { name: 'Actions for Explanation annotation' })).toBeTruthy();
    expect(view.getByText('Explanation')).toBeTruthy();
    expect(
      Array.from(view.getByRole('toolbar').querySelectorAll('button')).map(
        (button) => button.textContent || button.ariaLabel,
      ),
    ).toEqual(['Close selection actions', 'Simplify', 'Give an example', 'Add to note']);
    fireEvent.click(view.getByRole('button', { name: 'Give an example' }));

    expect(onAction).toHaveBeenCalledWith('give_example', explanation.quote);
  });

  it('opens from the keyboard and dismisses with Escape', () => {
    const view = render(
      <div>
        <button type="button">Outside</button>
        <AnnotatedText text={fact.quote} annotations={[fact]} onAction={() => {}} />
      </div>,
    );
    const mark = view.getByText(fact.quote);

    mark.focus();
    fireEvent.keyDown(mark, { key: 'Enter' });
    expect(view.getByRole('toolbar', { name: 'Actions for Fact annotation' })).toBeTruthy();
    expect(document.activeElement).toBe(view.getByRole('button', { name: 'Dig deeper' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(view.queryByRole('toolbar')).toBeNull();
    expect(document.activeElement).toBe(mark);
  });

  it('uses the whole quote when a Markdown annotation is split across formatting', () => {
    const onAction = vi.fn();
    const source = '**Ice** is less dense than water.';
    const annotation = { ...fact, quote: source };
    const view = render(
      <AnnotatedText text={source} annotations={[annotation]} markdown onAction={onAction} />,
    );

    fireEvent.click(view.getByText('Ice'));
    fireEvent.click(view.getByRole('button', { name: 'Check evidence' }));

    expect(onAction).toHaveBeenCalledWith('check_evidence', source);
  });

  it('keeps a keyboard-opened Markdown annotation mounted and restores focus', () => {
    const source = '**Ice** is less dense than water.';
    const view = render(
      <AnnotatedText
        text={source}
        annotations={[{ ...fact, quote: source, kind: 'explanation' }]}
        markdown
        onAction={() => {}}
      />,
    );
    const mark = view.getByText('Ice');

    mark.focus();
    fireEvent.keyDown(mark, { key: 'Enter' });

    expect(view.getByText('Ice')).toBe(mark);
    expect(view.getByRole('toolbar', { name: 'Actions for Explanation annotation' })).toBeTruthy();
    expect(document.activeElement).toBe(view.getByRole('button', { name: 'Simplify' }));

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(view.queryByRole('toolbar')).toBeNull();
    expect(document.activeElement).toBe(mark);
  });

  it('opens annotation actions even when text is selected in the note editor', () => {
    const onAction = vi.fn();
    const view = render(
      <AnnotatedText text={fact.quote} annotations={[fact]} onAction={onAction} />,
    );
    const outside = document.createTextNode('Selected note text');
    vi.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: outside,
      focusNode: outside,
      isCollapsed: false,
      rangeCount: 1,
    } as unknown as Selection);
    fireEvent.click(view.getByText(fact.quote));
    fireEvent.click(view.getByRole('button', { name: 'Add to note' }));
    expect(onAction).toHaveBeenCalledWith('capture', fact.quote);
  });

  it('keeps an arbitrary text selection active when its annotation is clicked', () => {
    const onAction = vi.fn();
    const view = render(
      <AnnotatedText text={fact.quote} annotations={[fact]} onAction={onAction} />,
    );
    const mark = view.getByText(fact.quote);
    const textNode = mark.firstChild!;
    const selection = {
      anchorNode: textNode,
      focusNode: textNode,
      isCollapsed: false,
      rangeCount: 1,
      toString: () => 'less dense',
      getRangeAt: () => ({
        getBoundingClientRect: () => ({ top: 10, bottom: 20, left: 30 }),
      }),
      removeAllRanges: vi.fn(),
    } as unknown as Selection;
    vi.spyOn(window, 'getSelection').mockReturnValue(selection);

    fireEvent(document, new Event('selectionchange'));
    fireEvent.click(mark);
    fireEvent.click(view.getByRole('button', { name: 'Add to note' }));

    expect(onAction).toHaveBeenCalledWith('capture', 'less dense');
  });

  it('keeps the manual selection menu after the drag-ending click on unmarked text', () => {
    const onAction = vi.fn();
    const view = render(
      <AnnotatedText text={`Before ${fact.quote}`} annotations={[fact]} onAction={onAction} />,
    );
    const ordinaryText = view.getByText((_, element) =>
      Boolean(element?.tagName === 'SPAN' && element.textContent === 'Before '),
    );
    const textNode = ordinaryText.firstChild!;
    vi.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: textNode,
      focusNode: textNode,
      isCollapsed: false,
      rangeCount: 1,
      toString: () => 'Before',
      getRangeAt: () => ({
        getBoundingClientRect: () => ({ top: 10, bottom: 20, left: 30 }),
      }),
      removeAllRanges: vi.fn(),
    } as unknown as Selection);

    fireEvent(document, new Event('selectionchange'));
    fireEvent.click(ordinaryText);
    fireEvent.click(view.getByRole('button', { name: 'Challenge' }));

    expect(onAction).toHaveBeenCalledWith('challenge', 'Before');
  });

  it('dismisses an annotation menu when the page scrolls', () => {
    const view = render(
      <AnnotatedText text={fact.quote} annotations={[fact]} onAction={() => {}} />,
    );

    fireEvent.click(view.getByText(fact.quote));
    expect(view.getByRole('toolbar', { name: 'Actions for Fact annotation' })).toBeTruthy();
    fireEvent.scroll(document);

    expect(view.queryByRole('toolbar')).toBeNull();
  });

  it('dismisses a manual selection menu when the page scrolls', () => {
    const view = render(<AnnotatedText text="Select these words" onAction={() => {}} />);
    const textNode = view.getByText('Select these words').firstChild!;
    vi.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode: textNode,
      focusNode: textNode,
      isCollapsed: false,
      rangeCount: 1,
      toString: () => 'these words',
      getRangeAt: () => ({
        getBoundingClientRect: () => ({ top: 10, bottom: 20, left: 30 }),
      }),
      removeAllRanges: vi.fn(),
    } as unknown as Selection);

    fireEvent(document, new Event('selectionchange'));
    expect(view.getByRole('toolbar', { name: 'Actions for selected text' })).toBeTruthy();
    fireEvent.scroll(document);

    expect(view.queryByRole('toolbar')).toBeNull();
  });

  it('places Remove highlight below the actions, apart from the colour swatches', () => {
    // It sat inline with the swatches, where the one destructive control read
    // as just another colour to click through.
    const view = render(
      <AnnotatedText
        text="Ice floats."
        markdown
        highlights={[{ start: 0, end: 3, quote: 'Ice', color: 'yellow', origin: 'user' }]}
        onHighlight={vi.fn()}
        onAction={() => {}}
      />,
    );
    fireEvent.keyDown(view.getByRole('button', { name: 'Highlight: Ice' }), { key: 'Enter' });

    const remove = view.getByRole('button', { name: 'Remove highlight' });
    expect(remove.classList.contains('selection-actions-remove')).toBe(true);
    expect(remove.closest('[aria-label="Highlight colors"]')).toBeNull();

    const actions = view.getByRole('toolbar').querySelector('.selection-actions-buttons');
    expect(actions).toBeTruthy();
    // Below, not above: compareDocumentPosition reports FOLLOWING for a later node.
    expect(actions!.compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});

it('dismisses a portalled context menu when its chat pane becomes hidden', () => {
  const props = {
    text: 'A supported claim.',
    annotations: [
      {
        id: 'a',
        start: 0,
        end: 18,
        quote: 'A supported claim.',
        kind: 'fact' as const,
        whose: 'assistant' as const,
      },
    ],
    onAction: vi.fn(),
  };
  const view = render(<AnnotatedText {...props} />);
  fireEvent.click(view.getByRole('button', { name: /Fact annotation/ }));
  expect(view.getByRole('toolbar')).toBeTruthy();
  view.rerender(<AnnotatedText {...props} active={false} />);
  expect(view.queryByRole('toolbar')).toBeNull();
  view.rerender(<AnnotatedText {...props} active />);
  expect(view.queryByRole('toolbar')).toBeNull();
});

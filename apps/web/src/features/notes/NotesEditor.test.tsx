// @vitest-environment jsdom

import { EditorView } from '@codemirror/view';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { Note } from '@walden/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NotesEditor from './NotesEditor';

Object.defineProperty(Range.prototype, 'getClientRects', {
  configurable: true,
  value: () => [],
});

const note: Note = {
  id: 'n',
  title: 'Note',
  markdown: '',
  revision: 0,
  provenance: [],
  createdAt: '',
  updatedAt: '',
};

describe('NotesEditor initial proposals', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders an insertion widget with local accept and reject controls', async () => {
    const onAccept = vi.fn();
    const onDismiss = vi.fn();
    const proposal = {
      id: 'p',
      noteId: 'n',
      baseRevision: 0,
      oldText: '',
      newText: '* First item',
      reason: 'capture',
      status: 'pending' as const,
    };
    const view = render(
      <NotesEditor
        note={note}
        proposal={proposal}
        proposals={[proposal]}
        onChange={vi.fn()}
        onAccept={onAccept}
        onDismiss={onDismiss}
        // This test is about the widget's controls, not the reveal animation,
        // which the streaming tests below cover. Waiting on a 16ms-per-frame
        // typewriter made it fail whenever the parallel workspace run starved
        // the interval — waitFor's own timeout is 1s regardless of testTimeout.
        revealProposalImmediately
      />,
    );
    const { container } = view;
    await waitFor(() =>
      expect(container.querySelector('.notes-editor__pending-text')?.textContent).toBe(
        'First item',
      ),
    );
    expect(container.querySelector('.notes-editor__suggestion-label')?.textContent).toBe(
      'Suggested',
    );
    expect(
      container.querySelector('.notes-editor__suggestion-label')?.classList.contains('sr-only'),
    ).toBe(true);
    fireEvent.click(container.querySelector('[aria-label="Accept suggestion"]')!);
    fireEvent.click(container.querySelector('[aria-label="Reject suggestion"]')!);
    expect(onAccept).toHaveBeenCalledWith(proposal);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('previews ghost Markdown without interpreting embedded HTML', async () => {
    const proposal = {
      id: 'markdown',
      noteId: 'n',
      baseRevision: 0,
      oldText: '',
      newText: '* **Important** <img src=x onerror="alert(1)">',
      reason: 'capture',
      status: 'pending' as const,
    };
    const { container } = render(
      <NotesEditor
        note={note}
        proposal={proposal}
        proposals={[proposal]}
        revealProposalImmediately
        onChange={vi.fn()}
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(container.querySelectorAll('.notes-editor__pending-text')).toHaveLength(2),
    );
    expect(container.querySelector('.notes-editor__pending-text')?.textContent).toBe('Important');
    expect(container.querySelector('.notes-editor__pending-text img')).toBeNull();
  });

  it('reveals a captured range without stealing the typing cursor', async () => {
    const onChange = vi.fn();
    const props = {
      note: { ...note, markdown: 'Captured text and my draft' },
      proposal: null,
      proposals: [],
      onChange,
      onAccept: vi.fn(),
      onDismiss: vi.fn(),
    };
    const view = render(<NotesEditor {...props} />);
    const editorView = EditorView.findFromDOM(view.container.querySelector('.cm-editor')!);
    if (!editorView) throw new Error('Expected a mounted CodeMirror view');
    editorView.dispatch({ selection: { anchor: editorView.state.doc.length } });

    view.rerender(<NotesEditor {...props} revealRange={{ from: 0, to: 13, key: 1 }} />);

    expect(editorView.state.selection.main.head).toBe('Captured text and my draft'.length);
    expect(view.container.querySelector('.notes-editor__capture-reveal')?.textContent).toBe(
      'Captured text',
    );
    editorView.dispatch({
      changes: { from: editorView.state.selection.main.head, insert: '!' },
    });
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith('Captured text and my draft!', expect.any(Array)),
    );
  });

  it('maps the caret through an external insertion earlier in the note', async () => {
    const onChange = vi.fn();
    const original = 'Intro\n\nMy draft here';
    const inserted = 'Captured\n\n';
    const props = {
      proposal: null,
      proposals: [],
      onChange,
      onAccept: vi.fn(),
      onDismiss: vi.fn(),
    };
    const view = render(<NotesEditor {...props} note={{ ...note, markdown: original }} />);
    const editorView = EditorView.findFromDOM(view.container.querySelector('.cm-editor')!);
    if (!editorView) throw new Error('Expected a mounted CodeMirror view');
    const logicalCursor = original.indexOf('here');
    editorView.dispatch({ selection: { anchor: logicalCursor } });

    view.rerender(
      <NotesEditor
        {...props}
        note={{ ...note, markdown: `${inserted}${original}`, revision: 1 }}
      />,
    );

    expect(editorView.state.selection.main.head).toBe(inserted.length + logicalCursor);
    editorView.dispatch({
      changes: { from: editorView.state.selection.main.head, insert: 'still ' },
    });
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(
        `${inserted}Intro\n\nMy draft still here`,
        expect.any(Array),
      ),
    );
  });

  it('renders controls for a deletion and rejects it without changing the note', async () => {
    const onChange = vi.fn();
    const onDismiss = vi.fn();
    const proposal = {
      id: 'delete',
      noteId: 'n',
      baseRevision: 0,
      oldText: 'Remove me',
      newText: '',
      reason: 'remove',
      status: 'pending' as const,
    };
    const deletionNote = { ...note, markdown: 'Keep this. Remove me' };
    const view = render(
      <NotesEditor
        note={deletionNote}
        proposal={proposal}
        proposals={[proposal]}
        onChange={onChange}
        onAccept={vi.fn()}
        onDismiss={onDismiss}
        revealProposalImmediately
      />,
    );
    const { container } = view;

    const reject = await waitFor(() => {
      const control = container.querySelector<HTMLButtonElement>(
        '[aria-label="Reject suggestion"]',
      );
      expect(control).not.toBeNull();
      return control!;
    });
    fireEvent.click(reject);
    view.rerender(
      <NotesEditor
        note={deletionNote}
        proposal={null}
        proposals={[]}
        onChange={onChange}
        onAccept={vi.fn()}
        onDismiss={onDismiss}
      />,
    );

    expect(container.querySelector('.cm-content')?.textContent).toContain(deletionNote.markdown);
    expect(onChange).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith('reject', proposal);
  });

  it('shows only the minimal changed text for a long replacement', async () => {
    const markdown =
      'The emergency fund target is three months of essential expenses, held in cash.';
    const replacementNote = { ...note, markdown };
    const proposal = {
      id: 'minimal-replacement',
      noteId: 'n',
      baseRevision: 0,
      oldText: markdown,
      newText: 'The emergency fund target is six months of essential expenses, held in cash.',
      reason: 'adjust target',
      status: 'pending' as const,
    };
    const onAccept = vi.fn();
    const { container } = render(
      <NotesEditor
        note={replacementNote}
        proposal={proposal}
        proposals={[proposal]}
        onChange={vi.fn()}
        onAccept={onAccept}
        onDismiss={vi.fn()}
        revealProposalImmediately
      />,
    );

    await waitFor(() =>
      expect(container.querySelector('.notes-editor__suggestion-text')?.textContent).toBe('six'),
    );
    expect(container.querySelector('.notes-editor__suggestion-old')).toBeNull();
    expect(container.querySelector('.notes-editor__suggestion')?.textContent).not.toContain(
      'emergency fund target',
    );

    const editor = EditorView.findFromDOM(container.querySelector('.cm-editor')!);
    if (!editor) throw new Error('Expected a mounted CodeMirror view');
    editor.dispatch({ selection: { anchor: editor.state.doc.length } });
    fireEvent.keyDown(container.querySelector('.cm-content')!, { key: 'Tab' });
    expect(onAccept).toHaveBeenCalledWith(proposal);
  });

  it('dismisses the ghost before reporting text typed over its selected range', async () => {
    const callbacks: string[] = [];
    const markdown = 'Review this on Monday before lunch.';
    const proposal = {
      id: 'typing-replacement',
      noteId: 'n',
      baseRevision: 0,
      oldText: markdown,
      newText: 'Review this on Tuesday before lunch.',
      reason: 'adjust day',
      status: 'pending' as const,
    };
    const onChange = vi.fn((value: string) => callbacks.push(`change:${value}`));
    const onDismiss = vi.fn(() => callbacks.push('dismiss'));
    const { container } = render(
      <NotesEditor
        note={{ ...note, markdown }}
        proposal={proposal}
        proposals={[proposal]}
        onChange={onChange}
        onAccept={vi.fn()}
        onDismiss={onDismiss}
        revealProposalImmediately
      />,
    );
    await waitFor(() =>
      expect(container.querySelector('.notes-editor__pending-text')?.textContent).toBe('Tuesday'),
    );
    fireEvent.click(
      container.querySelector('.notes-editor__suggestion > .notes-editor__suggestion-text')!,
    );

    const editorView = EditorView.findFromDOM(container.querySelector('.cm-editor')!);
    expect(editorView).not.toBeNull();
    if (!editorView) throw new Error('Expected a mounted CodeMirror view');
    const selection = editorView.state.selection.main;
    editorView.dispatch({
      changes: { from: selection.from, to: selection.to, insert: 'Friday' },
    });

    const typed = 'Review this on Friday before lunch.';
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(typed, expect.any(Array)));
    expect(onDismiss).toHaveBeenCalledWith('typing', proposal);
    expect(callbacks).toEqual(['dismiss', `change:${typed}`]);
  });

  it('keeps the ghost when typing only touches surrounding anchor text', async () => {
    const markdown = 'Review this on Monday before lunch.';
    const proposal = {
      id: 'typing-nearby',
      noteId: 'n',
      baseRevision: 0,
      oldText: markdown,
      newText: 'Review this on Tuesday before lunch.',
      reason: 'adjust day',
      status: 'pending' as const,
    };
    const onDismiss = vi.fn();
    const { container } = render(
      <NotesEditor
        note={{ ...note, markdown }}
        proposal={proposal}
        proposals={[proposal]}
        onChange={vi.fn()}
        onAccept={vi.fn()}
        onDismiss={onDismiss}
        revealProposalImmediately
      />,
    );
    await waitFor(() =>
      expect(container.querySelector('.notes-editor__suggestion-text')?.textContent).toBe(
        'Tuesday',
      ),
    );
    const editorView = EditorView.findFromDOM(container.querySelector('.cm-editor')!);
    if (!editorView) throw new Error('Expected a mounted CodeMirror view');
    editorView.dispatch({ changes: { from: 0, to: 0, insert: 'Please ' } });

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it.each([
    ['Monday', 'Tuesday'],
    ['four', 'fourteen'],
  ])('expands character-level replacement %s → %s to whole words', async (before, after) => {
    const prefix = 'Review this on ';
    const suffix = ' before lunch.';
    const proposal = {
      id: `word-${before}`,
      noteId: 'n',
      baseRevision: 0,
      oldText: `${prefix}${before}${suffix}`,
      newText: `${prefix}${after}${suffix}`,
      reason: 'clarify',
      status: 'pending' as const,
    };
    const { container } = render(
      <NotesEditor
        note={{ ...note, markdown: proposal.oldText }}
        proposal={proposal}
        proposals={[proposal]}
        onChange={vi.fn()}
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
        revealProposalImmediately
      />,
    );

    await waitFor(() =>
      expect(container.querySelector('.notes-editor__suggestion-text')?.textContent).toBe(after),
    );
    expect(container.querySelector('.notes-editor__suggestion-old')).toBeNull();
  });

  it('renders saved agent-authored text as normal note content', () => {
    const savedNote = {
      ...note,
      markdown: 'Saved assistant wording',
      provenance: [
        { from: 0, to: 24, origin: 'agent' as const, verbatim: true, captureId: 'capture-1' },
      ],
    };
    const { container } = render(
      <NotesEditor
        note={savedNote}
        proposal={null}
        proposals={[]}
        onChange={vi.fn()}
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(container.querySelector('.cm-content')?.textContent).toContain(
      'Saved assistant wording',
    );
    expect(container.querySelector('.notes-editor__agent-text')).toBeNull();
  });

  it('prevents accepting a suggestion while disabled', async () => {
    const onAccept = vi.fn();
    const proposal = {
      id: 'p',
      noteId: 'n',
      baseRevision: 0,
      oldText: '',
      newText: '* First item',
      reason: 'capture',
      status: 'pending' as const,
    };
    const { container } = render(
      <NotesEditor
        note={note}
        proposal={proposal}
        proposals={[proposal]}
        onChange={vi.fn()}
        onAccept={onAccept}
        onDismiss={vi.fn()}
        disabled
        revealProposalImmediately
      />,
    );

    const accept = await waitFor(() => {
      const control = container.querySelector<HTMLButtonElement>(
        '[aria-label="Accept suggestion"]',
      );
      expect(control?.disabled).toBe(true);
      return control!;
    });
    fireEvent.click(accept);
    fireEvent.keyDown(container.querySelector('.cm-content')!, { key: 'Tab' });

    expect(onAccept).not.toHaveBeenCalled();
  });

  it('routes undo and redo keyboard shortcuts through provided history callbacks', () => {
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    const { container } = render(
      <NotesEditor
        note={{ ...note, markdown: 'Saved note' }}
        proposal={null}
        proposals={[]}
        onChange={vi.fn()}
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
        onUndo={onUndo}
        onRedo={onRedo}
      />,
    );
    const editor = container.querySelector('.cm-content')!;
    const mod = /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };

    fireEvent.keyDown(editor, { key: 'z', ...mod });
    expect(onUndo).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(editor, { key: 'y', ...mod });
    expect(onRedo).toHaveBeenCalledTimes(1);
  });

  it('does not run configured history actions while disabled', () => {
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    const { container } = render(
      <NotesEditor
        note={{ ...note, markdown: 'Saved note' }}
        proposal={null}
        proposals={[]}
        onChange={vi.fn()}
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
        onUndo={onUndo}
        onRedo={onRedo}
        disabled
      />,
    );
    const editor = container.querySelector('.cm-content')!;
    const mod = /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };

    fireEvent.keyDown(editor, { key: 'z', ...mod });
    fireEvent.keyDown(editor, { key: 'y', ...mod });

    expect(onUndo).not.toHaveBeenCalled();
    expect(onRedo).not.toHaveBeenCalled();
  });

  it('allows accepting a suggestion while the note text is read-only', async () => {
    const onAccept = vi.fn();
    const proposal = {
      id: 'p',
      noteId: 'n',
      baseRevision: 0,
      oldText: '',
      newText: '* First item',
      reason: 'capture',
      status: 'pending' as const,
    };
    const { container } = render(
      <NotesEditor
        note={note}
        proposal={proposal}
        proposals={[proposal]}
        onChange={vi.fn()}
        onAccept={onAccept}
        onDismiss={vi.fn()}
        readOnly
        revealProposalImmediately
      />,
    );

    const accept = await waitFor(() => {
      const control = container.querySelector<HTMLButtonElement>(
        '[aria-label="Accept suggestion"]',
      );
      expect(control?.disabled).toBe(false);
      return control!;
    });
    fireEvent.click(accept);

    expect(onAccept).toHaveBeenCalledWith(proposal);
  });

  it('finishes revealing when the suggestion text grows after the reveal completed', async () => {
    // The reveal timer used to retire itself the moment it caught up. The
    // proposal text keeps moving after that — hydrating the settled suggestion
    // replaces the last streamed preview, and it is routinely a little
    // longer — and with streaming already false nothing re-armed the timer. The
    // reveal sat permanently short, and because accepting waits for the reveal,
    // Accept stayed disabled until the page was reloaded.
    vi.useFakeTimers();
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    const preview = {
      id: 'stream',
      noteId: 'n',
      baseRevision: 0,
      oldText: '',
      newText: 'Anodizing resists corrosion',
      reason: 'capture',
      status: 'pending' as const,
    };
    const show = (value: typeof preview) => (
      <NotesEditor
        note={note}
        proposal={value}
        proposals={[value]}
        proposalStreaming={false}
        onChange={vi.fn()}
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    const accept = () =>
      view.getByRole('button', { name: 'Accept suggestion' }) as HTMLButtonElement;

    const view = render(show(preview));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(accept().disabled).toBe(false);

    // The settled suggestion arrives, longer than the preview, under the same
    // id and with streaming already finished — so nothing about the effect's
    // inputs changes except the text itself.
    const settled = { ...preview, newText: 'Anodizing resists corrosion over time.' };
    view.rerender(show(settled));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));

    expect(view.container.querySelector('.notes-editor__suggestion-text')?.textContent).toBe(
      settled.newText,
    );
    expect(accept().disabled).toBe(false);
  });

  it('blocks acceptance while a streaming suggestion is arriving and revealing', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    const onAccept = vi.fn();
    const partial = {
      id: 'stream',
      noteId: 'n',
      baseRevision: 0,
      oldText: '',
      newText: 'First',
      reason: 'capture',
      status: 'pending' as const,
    };
    const view = render(
      <NotesEditor
        note={note}
        proposal={partial}
        proposals={[partial]}
        proposalStreaming
        onChange={vi.fn()}
        onAccept={onAccept}
        onDismiss={vi.fn()}
      />,
    );

    expect(view.getByText('Suggesting…')).toBeTruthy();
    expect(
      (view.getByRole('button', { name: 'Accept suggestion' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(view.container.querySelector('.cm-content')!, { key: 'Tab' });
    expect(onAccept).not.toHaveBeenCalled();

    const complete = { ...partial, newText: 'First thought, completed.' };
    view.rerender(
      <NotesEditor
        note={note}
        proposal={complete}
        proposals={[complete]}
        proposalStreaming={false}
        onChange={vi.fn()}
        onAccept={onAccept}
        onDismiss={vi.fn()}
      />,
    );
    expect(
      (view.getByRole('button', { name: 'Accept suggestion' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(view.getByText('Suggested')).toBeTruthy();
    expect(
      (view.getByRole('button', { name: 'Accept suggestion' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.click(view.getByRole('button', { name: 'Accept suggestion' }));
    expect(onAccept).toHaveBeenCalledWith(complete);
  });

  it('keeps one widget and reveals monotonically as the streaming target grows', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    const partial = {
      id: 'stable-stream',
      noteId: 'n',
      baseRevision: 0,
      oldText: '',
      newText: 'Smooth',
      reason: 'capture',
      status: 'pending' as const,
    };
    const props = {
      note,
      proposals: [partial],
      proposalStreaming: true,
      onChange: vi.fn(),
      onAccept: vi.fn(),
      onDismiss: vi.fn(),
    };
    const view = render(<NotesEditor {...props} proposal={partial} />);
    const widget = view.container.querySelector('.notes-editor__suggestion');
    for (const newText of ['Smoothly', 'Smoothly animated', 'Smoothly animated text']) {
      view.rerender(
        <NotesEditor
          {...props}
          proposal={{ ...partial, newText }}
          proposals={[{ ...partial, newText }]}
        />,
      );
      await act(async () => vi.advanceTimersByTimeAsync(8));
    }
    const before =
      view.container.querySelector('.notes-editor__suggestion-text')?.textContent ?? '';
    expect(before.length).toBeGreaterThan(0);

    view.rerender(
      <NotesEditor
        {...props}
        proposal={{ ...partial, newText: 'Smoothly animated text that continues' }}
        proposals={[{ ...partial, newText: 'Smoothly animated text that continues' }]}
      />,
    );
    expect(view.container.querySelector('.notes-editor__suggestion')).toBe(widget);
    expect(view.container.querySelector('.notes-editor__suggestion-text')?.textContent).toBe(
      before,
    );

    await act(async () => vi.advanceTimersByTimeAsync(40));
    const after = view.container.querySelector('.notes-editor__suggestion-text')?.textContent ?? '';
    expect(after.startsWith(before)).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
  });

  it('allows rejection during streaming without saving or changing the note', () => {
    const onAccept = vi.fn();
    const onChange = vi.fn();
    const onDismiss = vi.fn();
    const proposal = {
      id: 'stream',
      noteId: 'n',
      baseRevision: 0,
      oldText: 'Original note',
      newText: 'Original note plus more',
      reason: 'capture',
      status: 'pending' as const,
    };
    const unchangedNote = { ...note, markdown: 'Original note' };
    const view = render(
      <NotesEditor
        note={unchangedNote}
        proposal={proposal}
        proposals={[proposal]}
        proposalStreaming
        onChange={onChange}
        onAccept={onAccept}
        onDismiss={onDismiss}
      />,
    );

    fireEvent.click(view.getByRole('button', { name: 'Cancel note suggestion' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(view.container.querySelector('.cm-content')?.textContent).toContain('Original note');
  });

  it('reveals suggestions immediately when reduced motion is preferred', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    const proposal = {
      id: 'reduced',
      noteId: 'n',
      baseRevision: 0,
      oldText: '',
      newText: 'Shown at once',
      reason: 'capture',
      status: 'pending' as const,
    };
    const view = render(
      <NotesEditor
        note={note}
        proposal={proposal}
        proposals={[proposal]}
        onChange={vi.fn()}
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
        revealProposalImmediately
      />,
    );

    await waitFor(() => expect(view.getByText('Shown at once')).toBeTruthy());
    expect(
      (view.getByRole('button', { name: 'Accept suggestion' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('shows a read-only proposal that starts as an empty streaming partial', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    const base = {
      id: 'late-stream',
      noteId: 'unsaved-note',
      baseRevision: 0,
      oldText: '',
      newText: '',
      reason: 'capture',
      status: 'pending' as const,
    };
    const props = {
      note,
      proposals: [],
      onChange: vi.fn(),
      onAccept: vi.fn(),
      onDismiss: vi.fn(),
      readOnly: true,
    };
    const view = render(<NotesEditor {...props} proposal={null} />);

    view.rerender(
      <NotesEditor {...props} proposal={base} proposals={[base]} proposalStreaming disabled />,
    );
    expect(view.getByRole('button', { name: 'Cancel note suggestion' })).toBeTruthy();
    expect(view.queryByText('Delete')).toBeNull();

    const complete = { ...base, newText: 'Emergency Fund Strategy' };
    view.rerender(
      <NotesEditor
        {...props}
        proposal={complete}
        proposals={[complete]}
        proposalStreaming={false}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(1_000));

    expect(view.getByText('Emergency Fund Strategy')).toBeTruthy();
    expect(
      (view.getByRole('button', { name: 'Accept suggestion' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('does not replay reveal animation for a persisted suggestion', () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    const persisted = {
      id: 'persisted',
      noteId: 'n',
      baseRevision: 0,
      oldText: '',
      newText: 'Already generated',
      reason: 'capture',
      status: 'pending' as const,
    };
    const view = render(
      <NotesEditor
        note={note}
        proposal={persisted}
        proposals={[persisted]}
        revealProposalImmediately
        onChange={vi.fn()}
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(view.getByText('Already generated')).toBeTruthy();
    expect(
      (view.getByRole('button', { name: 'Accept suggestion' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe('NotesEditor multiple pending proposals', () => {
  const markdown = 'Monday plan\nSave four months';
  const proposals = [
    {
      id: 'day',
      noteId: 'n',
      baseRevision: 0,
      oldText: 'Monday',
      newText: 'Tuesday',
      reason: 'day',
      status: 'pending' as const,
    },
    {
      id: 'months',
      noteId: 'n',
      baseRevision: 0,
      oldText: 'four',
      newText: 'fourteen',
      reason: 'months',
      status: 'pending' as const,
    },
  ];

  function renderMultiple(overrides: Partial<React.ComponentProps<typeof NotesEditor>> = {}) {
    return render(
      <NotesEditor
        note={{ ...note, markdown }}
        proposal={null}
        proposals={proposals}
        revealProposalImmediately
        onChange={vi.fn()}
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
        {...overrides}
      />,
    );
  }

  it('puts independent pending text in the editor and accepts only the focused candidate', () => {
    const onAccept = vi.fn();
    const view = renderMultiple({ onAccept });
    const editor = EditorView.findFromDOM(view.container.querySelector('.cm-editor')!);
    if (!editor) throw new Error('Expected a mounted CodeMirror view');

    expect(editor.state.doc.toString()).toBe('Tuesday plan\nSave fourteen months');
    expect(view.container.querySelectorAll('.notes-editor__pending-text')).toHaveLength(2);
    expect(view.container.querySelector('.notes-editor__pending-text')?.textContent).toBe(
      'Tuesday',
    );
    editor.dispatch({ selection: { anchor: editor.state.doc.toString().indexOf('Tuesday') + 2 } });
    fireEvent.keyDown(view.container.querySelector('.cm-content')!, { key: 'Tab' });
    expect(onAccept).toHaveBeenCalledWith(proposals[0]);
    expect(onAccept).toHaveBeenCalledTimes(1);

    view.rerender(
      <NotesEditor
        note={{ ...note, markdown: 'Tuesday plan\nSave four months', revision: 1 }}
        proposal={null}
        proposals={[proposals[1]]}
        revealProposalImmediately
        onChange={vi.fn()}
        onAccept={onAccept}
        onDismiss={vi.fn()}
      />,
    );
    expect(editor.state.doc.toString()).toBe('Tuesday plan\nSave fourteen months');
    expect(view.container.querySelectorAll('.notes-editor__pending-text')).toHaveLength(1);
  });

  it('does nothing on Escape outside pending candidate lines', () => {
    const onDismiss = vi.fn();
    const view = renderMultiple({
      onDismiss,
      note: { ...note, markdown: `${markdown}\nDone` },
    });
    const editor = EditorView.findFromDOM(view.container.querySelector('.cm-editor')!);
    if (!editor) throw new Error('Expected a mounted CodeMirror view');
    editor.dispatch({ selection: { anchor: editor.state.doc.toString().indexOf('Done') } });
    fireEvent.keyDown(view.container.querySelector('.cm-content')!, { key: 'Escape' });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('selects same-anchor insertions independently with Tab and Escape', () => {
    const sameAnchor = [
      { ...proposals[0], id: 'a', oldText: '', newText: 'Blue door. ' },
      { ...proposals[0], id: 'b', oldText: '', newText: 'Closes Tuesdays. ' },
    ];
    const onAccept = vi.fn();
    const onDismiss = vi.fn();
    const view = render(
      <NotesEditor
        note={{ ...note, markdown: '' }}
        proposal={null}
        proposals={sameAnchor}
        revealProposalImmediately
        onChange={vi.fn()}
        onAccept={onAccept}
        onDismiss={onDismiss}
      />,
    );
    const editor = EditorView.findFromDOM(view.container.querySelector('.cm-editor')!);
    if (!editor) throw new Error('Expected a mounted CodeMirror view');
    expect(editor.state.doc.toString()).toBe('Blue door. \n\nCloses Tuesdays. ');

    editor.dispatch({ selection: { anchor: 2 } });
    fireEvent.keyDown(view.container.querySelector('.cm-content')!, { key: 'Tab' });
    expect(onAccept).toHaveBeenCalledWith(sameAnchor[0]);

    editor.dispatch({ selection: { anchor: editor.state.doc.toString().indexOf('Closes') + 2 } });
    fireEvent.keyDown(view.container.querySelector('.cm-content')!, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledWith('reject', sameAnchor[1]);
  });

  it('enables the button when only the streaming proposal IDs change', () => {
    const onAccept = vi.fn();
    const props = {
      note: { ...note, markdown },
      proposal: null,
      proposals,
      revealProposalImmediately: true,
      onChange: vi.fn(),
      onAccept,
      onDismiss: vi.fn(),
    };
    const streamingIds = new Set(['day']);
    const view = render(<NotesEditor {...props} streamingProposalIds={streamingIds} />);
    const accept = () =>
      view.container.querySelector('[aria-label="Accept suggestion"]') as HTMLButtonElement;
    expect(accept().disabled).toBe(true);
    view.rerender(<NotesEditor {...props} streamingProposalIds={new Set()} />);
    expect(accept().disabled).toBe(false);
    fireEvent.click(accept());
    expect(onAccept).toHaveBeenCalledWith(proposals[0]);
  });

  it('blocks only streamed previews from Tab until the batch is ready', () => {
    const onAccept = vi.fn();
    const view = renderMultiple({
      onAccept,
      streamingProposalIds: new Set(['day']),
    });
    const editor = EditorView.findFromDOM(view.container.querySelector('.cm-editor')!);
    if (!editor) throw new Error('Expected a mounted CodeMirror view');

    editor.dispatch({ selection: { anchor: 2 } });
    fireEvent.keyDown(view.container.querySelector('.cm-content')!, { key: 'Tab' });
    expect(onAccept).not.toHaveBeenCalled();

    editor.dispatch({ selection: { anchor: editor.state.doc.toString().indexOf('fourteen') + 2 } });
    fireEvent.keyDown(view.container.querySelector('.cm-content')!, { key: 'Tab' });
    expect(onAccept).toHaveBeenCalledWith(proposals[1]);

    view.rerender(
      <NotesEditor
        note={{ ...note, markdown }}
        proposal={null}
        proposals={proposals}
        streamingProposalIds={new Set()}
        revealProposalImmediately
        onChange={vi.fn()}
        onAccept={onAccept}
        onDismiss={vi.fn()}
      />,
    );
    editor.dispatch({ selection: { anchor: 2 } });
    fireEvent.keyDown(view.container.querySelector('.cm-content')!, { key: 'Tab' });
    expect(onAccept).toHaveBeenCalledWith(proposals[0]);
  });

  it('dismisses only an overwritten candidate and never emits other pending text', async () => {
    const onChange = vi.fn();
    const onDismiss = vi.fn();
    const view = renderMultiple({ onChange, onDismiss });
    const editor = EditorView.findFromDOM(view.container.querySelector('.cm-editor')!);
    if (!editor) throw new Error('Expected a mounted CodeMirror view');
    const from = editor.state.doc.toString().indexOf('Tuesday');
    editor.dispatch({ changes: { from, to: from + 'Tuesday'.length, insert: 'Friday' } });

    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith('typing', proposals[0]));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('Friday plan\nSave four months', expect.any(Array));
  });

  it('maps unrelated typing to canonical Markdown without leaking pending text', async () => {
    const onChange = vi.fn();
    const onDismiss = vi.fn();
    const view = renderMultiple({ onChange, onDismiss });
    const editor = EditorView.findFromDOM(view.container.querySelector('.cm-editor')!);
    if (!editor) throw new Error('Expected a mounted CodeMirror view');
    editor.dispatch({ changes: { from: editor.state.doc.length, insert: '!' } });

    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(`${markdown}!`, expect.any(Array)),
    );
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('surfaces conflicting candidates instead of silently hiding them', () => {
    const onAccept = vi.fn();
    const conflicts = [
      { ...proposals[0], id: 'a' },
      { ...proposals[0], id: 'b', newText: 'Wednesday' },
    ];
    const view = renderMultiple({ proposals: conflicts, onAccept });

    expect(
      view
        .getAllByRole('status')
        .filter((status) => status.textContent?.includes('conflicts with another pending edit')),
    ).toHaveLength(2);
    fireEvent.keyDown(view.container.querySelector('.cm-content')!, { key: 'Tab' });
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('does not render an unrevealed streaming insertion as a deletion', () => {
    const active = proposals[0];
    const view = renderMultiple({
      proposal: active,
      proposals: [active],
      proposalStreaming: true,
    });
    const suggestion = view.container.querySelector<HTMLElement>('.notes-editor__suggestion');

    expect(suggestion?.getAttribute('aria-label')).toBe('Preparing suggested text');
    expect(suggestion?.textContent).not.toContain('Delete');
  });
});

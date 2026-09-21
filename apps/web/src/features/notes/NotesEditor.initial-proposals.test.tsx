// @vitest-environment jsdom

import { EditorView } from '@codemirror/view';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import NotesEditor from './NotesEditor';
import { note } from './NotesEditor.test-fixtures';

Object.defineProperty(Range.prototype, 'getClientRects', {
  configurable: true,
  value: () => [],
});

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
    expect(container.querySelector('.notes-editor__pending-text')?.textContent).toBe('First item'),
  );
  expect(container.querySelector('.notes-editor__suggestion-label')?.textContent).toBe('Suggested');
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
    <NotesEditor {...props} note={{ ...note, markdown: `${inserted}${original}`, revision: 1 }} />,
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
    const control = container.querySelector<HTMLButtonElement>('[aria-label="Reject suggestion"]');
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
  const markdown = 'The emergency fund target is three months of essential expenses, held in cash.';
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
    expect(container.querySelector('.notes-editor__suggestion-text')?.textContent).toBe('Tuesday'),
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

  expect(container.querySelector('.cm-content')?.textContent).toContain('Saved assistant wording');
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
    const control = container.querySelector<HTMLButtonElement>('[aria-label="Accept suggestion"]');
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
    const control = container.querySelector<HTMLButtonElement>('[aria-label="Accept suggestion"]');
    expect(control?.disabled).toBe(false);
    return control!;
  });
  fireEvent.click(accept);

  expect(onAccept).toHaveBeenCalledWith(proposal);
});

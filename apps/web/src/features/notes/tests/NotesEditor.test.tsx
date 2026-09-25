// @vitest-environment jsdom

import { EditorView } from '@codemirror/view';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import NotesEditor from '../editor/NotesEditor';
import { makeProposal, note } from './NotesEditor.test-fixtures';

Object.defineProperty(Range.prototype, 'getClientRects', {
  configurable: true,
  value: () => [],
});

const markdown = 'Monday plan\nSave four months';
const proposals = [
  makeProposal({ id: 'day', oldText: 'Monday', newText: 'Tuesday', reason: 'day' }),
  makeProposal({ id: 'months', oldText: 'four', newText: 'fourteen', reason: 'months' }),
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

it('nests and unnests a list item with Tab and Shift-Tab', () => {
  const view = renderMultiple({
    note: { ...note, markdown: '- Parent\n- Child' },
    proposals: [],
  });
  const editor = EditorView.findFromDOM(view.container.querySelector('.cm-editor')!);
  if (!editor) throw new Error('Expected a mounted CodeMirror view');
  const content = view.container.querySelector('.cm-content')!;

  editor.dispatch({ selection: { anchor: editor.state.doc.line(2).from + 2 } });
  fireEvent.keyDown(content, { key: 'Tab' });
  expect(editor.state.doc.toString()).toBe('- Parent\n  - Child');

  fireEvent.keyDown(content, { key: 'Tab', shiftKey: true });
  expect(editor.state.doc.toString()).toBe('- Parent\n- Child');
});

it('indents and outdents selected list lines with Tab and Shift-Tab', () => {
  const view = renderMultiple({
    note: { ...note, markdown: '- Parent\n- First\n- Second' },
    proposals: [],
  });
  const editor = EditorView.findFromDOM(view.container.querySelector('.cm-editor')!);
  if (!editor) throw new Error('Expected a mounted CodeMirror view');
  const content = view.container.querySelector('.cm-content')!;

  editor.dispatch({
    selection: { anchor: editor.state.doc.line(2).from, head: editor.state.doc.length },
  });
  fireEvent.keyDown(content, { key: 'Tab' });
  expect(editor.state.doc.toString()).toBe('- Parent\n  - First\n  - Second');
  fireEvent.keyDown(content, { key: 'Tab', shiftKey: true });
  expect(editor.state.doc.toString()).toBe('- Parent\n- First\n- Second');
});

it('does not indent root-level prose', () => {
  const view = renderMultiple({ note: { ...note, markdown: 'Paragraph' }, proposals: [] });
  const editor = EditorView.findFromDOM(view.container.querySelector('.cm-editor')!);
  if (!editor) throw new Error('Expected a mounted CodeMirror view');
  const content = view.container.querySelector('.cm-content')!;

  editor.dispatch({ selection: { anchor: 3 } });
  fireEvent.keyDown(content, { key: 'Tab' });
  expect(editor.state.doc.toString()).toBe('Paragraph');
});

it('nests a paragraph under a list block, including from mid-line', () => {
  const view = renderMultiple({
    note: { ...note, markdown: '- Parent\nParagraph' },
    proposals: [],
  });
  const editor = EditorView.findFromDOM(view.container.querySelector('.cm-editor')!);
  if (!editor) throw new Error('Expected a mounted CodeMirror view');

  editor.dispatch({ selection: { anchor: editor.state.doc.line(2).from + 3 } });
  fireEvent.keyDown(view.container.querySelector('.cm-content')!, { key: 'Tab' });
  expect(editor.state.doc.toString()).toBe('- Parent\n  Paragraph');
});

it('aligns with the previous nested block without skipping a level', () => {
  const view = renderMultiple({
    note: { ...note, markdown: '- Parent\n  - Child\n- Next' },
    proposals: [],
  });
  const editor = EditorView.findFromDOM(view.container.querySelector('.cm-editor')!);
  if (!editor) throw new Error('Expected a mounted CodeMirror view');
  const content = view.container.querySelector('.cm-content')!;

  editor.dispatch({ selection: { anchor: editor.state.doc.line(2).from + 4 } });
  fireEvent.keyDown(content, { key: 'Tab' });
  expect(editor.state.doc.toString()).toBe('- Parent\n  - Child\n- Next');

  editor.dispatch({ selection: { anchor: editor.state.doc.line(3).from + 2 } });
  fireEvent.keyDown(content, { key: 'Tab' });
  expect(editor.state.doc.toString()).toBe('- Parent\n  - Child\n  - Next');
});

it('shows rendered math and reveals its editable source when selected', () => {
  const source = 'Water is $H_2O$.';
  const view = renderMultiple({ note: { ...note, markdown: source }, proposals: [] });
  const editor = EditorView.findFromDOM(view.container.querySelector('.cm-editor')!);
  if (!editor) throw new Error('Expected a mounted CodeMirror view');
  expect(editor.state.doc.toString()).toBe(source);
  expect(view.container.querySelector('.cm-markdown-math .katex')).not.toBeNull();
  fireEvent.click(view.container.querySelector('.cm-markdown-math')!);
  expect(editor.state.selection.main.head).toBe(source.indexOf('$') + 1);
  expect(view.container.querySelector('.cm-markdown-math')).toBeNull();
  expect(view.container.querySelector('.cm-content')?.textContent).toContain('$H_2O$');
});

it('puts independent pending text in the editor and accepts only the focused candidate', () => {
  const onAccept = vi.fn();
  const view = renderMultiple({ onAccept });
  const editor = EditorView.findFromDOM(view.container.querySelector('.cm-editor')!);
  if (!editor) throw new Error('Expected a mounted CodeMirror view');

  expect(editor.state.doc.toString()).toBe('Tuesday plan\nSave fourteen months');
  expect(view.container.querySelectorAll('.notes-editor__pending-text')).toHaveLength(2);
  expect(view.container.querySelector('.notes-editor__pending-text')?.textContent).toBe('Tuesday');
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

  await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(`${markdown}!`, expect.any(Array)));
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

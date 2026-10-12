// @vitest-environment jsdom

import { EditorView } from '@codemirror/view';
import { act, cleanup, render } from '@testing-library/react';
import type { EditProposal, Note } from '@walden/contracts';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import NotesEditor from '../editor/NotesEditor';
import { makeProposal, note } from './NotesEditor.test-fixtures';

Object.defineProperty(Range.prototype, 'getClientRects', {
  configurable: true,
  value: () => [],
});

afterEach(cleanup);

let setProposals: (value: EditProposal[]) => void = () => {};

function Harness({ initial }: { initial: Note }) {
  const [current, setCurrent] = useState(initial);
  const [proposals, update] = useState<EditProposal[]>([]);
  setProposals = update;
  return (
    <NotesEditor
      note={current}
      proposal={null}
      proposals={proposals}
      onChange={(markdown, provenance) =>
        setCurrent((value) => ({ ...value, markdown, provenance }))
      }
      onAccept={vi.fn()}
      onDismiss={vi.fn()}
    />
  );
}

function mount(markdown: string) {
  const view = render(<Harness initial={{ ...note, markdown }} />);
  return EditorView.findFromDOM(view.container.querySelector('.cm-editor')!)!;
}

it('keeps the cursor where the user moved it when the note re-renders after a save', () => {
  const editor = mount('one\ntwo');
  act(() => {
    editor.dispatch({
      changes: { from: 7, insert: 'x' },
      selection: { anchor: 8 },
      userEvent: 'input',
    });
  });
  act(() => editor.dispatch({ selection: { anchor: 1 } }));
  act(() => setProposals([makeProposal({ id: 'added', oldText: '', newText: 'More.' })]));
  expect(editor.state.doc.toString()).toContain('More.');
  expect(editor.state.selection.main.head).toBe(1);
});

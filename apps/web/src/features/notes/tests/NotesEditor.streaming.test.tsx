// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import NotesEditor from '../editor/NotesEditor';
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
  const accept = () => view.getByRole('button', { name: 'Accept suggestion' }) as HTMLButtonElement;

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
  const before = view.container.querySelector('.notes-editor__suggestion-text')?.textContent ?? '';
  expect(before.length).toBeGreaterThan(0);

  view.rerender(
    <NotesEditor
      {...props}
      proposal={{ ...partial, newText: 'Smoothly animated text that continues' }}
      proposals={[{ ...partial, newText: 'Smoothly animated text that continues' }]}
    />,
  );
  expect(view.container.querySelector('.notes-editor__suggestion')).toBe(widget);
  expect(view.container.querySelector('.notes-editor__suggestion-text')?.textContent).toBe(before);

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
    <NotesEditor {...props} proposal={complete} proposals={[complete]} proposalStreaming={false} />,
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

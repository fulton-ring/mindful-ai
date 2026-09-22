// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ThreadHistory } from '../ThreadHistory';

it('shows a retained note as a note entry', () => {
  render(
    <ThreadHistory
      hasThreadOrNote
      loading={false}
      loadError={false}
      search=""
      searchActive={false}
      searchWaiting={false}
      searchFailed={false}
      groups={[
        {
          label: 'Notes',
          threads: [
            {
              id: 'thread-1',
              title: 'Kept note',
              noteId: 'note-1',
              updatedAt: '2026-09-21T12:00:00.000Z',
              expiresAt: '2026-09-20T12:00:00.000Z',
            },
          ],
        },
      ]}
      notes={[]}
      activeConversationId={null}
      activeNoteId={null}
      now={new Date('2026-09-21T12:00:00.000Z')}
      threadOptionsId={null}
      deletingThread={false}
      deletingNote={false}
      onSearchChange={vi.fn()}
      onRetryLoad={vi.fn()}
      onRetrySearch={vi.fn()}
      onThreadOptionsChange={vi.fn()}
      onOpenThread={vi.fn()}
      onArchiveThread={vi.fn()}
      onDeleteThread={vi.fn()}
      onOpenNote={vi.fn()}
      onDeleteNote={vi.fn()}
    />,
  );

  expect(screen.getByRole('button', { name: 'Open note: Kept note' })).toBeTruthy();
});

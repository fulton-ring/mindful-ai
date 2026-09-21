import { describe, expect, it } from 'vitest';
import { cachedDismissedSuggestionIds, restoreCachedNoteDraft } from './workspace-helpers';

const note = {
  id: 'note-1',
  title: 'Note',
  markdown: 'Remote accepted content',
  revision: 4,
  provenance: [],
  createdAt: '',
  updatedAt: '',
};

describe('cached note drafts', () => {
  it('restores revision-matched metadata as an editable dirty draft', () => {
    const restored = restoreCachedNoteDraft(
      note,
      JSON.stringify({ version: 1, baseRevision: 4, markdown: 'Local edit', provenance: [] }),
    );

    expect(restored).toMatchObject({
      state: 'dirty',
      draft: { markdown: 'Local edit', revision: 4 },
    });
  });

  it('keeps a stale or legacy local draft in conflict instead of rebasing it', () => {
    const stale = JSON.stringify({
      version: 1,
      baseRevision: 3,
      markdown: 'Stale local edit',
      provenance: [],
    });
    expect(restoreCachedNoteDraft(note, stale)).toMatchObject({
      state: 'conflict',
      draft: { revision: 3 },
    });
    expect(restoreCachedNoteDraft(note, 'Legacy local edit')).toMatchObject({
      state: 'conflict',
      draft: { markdown: 'Legacy local edit' },
    });
  });

  it('does not create a conflict for a cache identical to the remote note', () => {
    expect(restoreCachedNoteDraft(note, note.markdown)).toEqual({ draft: note, state: 'idle' });
    expect(
      restoreCachedNoteDraft(
        { ...note, revision: 5 },
        JSON.stringify({
          version: 1,
          baseRevision: 4,
          markdown: note.markdown,
          provenance: note.provenance,
        }),
      ),
    ).toEqual({ draft: { ...note, revision: 5 }, state: 'idle' });
  });

  it('restores locally dismissed suggestions with a cached draft', () => {
    const cache = JSON.stringify({
      version: 1,
      baseRevision: 4,
      markdown: 'Local edit',
      provenance: [],
      dismissedSuggestionIds: ['suggestion-1', 7, 'suggestion-2'],
    });
    expect(cachedDismissedSuggestionIds(cache)).toEqual(['suggestion-1', 'suggestion-2']);
  });
});

import type { EditProposal, Note } from '@walden/contracts';

export const note: Note = {
  id: 'n',
  title: 'Note',
  markdown: '',
  revision: 0,
  provenance: [],
  createdAt: '',
  updatedAt: '',
};

export function makeProposal(overrides: Partial<EditProposal> = {}): EditProposal {
  return {
    id: 'proposal',
    noteId: 'n',
    baseRevision: 0,
    oldText: '',
    newText: '',
    reason: 'test',
    status: 'pending',
    ...overrides,
  };
}

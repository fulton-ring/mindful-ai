import type { Conversation, EditProposal } from '@walden/contracts';
import { Hono } from 'hono';
import { beforeEach, vi } from 'vitest';
import { HttpError } from '../../../http';
import { textMessage } from '../../../tests/ui-messages';
import type { Bindings, Variables } from '../../../types';

const mocks = vi.hoisted(() => ({
  annotateTurn: vi.fn(),
  streamAnnotations: vi.fn(),
  streamNoteProposal: vi.fn(),
  createAgentService: vi.fn(),
  loadConversation: vi.fn(),
  personaFor: vi.fn(),
  loadNoteSuggestionBatch: vi.fn(),
  loadNoteSuggestionBySource: vi.fn(),
  loadPendingNoteSuggestions: vi.fn(async () => []),
  persistNoteSuggestion: vi.fn(),
  cancelNoteSuggestionAttempt: vi.fn(),
  loadNoteState: vi.fn(),
}));

export function getMocks() {
  return mocks;
}

vi.mock('../../../services/agent/agent', () => ({
  createAgentService: mocks.createAgentService,
}));
vi.mock('../../../http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../http')>()),
  newId: () => 'proposal-attempt',
}));
vi.mock('../../conversations/repository', () => ({
  loadConversation: mocks.loadConversation,
}));
vi.mock('../../turns/turn-support', () => ({
  personaFor: mocks.personaFor,
}));
vi.mock('../../../notes/suggestions/suggestions', () => ({
  cancelNoteSuggestionAttempt: mocks.cancelNoteSuggestionAttempt,
  loadNoteSuggestionBatch: mocks.loadNoteSuggestionBatch,
  loadNoteSuggestionBySource: mocks.loadNoteSuggestionBySource,
  loadPendingNoteSuggestions: mocks.loadPendingNoteSuggestions,
  persistNoteSuggestion: mocks.persistNoteSuggestion,
}));
vi.mock('../../../notes/history/history', () => ({ loadNoteState: mocks.loadNoteState }));

import { followupRoutes } from '../followups';

export const userMessage = textMessage('user-message', 'user', 'Capture the deployment decision.', {
  createdAt: '2026-09-18T12:00:00.000Z',
});
export const assistantMessage = textMessage(
  'assistant-message',
  'assistant',
  'Use the smaller deployment for the first release.',
  { createdAt: '2026-09-18T12:00:01.000Z' },
);

export function conversation(
  messages: Conversation['messages'] = [userMessage, assistantMessage],
): Conversation {
  return {
    id: 'conversation',
    title: 'Deployment',
    noteId: 'note',
    messages,
    expiresAt: '2999-01-01T00:00:00.000Z',
    learningChecksEnabled: false,
    branchId: 'branch',
    branches: [],
  };
}

export function database(noteRevision = 3, latestNote?: { markdown: string; revision: number }) {
  let noteReads = 0;
  const updates: unknown[][] = [];
  const deletedSuggestions: unknown[][] = [];
  return {
    updates,
    deletedSuggestions,
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          args = values;
          return statement;
        },
        async first<T>() {
          if (sql.includes('FROM notes')) {
            noteReads++;
            return {
              id: 'note',
              title: 'Deployment',
              markdown: noteReads > 1 && latestNote ? latestNote.markdown : 'Deployment notes.',
              revision: noteReads > 1 && latestNote ? latestNote.revision : noteRevision,
              provenance_json: '[]',
              created_at: '2026-09-18T11:00:00.000Z',
              updated_at: '2026-09-18T11:00:00.000Z',
            } as T;
          }
          if (sql.includes('SELECT turn_id FROM messages')) return { turn_id: 'turn' } as T;
          return null;
        },
        async run() {
          if (sql.includes('INSERT INTO message_highlights')) updates.push(args);
          if (sql.includes('DELETE FROM note_suggestions')) deletedSuggestions.push(args);
          return { success: true, meta: { changes: 1 } };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  } as unknown as D1Database & { updates: unknown[][]; deletedSuggestions: unknown[][] };
}

export function testRouter() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'owner');
    c.set('authSubject', 'subject');
    await next();
  });
  app.route('/api/chat', followupRoutes);
  app.onError((error, c) =>
    error instanceof HttpError ? c.json({ error: error.message }, error.status) : c.json({}, 500),
  );
  return app;
}

export function testApp(db: D1Database) {
  const app = testRouter();
  return async (
    operation: 'annotations' | 'note-proposal',
    noteRevision: number | null = 3,
    stream = false,
    noteProposalRequested?: boolean,
    extraRequest: Record<string, unknown> = {},
  ) => {
    const pending: Promise<unknown>[] = [];
    const response = await app.fetch(
      new Request(
        `https://walden.test/api/chat/messages/assistant-message/${operation}${stream ? '?stream=1' : ''}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            conversationId: 'conversation',
            branchId: 'branch',
            personaId: '',
            noteRevision,
            noteProposalRequested,
            ...extraRequest,
          }),
        },
      ),
      { DB: db } as Bindings,
      { waitUntil: (task: Promise<unknown>) => pending.push(task) } as unknown as ExecutionContext,
    );
    return { response, pending };
  };
}

export function events(body: string) {
  return body
    .split('\n\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line.replace(/^data: /, '')));
}

export const proposal: EditProposal = {
  id: 'proposal',
  noteId: 'note',
  baseRevision: 3,
  oldText: 'Deployment notes.',
  newText: 'Use the smaller deployment for the first release.',
  reason: 'Captures the deployment decision.',
  status: 'pending',
};
export const attemptedProposal = { ...proposal, id: 'proposal-attempt' };

export function resetMocks() {
  vi.clearAllMocks();
  mocks.createAgentService.mockReturnValue({
    annotateTurn: mocks.annotateTurn,
    streamAnnotations: mocks.streamAnnotations,
    streamNoteProposal: mocks.streamNoteProposal,
  });
  mocks.personaFor.mockResolvedValue({
    id: 'default',
    name: 'Default',
    prompt: '',
    tone: 'neutral',
    brevity: 'balanced',
    challenge: 'balanced',
    revision: 1,
  });
  mocks.loadNoteSuggestionBySource.mockResolvedValue(null);
  mocks.loadNoteSuggestionBatch.mockResolvedValue([]);
  mocks.persistNoteSuggestion.mockImplementation(async (_db, input) => ({
    noteId: input.proposal.noteId,
    suggestion: input.proposal,
    created: true,
  }));
  mocks.cancelNoteSuggestionAttempt.mockResolvedValue({
    noteId: null,
    cancelledSuggestionIds: [],
  });
  mocks.loadNoteState.mockResolvedValue(null);
}

beforeEach(resetMocks);

beforeEach(resetMocks);

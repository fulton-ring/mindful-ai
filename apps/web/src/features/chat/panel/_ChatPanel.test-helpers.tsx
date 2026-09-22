import { cleanup } from '@testing-library/react';
import type { Annotation, Conversation, MessageHighlight } from '@walden/contracts';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  setWebSearch: vi.fn(),
  setLearningChecks: vi.fn(),
  cancelTurn: vi.fn().mockResolvedValue({ cancelled: true }),
  cancelNoteProposal: vi.fn().mockResolvedValue({ cancelledSuggestionIds: [], noteState: null }),
  messageAnnotations: vi.fn(),
  saveHighlight: vi.fn(),
  streamChat: vi.fn(),
  streamMessageAnnotations: vi.fn(),
  streamNoteProposal: vi.fn(),
}));

export function getTransport() {
  return transport;
}

vi.mock('../../../lib/api', () => ({
  api: {
    setWebSearch: transport.setWebSearch,
    setLearningChecks: transport.setLearningChecks,
    cancelTurn: transport.cancelTurn,
    cancelNoteProposal: transport.cancelNoteProposal,
    messageAnnotations: transport.messageAnnotations,
    saveHighlight: transport.saveHighlight,
  },
  streamChat: transport.streamChat,
  streamMessageAnnotations: transport.streamMessageAnnotations,
  streamNoteProposal: transport.streamNoteProposal,
}));
vi.mock('../../../lib/telemetry', () => ({ track: vi.fn() }));
vi.mock('../../highlights/AnnotatedText', () => ({
  AnnotatedText: ({
    text,
    annotations,
    onAction,
    onHighlight,
    actionStatus,
  }: {
    text: string;
    annotations?: Annotation[];
    onAction(action: 'capture', quote: string): void;
    onHighlight?(value: MessageHighlight): Promise<void>;
    actionStatus?: {
      pending: boolean;
      message?: string;
      alert?: boolean;
      onRetry?(): void;
      onDismiss?(): void;
    } | null;
  }) => (
    <div data-annotation-count={annotations?.length ?? 0}>
      {text}
      {/* A capture reports back into the selection menu, so the double shows it
          the way the real one does. */}
      {actionStatus?.pending && <span>Adding to note…</span>}
      {actionStatus && !actionStatus.pending && actionStatus.message && (
        <span role={actionStatus.alert ? 'alert' : 'status'}>{actionStatus.message}</span>
      )}
      {actionStatus?.onRetry && !actionStatus.pending && (
        <button type="button" onClick={actionStatus.onRetry}>
          Retry note proposal
        </button>
      )}
      {actionStatus?.onDismiss && !actionStatus.pending && (
        <button type="button" onClick={actionStatus.onDismiss}>
          Dismiss note error
        </button>
      )}
      {onHighlight && (
        <button
          type="button"
          onClick={() =>
            void onHighlight({
              start: 0,
              end: text.length,
              quote: text,
              color: null,
              origin: 'user',
            })
          }
        >
          Remove highlight
        </button>
      )}
      {text && (
        <button type="button" onClick={() => onAction('capture', text)}>
          Add selection to note
        </button>
      )}
    </div>
  ),
}));
vi.mock('../../personas/PersonaPicker', () => ({
  PersonaPicker: () => null,
  effectivePersona: (personas: Array<{ id: string }>, value: string) =>
    personas.find((persona) => persona.id === value) ??
    personas.find((persona) => persona.id === 'thinking-partner') ??
    personas[0],
}));
vi.mock('../../capture/InterventionCard', () => ({
  InterventionCard: ({ onCapture }: { onCapture(value: string, verbatim: boolean): void }) => (
    <button type="button" onClick={() => onCapture('Intervention exact text', true)}>
      Capture intervention
    </button>
  ),
}));
vi.mock('../../../components/ai-elements/reasoning', () => ({
  Reasoning: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ReasoningContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ReasoningTrigger: () => null,
}));

export const conversation = (id: string): Conversation => ({
  id,
  branchId: 'branch-1',
  branches: [
    {
      id: 'branch-1',
      forkedFromMessageId: null,
      headMessageId: null,
      expiresAt: '2026-09-25T00:00:00.000Z',
    },
  ],
  title: 'Conversation',
  noteId: null,
  messages: [],
  expiresAt: '2026-09-25T00:00:00.000Z',
  learningChecksEnabled: false,
});

export function props(value = conversation('conversation-1')) {
  return {
    conversation: value,
    scopeId: value.id,
    personas: [],
    personaId: '',
    noteOpen: true,
    onPersona: vi.fn(),
    onOpenNote: vi.fn(),
    onEnsureConversation: vi.fn().mockResolvedValue(value),
    onConversation: vi.fn(),
    onFlush: vi.fn().mockResolvedValue(null),
    onProposalStart: vi.fn(),
    onProposalCancelable: vi.fn(),
    onGhost: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  transport.streamMessageAnnotations.mockImplementation(
    async (
      messageId: string,
      input: unknown,
      onEvent: (event: unknown) => void,
      signal: AbortSignal,
    ) => {
      const annotations = await transport.messageAnnotations(messageId, input, signal);
      onEvent({ type: 'done', annotations });
    },
  );
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  Element.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollTo = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

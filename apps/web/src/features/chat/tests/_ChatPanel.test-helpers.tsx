import { EditorView } from '@codemirror/view';
import { act, cleanup } from '@testing-library/react';
import type {
  Annotation,
  Conversation,
  MessageHighlight,
  WaldenDataParts,
  WaldenMessageMetadata,
  WaldenUIMessage,
} from '@walden/contracts';
import type { UIMessageChunk } from 'ai';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  setWebSearch: vi.fn(),
  setLearningChecks: vi.fn(),
  cancelTurn: vi.fn().mockResolvedValue({ cancelled: true }),
  activeTurn: vi.fn().mockResolvedValue({ turn: null }),
  conversation: vi.fn(),
  /** POST /turns: resolves `{ turnId }` (see `openTurn`), or rejects like the server would. */
  startTurn: vi.fn(),
  /** GET /turns/:id/events: served from the streams `openTurn` registers. */
  turnEvents: vi.fn(),
  cancelNoteProposal: vi.fn().mockResolvedValue({ cancelledSuggestionIds: [], noteState: null }),
  // Resolves the annotations the mocked streamMessageAnnotations reports as done.
  annotationResults: vi.fn(),
  saveHighlight: vi.fn(),
  uploadAttachment: vi.fn().mockResolvedValue({
    id: 'uploaded',
    name: 'paper.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: 5,
  }),
  streamMessageAnnotations: vi.fn(),
  streamNoteProposal: vi.fn(),
}));

export function getTransport() {
  return transport;
}

export function setComposerValue(element: HTMLElement, value: string) {
  const editor = EditorView.findFromDOM(element);
  if (!editor) throw new Error('Message editor was not mounted');
  act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } }));
}

export function composerValue(element: HTMLElement) {
  return EditorView.findFromDOM(element)?.state.doc.toString();
}

vi.mock('../../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api')>();
  return {
    ApiError: actual.ApiError,
    readSseFrames: actual.readSseFrames,
    api: {
      setWebSearch: transport.setWebSearch,
      setLearningChecks: transport.setLearningChecks,
      cancelTurn: transport.cancelTurn,
      activeTurn: transport.activeTurn,
      startTurn: transport.startTurn,
      turnEvents: transport.turnEvents,
      conversation: transport.conversation,
      cancelNoteProposal: transport.cancelNoteProposal,
      saveHighlight: transport.saveHighlight,
    },
    uploadAttachment: transport.uploadAttachment,
    streamMessageAnnotations: transport.streamMessageAnnotations,
    streamNoteProposal: transport.streamNoteProposal,
  };
});
vi.mock('../../../lib/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/telemetry')>()),
  track: vi.fn(),
}));
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
  InterventionCard: ({
    intervention,
    onResolve,
  }: {
    intervention: { kind: string; id: string; questions?: Array<{ id: string }> };
    onResolve(value: unknown): void;
  }) => (
    <div>
      <p>Learning check card</p>
      {intervention.kind === 'learning_check' && (
        <button
          type="button"
          onClick={() =>
            onResolve({
              checkId: intervention.id,
              answers: { [intervention.questions![0]!.id]: { answers: ['Stroma'] } },
            })
          }
        >
          Submit answers
        </button>
      )}
    </div>
  ),
}));
vi.mock('../panel/ui/ChatToolsMenu', () => ({
  ChatToolsMenu: ({
    webSearch,
    learningChecks,
    autoHighlights,
    disabled,
    onPreference,
    onAutoHighlights,
  }: {
    webSearch: boolean;
    learningChecks: boolean;
    autoHighlights: boolean;
    disabled: boolean;
    onPreference(setting: 'learningChecks' | 'webSearch', enabled: boolean): void;
    onAutoHighlights(enabled: boolean): void;
  }) => (
    <div>
      <button type="button" aria-label="Chat tools">
        Chat tools
      </button>
      <input
        aria-label="Web search"
        type="checkbox"
        checked={webSearch}
        disabled={disabled}
        onChange={(event) => onPreference('webSearch', event.target.checked)}
      />
      <input
        aria-label="Learning checks"
        type="checkbox"
        checked={learningChecks}
        disabled={disabled}
        onChange={(event) => onPreference('learningChecks', event.target.checked)}
      />
      <input
        aria-label="Auto highlights"
        type="checkbox"
        checked={autoHighlights}
        onChange={(event) => onAutoHighlights(event.target.checked)}
      />
    </div>
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

const CREATED_AT = '2026-09-21T00:00:00.000Z';

export function userMessage(
  id: string,
  text: string,
  parts: WaldenUIMessage['parts'] = [],
): WaldenUIMessage {
  return {
    id,
    role: 'user',
    parts: [...parts, { type: 'text', text }],
    metadata: { createdAt: CREATED_AT },
  };
}

export function assistantMessage(
  id: string,
  text: string,
  metadata: Partial<WaldenMessageMetadata> = {},
  parts: WaldenUIMessage['parts'] = [],
): WaldenUIMessage {
  return {
    id,
    role: 'assistant',
    parts: [...parts, ...(text ? [{ type: 'text' as const, text }] : [])],
    metadata: { createdAt: CREATED_AT, ...metadata },
  };
}

/** The saved text of a message, for assertions on `onConversation` payloads. */
export function textOf(message: WaldenUIMessage | undefined) {
  return (message?.parts ?? [])
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('');
}

export const turnData = (data: Partial<WaldenDataParts['turn']> & { reset?: boolean }) =>
  ({
    type: 'data-turn',
    transient: true,
    data: { conversationId: 'conversation-1', branchId: 'branch-1', ...data },
  }) as UIMessageChunk;

export const textChunks = (text: string, id = 'text-1'): UIMessageChunk[] => [
  { type: 'text-start', id },
  { type: 'text-delta', id, delta: text },
  { type: 'text-end', id },
];

/** A whole reply: start (with the turn id as message id), `body` chunks, text, finish. */
export function replyChunks(
  messageId: string,
  text: string,
  options: { body?: UIMessageChunk[]; metadata?: Partial<WaldenMessageMetadata> } = {},
): UIMessageChunk[] {
  return [
    { type: 'start', messageId, messageMetadata: { createdAt: CREATED_AT } },
    ...(options.body ?? []),
    ...(text ? textChunks(text) : []),
    ...(options.metadata
      ? [{ type: 'message-metadata' as const, messageMetadata: options.metadata }]
      : []),
    { type: 'finish' },
  ];
}

/** A server-sent turn event log the test writes to, served by the mocked events endpoint. */
export type TurnStream = { emit(...chunks: UIMessageChunk[]): void; done(): void };
const streams = new Map<string, { body: ReadableStream<Uint8Array>; served: boolean }>();

export function openTurn(
  turnId = 'turn-1',
  { admit = true, userMessageId = null as string | null } = {},
): TurnStream {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let sequence = 0;
  const body = new ReadableStream<Uint8Array>({ start: (value) => (controller = value) });
  streams.set(turnId, { body, served: false });
  // Writes after the client detached (Stop, thread switch) go nowhere, as on the server.
  const write = (frame: string | null) => {
    try {
      if (frame === null) controller.close();
      else controller.enqueue(encoder.encode(frame));
    } catch {
      /* The reader cancelled the stream. */
    }
  };
  if (admit) transport.startTurn.mockResolvedValueOnce({ turnId, userMessageId });
  return {
    emit: (...chunks) => {
      for (const chunk of chunks) write(`id: ${++sequence}\ndata: ${JSON.stringify(chunk)}\n\n`);
    },
    done: () => {
      write('data: [DONE]\n\n');
      write(null);
    },
  };
}

/** Admits the next turn and replays `chunks` to completion. */
export function reply(chunks: UIMessageChunk[], turnId = 'turn-1') {
  const stream = openTurn(turnId);
  stream.emit(...chunks);
  stream.done();
  return stream;
}

/** Admits the next turn and never sends anything. */
export function hang(turnId = 'turn-1') {
  return openTurn(turnId);
}

function serveTurn(turnId: string) {
  const stream = streams.get(turnId);
  // A reconnect after the stream was read (or for an unknown turn) waits forever.
  const body = stream && !stream.served ? stream.body : new ReadableStream<Uint8Array>();
  if (stream) stream.served = true;
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

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
  streams.clear();
  transport.activeTurn.mockResolvedValue({ turn: null });
  transport.startTurn.mockReset();
  transport.turnEvents.mockReset();
  transport.turnEvents.mockImplementation(async (turnId: string) => serveTurn(turnId));
  transport.conversation.mockReset();
  transport.streamMessageAnnotations.mockImplementation(
    async (
      messageId: string,
      input: unknown,
      onEvent: (event: unknown) => void,
      signal: AbortSignal,
    ) => {
      const annotations = await transport.annotationResults(messageId, input, signal);
      onEvent({ type: 'done', annotations });
    },
  );
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({ matches: true, addListener: vi.fn(), removeListener: vi.fn() }),
  );
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

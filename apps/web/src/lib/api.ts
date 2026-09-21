import type {
  Annotation,
  AnnotationEvent,
  AppConfig,
  ChatEvent,
  ChatRequest,
  Conversation,
  ConversationSummary,
  EditProposal,
  MessageHighlight,
  Note,
  NoteProposalEvent,
  NoteState,
  Persona,
  ProductEvent,
  ProvenanceSpan,
  Usage,
} from '@walden/contracts';

export type MessageFollowupRequest = {
  conversationId: string;
  branchId: string;
  personaId: string;
  noteRevision: number | null;
  noteProposalRequested?: boolean;
  action?: 'capture';
  captureText?: string;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

type TokenProvider = (options?: { skipCache?: boolean }) => Promise<string | null>;
let tokenProvider: TokenProvider | null = null;

export function setTokenProvider(provider: TokenProvider | null) {
  tokenProvider = provider;
}

async function fetchWithFreshAuth(path: string, init?: RequestInit): Promise<Response> {
  const firstToken = await tokenProvider?.();
  const headers = new Headers({ 'content-type': 'application/json', ...init?.headers });
  if (firstToken) headers.set('authorization', `Bearer ${firstToken}`);
  const response = await fetch(path, { ...init, headers });
  if (response.status !== 401 || !firstToken || !tokenProvider) return response;
  const refreshedToken = await tokenProvider({ skipCache: true });
  if (!refreshedToken || refreshedToken === firstToken) return response;
  const retryHeaders = new Headers(headers);
  retryHeaders.set('authorization', `Bearer ${refreshedToken}`);
  return fetch(path, { ...init, headers: retryHeaders });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithFreshAuth(path, init);
  const body = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok)
    throw new ApiError(
      response.status,
      (body as { error?: string; message?: string } | undefined)?.error ??
        (body as { message?: string } | undefined)?.message ??
        `Request failed (${response.status})`,
      body,
    );
  return ((body as { data?: T } | undefined)?.data ?? body) as T;
}

type StreamEventHandler<T> = (event: T) => void;

function parseStreamFrame<T>(
  frame: string,
  onEvent: StreamEventHandler<T>,
  isTerminal: (event: T) => boolean,
  onError?: (event: T) => void,
) {
  let terminal = false;
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') {
      terminal = true;
      continue;
    }
    if (!data) continue;
    const event = JSON.parse(data) as T;
    if (isTerminal(event)) terminal = true;
    onEvent(event);
    onError?.(event);
  }
  return terminal;
}

async function consumeEventStream<T>(
  response: Response,
  onEvent: StreamEventHandler<T>,
  isTerminal: (event: T) => boolean,
  signal: AbortSignal,
  interruptionMessage: string,
  onError?: (event: T) => void,
) {
  const reader = response.body?.getReader();
  if (!reader) return false;
  const decoder = new TextDecoder();
  let buffer = '';
  let terminal = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\n\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        terminal = parseStreamFrame(frame, onEvent, isTerminal, onError) || terminal;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!terminal && !signal.aborted) throw new Error(interruptionMessage);
  return terminal;
}

async function streamError(response: Response, fallback: string): Promise<never> {
  const body = await response.json().catch(() => undefined);
  throw new ApiError(
    response.status,
    typeof body?.error === 'string' ? body.error : fallback,
    body,
  );
}

export const api = {
  accountPrivacy: () =>
    request<{ enabled: boolean; acknowledged: boolean; version: string }>('/api/account/privacy'),
  setAccountPrivacy: (enabled: boolean, version: string) =>
    request<{ enabled: boolean; acknowledged: boolean; version: string }>('/api/account/privacy', {
      method: 'PUT',
      body: JSON.stringify({ enabled, version }),
    }),
  exportAccount: () => request<unknown>('/api/account/export'),
  deleteAccount: () => request<void>('/api/account', { method: 'DELETE' }),
  setWebSearch: (conversationId: string, enabled: boolean) =>
    request<{ webSearchEnabled: boolean }>(`/api/conversations/${conversationId}/web-search`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
  setLearningChecks: (conversationId: string, enabled: boolean) =>
    request<{ learningChecksEnabled: boolean }>(
      `/api/conversations/${conversationId}/learning-checks`,
      { method: 'PATCH', body: JSON.stringify({ enabled }) },
    ),
  config: () => request<AppConfig>('/api/config'),
  notes: () => request<Note[]>('/api/notes'),
  createNote: () => request<Note>('/api/notes', { method: 'POST', body: '{}' }),
  note: (id: string) => request<Note>(`/api/notes/${id}`),
  noteState: (id: string) => request<NoteState>(`/api/notes/${id}/state`),
  renameNote: (id: string, title: string) =>
    request<{ title: string }>(`/api/notes/${id}/title`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  saveNote: (
    note: Note,
    operationId: string,
    markdown: string,
    provenance: ProvenanceSpan[],
    dismissSuggestionId?: string,
    dismissSuggestionIds?: string[],
  ) =>
    request<Note | { revision: number; operationId: string }>(`/api/notes/${note.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        operationId,
        baseRevision: note.revision,
        markdown,
        provenance,
        ...(dismissSuggestionId ? { dismissSuggestionId } : {}),
        ...(dismissSuggestionIds?.length ? { dismissSuggestionIds } : {}),
      }),
    }),
  deleteNote: (id: string) => request<void>(`/api/notes/${id}`, { method: 'DELETE' }),
  decideSuggestion: (
    noteId: string,
    suggestionId: string,
    decision: 'accept' | 'reject',
    baseRevision: number,
    operationId: string,
    markdown?: string,
  ) =>
    request<NoteState>(`/api/notes/${noteId}/suggestions/${suggestionId}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision, baseRevision, operationId, markdown }),
    }),
  noteHistory: (id: string, action: 'undo' | 'redo', baseRevision: number, operationId: string) =>
    request<NoteState>(`/api/notes/${id}/${action}`, {
      method: 'POST',
      body: JSON.stringify({ baseRevision, operationId }),
    }),
  startConversation: (noteId?: string) =>
    request<Conversation>(noteId ? `/api/notes/${noteId}/conversations` : '/api/conversations', {
      method: 'POST',
      body: '{}',
    }),
  linkConversationNote: (conversationId: string, noteId: string | null) =>
    request<Conversation>(`/api/conversations/${conversationId}/note`, {
      method: 'PATCH',
      body: JSON.stringify({ noteId }),
    }),
  captureFirstNote: (
    conversationId: string,
    text: string,
    verbatim: boolean,
    operationId: string,
  ) =>
    request<{ conversation: Conversation; note: Note }>(
      `/api/conversations/${encodeURIComponent(conversationId)}/capture`,
      { method: 'POST', body: JSON.stringify({ text, verbatim, operationId }) },
    ),
  capturePlacement: (
    conversationId: string,
    text: string,
    noteRevision: number | null,
    signal?: AbortSignal,
  ) =>
    request<{ proposal: EditProposal | null }>(
      `/api/conversations/${encodeURIComponent(conversationId)}/capture-placement`,
      { method: 'POST', body: JSON.stringify({ text, noteRevision }), signal },
    ),
  conversation: (id: string, branchId?: string | null) =>
    request<Conversation>(
      `/api/conversations/${encodeURIComponent(id)}${branchId ? `?branch=${encodeURIComponent(branchId)}` : ''}`,
    ),
  conversations: (query?: string) =>
    request<ConversationSummary[]>(
      query ? `/api/conversations?q=${encodeURIComponent(query)}` : '/api/conversations',
    ),
  renameConversation: (id: string, title: string) =>
    request<Conversation>(`/api/conversations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  deleteConversation: (id: string) =>
    request<void>(`/api/conversations/${id}`, { method: 'DELETE' }),
  archiveConversation: (id: string) =>
    request<void>(`/api/conversations/${id}?keepNote=1`, { method: 'DELETE' }),
  messageAnnotations: (messageId: string, input: MessageFollowupRequest, signal?: AbortSignal) =>
    request<{ annotations: Annotation[] }>(`/api/chat/messages/${messageId}/annotations`, {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
    }).then(({ annotations }) => annotations),
  cancelNoteProposal: (
    messageId: string,
    input: { conversationId: string; branchId: string; attemptId: string },
  ) =>
    request<{ cancelledSuggestionIds: string[]; noteState: NoteState | null }>(
      `/api/chat/messages/${encodeURIComponent(messageId)}/note-proposal/cancel`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
  saveHighlight: (messageId: string, highlight: MessageHighlight) =>
    request<MessageHighlight>(`/api/chat/messages/${encodeURIComponent(messageId)}/highlights`, {
      method: 'PUT',
      body: JSON.stringify(highlight),
    }),
  cancelTurn: (requestId: string, keepalive = false) =>
    request<{ cancelled: boolean }>(`/api/chat/turns/${encodeURIComponent(requestId)}/cancel`, {
      method: 'POST',
      body: '{}',
      keepalive,
    }),
  personas: () => request<Persona[]>('/api/personas'),
  createPersona: (value: Omit<Persona, 'id' | 'revision'> & { replacesPersonaId?: string }) =>
    request<Persona>('/api/personas', { method: 'POST', body: JSON.stringify(value) }),
  updatePersona: (value: Persona) =>
    request<Persona>(`/api/personas/${value.id}`, { method: 'PATCH', body: JSON.stringify(value) }),
  deletePersona: (id: string) => request<void>(`/api/personas/${id}`, { method: 'DELETE' }),
  usage: () => request<Usage>('/api/usage'),
  connections: () =>
    request<Array<{ id: string; name: string; status: string; description?: string }>>(
      '/api/connections',
    ),
  event: (value: ProductEvent) =>
    request<void>('/api/events', { method: 'POST', body: JSON.stringify(value) }),
  billing: (kind: 'checkout' | 'portal') =>
    request<{ url: string }>(`/api/billing/${kind}`, { method: 'POST', body: '{}' }),
};

export async function streamChat(
  input: ChatRequest,
  onEvent: (event: ChatEvent) => void,
  signal: AbortSignal,
) {
  let receivedTerminalEvent = false;
  try {
    const response = await fetchWithFreshAuth('/api/chat/turns', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(input),
    });
    if (!response.ok || !response.body) {
      if (response.status < 500) receivedTerminalEvent = true;
      const body = await response.json().catch(() => undefined);
      throw new ApiError(
        response.status,
        typeof body?.error === 'string'
          ? body.error
          : 'The thread could not start. Please try again.',
        body,
      );
    }
    receivedTerminalEvent =
      (await consumeEventStream<ChatEvent>(
        response,
        (event) => {
          if (event.type === 'done' || event.type === 'error') receivedTerminalEvent = true;
          onEvent(event);
        },
        (event) => event.type === 'done' || event.type === 'error',
        signal,
        'The response was interrupted. Please try again.',
      )) || receivedTerminalEvent;
  } finally {
    // The Worker may outlive a broken connection. Release its database turn
    // before the caller unlocks the composer, including failed regeneration.
    if (!receivedTerminalEvent && !signal.aborted) {
      await api.cancelTurn(input.requestId).catch(() => undefined);
    }
  }
}

export async function streamNoteProposal(
  messageId: string,
  input: MessageFollowupRequest,
  onEvent: (event: NoteProposalEvent) => void,
  signal: AbortSignal,
) {
  const response = await fetchWithFreshAuth(`/api/chat/messages/${messageId}/note-proposal`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(input),
  });
  if (!response.ok || !response.body)
    await streamError(response, 'The note suggestion could not start. Please try again.');
  await consumeEventStream(
    response,
    onEvent,
    (event) => event.type === 'done' || event.type === 'error',
    signal,
    'The response was interrupted. Please try again.',
  );
}

export async function streamMessageAnnotations(
  messageId: string,
  input: MessageFollowupRequest,
  onEvent: (event: AnnotationEvent) => void,
  signal: AbortSignal,
) {
  const response = await fetchWithFreshAuth(
    `/api/chat/messages/${messageId}/annotations?stream=1`,
    {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(input),
    },
  );
  if (!response.ok || !response.body)
    throw new ApiError(response.status, 'Highlights could not be added.');
  await consumeEventStream(
    response,
    onEvent,
    (event) => event.type === 'done',
    signal,
    'Highlights were interrupted. Please try again.',
    (event) => {
      if (event.type === 'error') throw new Error(event.message);
    },
  );
}

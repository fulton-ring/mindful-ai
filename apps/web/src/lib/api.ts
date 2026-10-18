import type {
  AnnotationEvent,
  ChatRequest,
  Conversation,
  ConversationSummary,
  EditProposal,
  MessageBudget,
  MessageFollowupRequest,
  MessageHighlight,
  Note,
  NoteDecision,
  NoteProposalEvent,
  NoteState,
  Persona,
  ProvenanceSpan,
  TurnStart,
  Usage,
  WaldenUIMessage,
} from '@walden/contracts';

import { checkIdentityFailure, identityRequestScope } from './account-identity';

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

async function identityChecked(response: Response): Promise<Response> {
  if (response.status === 409)
    checkIdentityFailure(
      await response
        .clone()
        .json()
        .catch(() => undefined),
    );
  return response;
}
async function fetchWithFreshAuth(path: string, init?: RequestInit): Promise<Response> {
  // Capture before awaiting tokens: old requests must never inherit a new account.
  const scope = identityRequestScope(init?.signal ?? undefined);
  const provider = tokenProvider;
  const firstToken = await provider?.();
  scope.signal.throwIfAborted();
  const headers = new Headers(init?.headers);
  if (!(init?.body instanceof FormData) && !headers.has('content-type'))
    headers.set('content-type', 'application/json');
  if (scope.accountId) headers.set('X-Walden-Account-Id', scope.accountId);
  if (firstToken) headers.set('authorization', `Bearer ${firstToken}`);
  const response = await identityChecked(
    await fetch(path, { ...init, headers, signal: scope.signal }),
  );
  if (response.ok) scope.signal.throwIfAborted();
  if (response.status !== 401 || !firstToken || !provider) return response;
  const refreshedToken = await provider({ skipCache: true });
  scope.signal.throwIfAborted();
  if (!refreshedToken || refreshedToken === firstToken) return response;
  const retryHeaders = new Headers(headers);
  retryHeaders.set('authorization', `Bearer ${refreshedToken}`);
  return identityChecked(
    await fetch(path, { ...init, headers: retryHeaders, signal: scope.signal }),
  );
}

function sendWithProgress(
  url: string,
  file: File | FormData,
  method: 'PUT' | 'POST',
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  onProgress: (percent: number) => void,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Upload cancelled.', 'AbortError'));
      return;
    }
    const request = new XMLHttpRequest();
    request.open(method, url);
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable)
        onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    };
    request.onload = () => {
      let body: unknown;
      try {
        body = JSON.parse(request.responseText);
      } catch {
        body = undefined;
      }
      resolve({ status: request.status, body });
    };
    request.onerror = () => reject(new Error('Could not upload file.'));
    request.onabort = () => reject(new DOMException('Upload cancelled.', 'AbortError'));
    signal?.addEventListener('abort', () => request.abort(), { once: true });
    request.send(file);
  });
}

type UploadProgress = (percent: number) => void;
export type AttachmentMetadata = { id: string; name: string; mimeType: string; size: number };

async function uploadPresigned(
  base: string,
  intent: { id: string; uploadUrl: string; headers?: Record<string, string> },
  file: File,
  signal?: AbortSignal,
  onProgress?: UploadProgress,
): Promise<AttachmentMetadata> {
  const uploaded = onProgress
    ? await sendWithProgress(
        intent.uploadUrl,
        file,
        'PUT',
        intent.headers ?? {},
        signal,
        onProgress,
      )
    : await fetch(intent.uploadUrl, { method: 'PUT', headers: intent.headers, body: file, signal });
  if (uploaded.status < 200 || uploaded.status >= 300)
    throw new ApiError(uploaded.status, 'Could not upload file to storage.');
  const completed = await fetchWithFreshAuth(base + path`/${intent.id}/complete`, {
    method: 'POST',
    body: JSON.stringify({ name: file.name }),
    signal,
  });
  const metadata = await completed.json().catch(() => undefined);
  if (!completed.ok)
    throw new ApiError(completed.status, metadata?.error ?? 'Could not verify uploaded file.');
  onProgress?.(100);
  return metadata as AttachmentMetadata;
}

async function uploadLocal(
  base: string,
  file: File,
  signal?: AbortSignal,
  onProgress?: UploadProgress,
): Promise<AttachmentMetadata> {
  const scope = identityRequestScope(signal);
  const provider = tokenProvider;
  signal = scope.signal;
  const accountHeaders: Record<string, string> = scope.accountId
    ? { 'X-Walden-Account-Id': scope.accountId }
    : {};
  const form = new FormData();
  form.set('file', file);
  const token = await provider?.();
  signal.throwIfAborted();
  let response = onProgress
    ? await sendWithProgress(
        base,
        form,
        'POST',
        { ...accountHeaders, ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal,
        onProgress,
      )
    : await fetchWithFreshAuth(base, { method: 'POST', body: form, signal });
  if (response.status === 401 && onProgress && token && provider) {
    const refreshed = await provider({ skipCache: true });
    signal.throwIfAborted();
    if (refreshed && refreshed !== token)
      response = await sendWithProgress(
        base,
        form,
        'POST',
        { ...accountHeaders, authorization: `Bearer ${refreshed}` },
        signal,
        onProgress,
      );
  }
  const body =
    response instanceof Response
      ? await response.json().catch(() => undefined)
      : (response.body as { error?: string } | undefined);
  checkIdentityFailure(body);
  if (response.status >= 200 && response.status < 300) signal.throwIfAborted();
  if (response.status < 200 || response.status >= 300)
    throw new ApiError(response.status, body?.error ?? 'Could not upload file.');
  onProgress?.(100);
  return body as AttachmentMetadata;
}

export async function uploadAttachment(
  conversationId: string,
  file: File,
  signal?: AbortSignal,
  onProgress?: (percent: number) => void,
) {
  const base = path`/api/chat/attachments/${conversationId}`;
  const initiation = await fetchWithFreshAuth(`${base}/initiate`, {
    method: 'POST',
    body: JSON.stringify({ name: file.name, mimeType: file.type, size: file.size }),
    signal,
  });
  const intent = await initiation.json().catch(() => undefined);
  if (!initiation.ok)
    throw new ApiError(initiation.status, intent?.error ?? 'Could not prepare file upload.');
  if (intent?.mode === 'presigned') return uploadPresigned(base, intent, file, signal, onProgress);
  if (intent?.mode !== 'local') throw new ApiError(503, 'File uploads are unavailable.');
  return uploadLocal(base, file, signal, onProgress);
}

/** Downloads an attachment by its `file` part URL, an owner-only API path. */
export async function fetchAttachment(url: string, signal?: AbortSignal) {
  const response = await fetchWithFreshAuth(url, { signal });
  if (!response.ok) throw new ApiError(response.status, 'Could not open this file.');
  return response.blob();
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const scope = identityRequestScope(init?.signal ?? undefined);
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
  scope.signal.throwIfAborted();
  return ((body as { data?: T } | undefined)?.data ?? body) as T;
}

export type SseFrame = { id?: string; data: string };

function parseSseFrame(frame: string): SseFrame | null {
  const lines = frame.split(/\r?\n/);
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data) return null;
  const id = lines
    .find((line) => line.startsWith('id:'))
    ?.slice(3)
    .trim();
  return { id, data };
}

// Yields each server-sent event frame. Aborting the signal cancels the body, which ends
// the iteration; a transport failure while reading also ends it rather than throwing, so
// callers decide whether a stream that closed without a terminal event is an error.
export async function* readSseFrames(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<SseFrame> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        return;
      }
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const parsed = parseSseFrame(frame);
        if (parsed) yield parsed;
      }
    }
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function consumeEventStream<T>(
  response: Response,
  onEvent: (event: T) => void,
  isTerminal: (event: T) => boolean,
  signal: AbortSignal,
  interruptionMessage: string,
) {
  for await (const frame of readSseFrames(response, signal)) {
    if (frame.data === '[DONE]') return;
    const event = JSON.parse(frame.data) as T;
    onEvent(event);
    if (isTerminal(event)) return;
  }
  signal.throwIfAborted();
  throw new Error(interruptionMessage);
}

/** Encodes every interpolated value as a URI component: path`/api/notes/${id}`. */
function path(strings: TemplateStringsArray, ...segments: Array<string | number>) {
  return strings.reduce(
    (url, part, index) =>
      url + part + (index < segments.length ? encodeURIComponent(segments[index]!) : ''),
    '',
  );
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
    request<{ webSearchEnabled: boolean }>(path`/api/conversations/${conversationId}/web-search`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
  setLearningChecks: (conversationId: string, enabled: boolean) =>
    request<{ learningChecksEnabled: boolean }>(
      path`/api/conversations/${conversationId}/learning-checks`,
      { method: 'PATCH', body: JSON.stringify({ enabled }) },
    ),
  notes: () => request<Note[]>('/api/notes'),
  noteState: (id: string) => request<NoteState>(path`/api/notes/${id}/state`),
  renameNote: (id: string, title: string) =>
    request<{ title: string }>(path`/api/notes/${id}/title`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  saveNote: (
    note: Note,
    operationId: string,
    markdown: string,
    provenance: ProvenanceSpan[],
    dismissSuggestionIds?: string[],
  ) =>
    request<Note | { revision: number; operationId: string }>(path`/api/notes/${note.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        operationId,
        baseRevision: note.revision,
        markdown,
        provenance,
        ...(dismissSuggestionIds?.length ? { dismissSuggestionIds } : {}),
      }),
    }),
  deleteNote: (id: string) => request<void>(path`/api/notes/${id}`, { method: 'DELETE' }),
  decideSuggestion: (
    noteId: string,
    suggestionId: string,
    decision: NoteDecision['decision'],
    baseRevision: number,
    operationId: string,
    markdown?: string,
  ) =>
    request<NoteState>(path`/api/notes/${noteId}/suggestions/${suggestionId}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision, baseRevision, operationId, markdown }),
    }),
  noteHistory: (id: string, action: 'undo' | 'redo', baseRevision: number, operationId: string) =>
    request<NoteState>(path`/api/notes/${id}/${action}`, {
      method: 'POST',
      body: JSON.stringify({ baseRevision, operationId }),
    }),
  startConversation: (noteId?: string) =>
    request<Conversation>(
      noteId ? path`/api/notes/${noteId}/conversations` : '/api/conversations',
      {
        method: 'POST',
        body: '{}',
      },
    ),
  captureFirstNote: (
    conversationId: string,
    text: string,
    verbatim: boolean,
    operationId: string,
  ) =>
    request<{ conversation: Conversation; note: Note }>(
      path`/api/conversations/${conversationId}/capture`,
      { method: 'POST', body: JSON.stringify({ text, verbatim, operationId }) },
    ),
  capturePlacement: (
    conversationId: string,
    text: string,
    noteRevision: number | null,
    signal?: AbortSignal,
  ) =>
    request<{ proposal: EditProposal | null }>(
      path`/api/conversations/${conversationId}/capture-placement`,
      { method: 'POST', body: JSON.stringify({ text, noteRevision }), signal },
    ),
  conversation: (id: string, branchId?: string | null) =>
    request<Conversation>(
      path`/api/conversations/${id}` + (branchId ? path`?branch=${branchId}` : ''),
    ),
  conversations: (query?: string) =>
    request<ConversationSummary[]>(
      query ? path`/api/conversations?q=${query}` : '/api/conversations',
    ),
  renameConversation: (id: string, title: string) =>
    request<Conversation>(path`/api/conversations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  deleteConversation: (id: string) =>
    request<void>(path`/api/conversations/${id}`, { method: 'DELETE' }),
  archiveConversation: (id: string) =>
    request<void>(path`/api/conversations/${id}?keepNote=1`, { method: 'DELETE' }),
  cancelNoteProposal: (
    messageId: string,
    input: { conversationId: string; branchId: string; attemptId: string },
  ) =>
    request<{ cancelledSuggestionIds: string[]; noteState: NoteState | null }>(
      path`/api/chat/messages/${messageId}/note-proposal/cancel`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
  saveHighlight: (messageId: string, highlight: MessageHighlight) =>
    request<MessageHighlight>(path`/api/chat/messages/${messageId}/highlights`, {
      method: 'PUT',
      body: JSON.stringify(highlight),
    }),
  activeTurn: (conversationId: string, branchId: string) =>
    request<{
      turn: {
        id: string;
        requestId: string;
        conversationId: string;
        branchId: string;
        userMessageId: string | null;
        userMessage?: WaldenUIMessage;
        regenerateMessageId?: string;
        editMessageId?: string;
      } | null;
    }>(path`/api/chat/turns?conversationId=${conversationId}&branchId=${branchId}`),
  startTurn: (input: ChatRequest, signal?: AbortSignal) =>
    request<TurnStart>('/api/chat/turns', {
      method: 'POST',
      signal,
      body: JSON.stringify(input),
    }),
  /**
   * The turn's UI message stream after event `after`, or null (204) when the turn has ended
   * and nothing follows the cursor. The server may end a live stream early.
   */
  turnEvents: async (turnId: string, after: number, signal?: AbortSignal) => {
    const response = await fetchWithFreshAuth(
      path`/api/chat/turns/${turnId}/events?after=${after}`,
      { signal, headers: { accept: 'text/event-stream', 'X-Walden-Turn-Protocol': '2' } },
    );
    if (response.status === 204) return null;
    if (!response.ok || !response.body)
      await streamError(response, 'The response could not be loaded.');
    return response;
  },
  /** Accepts the turn id, or the request id while the turn is still being admitted. */
  cancelTurn: (id: string) =>
    request<{ cancelled: boolean }>(path`/api/chat/turns/${id}/cancel`, {
      method: 'POST',
      body: '{}',
    }),
  personas: () => request<Persona[]>('/api/personas'),
  createPersona: (value: Omit<Persona, 'id'> & { replacesPersonaId?: string }) =>
    request<Persona>('/api/personas', { method: 'POST', body: JSON.stringify(value) }),
  updatePersona: (value: Persona) =>
    request<Persona>(path`/api/personas/${value.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...value, model: value.model ?? null }),
    }),
  deletePersona: (id: string) => request<void>(path`/api/personas/${id}`, { method: 'DELETE' }),
  usage: () => request<Usage>('/api/usage'),
  budget: () => request<MessageBudget>('/api/budget'),
};

export async function streamNoteProposal(
  messageId: string,
  input: MessageFollowupRequest,
  onEvent: (event: NoteProposalEvent) => void,
  signal: AbortSignal,
) {
  const response = await fetchWithFreshAuth(path`/api/chat/messages/${messageId}/note-proposal`, {
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
    path`/api/chat/messages/${messageId}/annotations?stream=1`,
    {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(input),
    },
  );
  if (!response.ok || !response.body)
    throw new ApiError(response.status, 'Highlights could not be added.');
  await consumeEventStream<AnnotationEvent>(
    response,
    (event) => {
      onEvent(event);
      if (event.type === 'error') throw new Error(event.message);
    },
    (event) => event.type === 'done',
    signal,
    'Highlights were interrupted. Please try again.',
  );
}

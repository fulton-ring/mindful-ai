import {
  attachmentUrl,
  type ChatRequest,
  type LearningCheckResponse,
  type WaldenUIMessage,
} from '@walden/contracts';

import { api } from '../../../../../lib/api';
import { id } from '../../../../../lib/ids';
import { filePartsOf, messageText } from '../../../message-parts';
import type { UploadedFile } from '../actions/use-chat-uploads';
import type { LiveTurn } from '../state/use-chat-runtime-state';
import type { TurnArgs } from './turn-args';

type Parts = WaldenUIMessage['parts'];

function uploadedPart(file: UploadedFile): Parts[number] {
  return {
    type: 'file',
    mediaType: file.mimeType,
    filename: file.name,
    url: attachmentUrl(file.conversationId, file.id),
  };
}

function clearForTurn(args: TurnArgs, files: File[], status: string) {
  const { display } = args;
  args.followups.resetAnnotationRetries();
  display.setInput('');
  display.setAttachments([]);
  args.uploads.clearSent(files);
  display.setStatus(status);
  display.setError('');
  display.setRecentAnimation(null);
  if (display.recentAnimationTimeout.current !== undefined) {
    window.clearTimeout(display.recentAnimationTimeout.current);
    display.recentAnimationTimeout.current = undefined;
  }
}

function startLive(
  args: TurnArgs,
  turn: Omit<LiveTurn, 'snapshot' | 'startedAt' | 'noteRevision'>,
) {
  args.runtime.followingResponse.current = true;
  args.runtime.live.current = {
    ...turn,
    noteRevision: null,
    snapshot: args.chat.messages,
    startedAt: performance.now(),
  };
}

/** Sends the composer (or `message`), optionally as an edit of `editMessageId`. */
export function send(
  args: TurnArgs,
  message = args.display.input,
  action: ChatRequest['action'] = 'message',
  editMessageId?: string,
  learningCheckResponse?: LearningCheckResponse,
) {
  const clean = message.trim();
  const files = editMessageId ? [] : args.display.attachments;
  const uploaded = args.uploads.uploaded(files);
  const edited = args.chat.messages.find(({ id }) => id === editMessageId);
  if (
    (!clean && !files.length && !editMessageId) ||
    (clean.length > 2000 && !editMessageId) ||
    (editMessageId && !edited) ||
    args.runtime.live.current ||
    args.display.savingChatPreference ||
    !uploaded
  )
    return;
  const requestId = id('turn');
  startLive(args, { kind: 'send', requestId, action, draft: { text: clean, files, uploaded } });
  clearForTurn(args, files, 'Thinking…');
  const parts: Parts = [
    ...(edited ? filePartsOf(edited) : uploaded.map(uploadedPart)),
    ...(clean ? [{ type: 'text' as const, text: clean }] : []),
    ...(learningCheckResponse
      ? [{ type: 'data-learning-check-response' as const, data: learningCheckResponse }]
      : []),
  ];
  void args.chat.sendMessage(
    {
      parts,
      metadata: { createdAt: new Date().toISOString() },
      ...(editMessageId ? { messageId: editMessageId } : {}),
    },
    { body: { requestId, action, personaId: args.effectivePersonaId } },
  );
}

/** Regenerates an assistant reply on a new branch; the SDK shows only the fork prefix meanwhile. */
export function regenerate(args: TurnArgs, message: WaldenUIMessage) {
  const { chat, runtime } = args;
  const index = chat.messages.findIndex(({ id }) => id === message.id);
  if (runtime.live.current || index < 1 || chat.messages[index - 1]?.role !== 'user') return;
  runtime.proposalAbort.current?.abort();
  runtime.annotationControllers.current.get(message.id)?.abort();
  runtime.annotationControllers.current.delete(message.id);
  const requestId = id('turn');
  startLive(args, { kind: 'regenerate', requestId, action: 'message' });
  args.display.setStatus('Regenerating…');
  args.display.setError('');
  void chat.regenerate({
    messageId: message.id,
    body: { requestId, personaId: args.effectivePersonaId },
  });
}

/** Retries an interrupted reply by resending the question before it. */
export function retryIncomplete(args: TurnArgs, message: WaldenUIMessage) {
  const messages = args.chat.messages;
  const index = messages.findIndex((item) => item.id === message.id);
  const priorUser = index > 0 ? messages[index - 1] : undefined;
  if (priorUser?.role !== 'user') {
    args.display.setError('The original message is no longer available to retry.');
    return;
  }
  send(args, messageText(priorUser), 'message', priorUser.id);
}

/** Stop is durable: the server turn is cancelled, then the local stream detaches. */
export function stop(args: TurnArgs) {
  const { runtime } = args;
  const live = runtime.live.current;
  const target = live?.turnId ?? live?.requestId;
  if (target)
    runtime.pendingTurnCancellation.current = api.cancelTurn(target).catch(() => undefined);
  runtime.abortReason.current = 'stop';
  void args.chat.stop();
  runtime.proposalAbort.current?.abort();
  args.followups.resetAnnotationRetries();
}

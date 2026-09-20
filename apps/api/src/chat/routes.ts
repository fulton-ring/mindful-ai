import {
  type ChatEvent,
  type Conversation,
  chatRequestSchema,
  DEFAULT_PERSONAS,
  type Intervention,
  type Message,
  type MessageSource,
  type Note,
  type Persona,
  type ProvenanceSpan,
  type ToolActivity,
} from '@walden/contracts';
import { conversationTitle } from '@walden/domain';
import { Hono } from 'hono';
import { all, first, parseJson } from '../db/client';
import { HttpError, jsonBody, newId, nowIso } from '../http';
import { createAgentService } from '../services/agent';
import { aiProviderErrorMessage } from '../services/ai-errors';
import type { Bindings, Variables } from '../types';
import { abortActiveTurn, registerActiveTurn, removeActiveTurn } from './active-turns';
import { agentHighlightStatements } from './agent-highlights';
import { loadConversation, RETENTION_MS } from './conversations';

const ORPHANED_TURN_AFTER_MS = 90_000;
const encoder = new TextEncoder();
const sse = (event: ChatEvent) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
export const NEXT_USER_SEQUENCE_SQL =
  "SELECT COALESCE(MAX(sequence + CASE WHEN role='user' THEN 1 ELSE 0 END),0)+1 AS sequence FROM messages WHERE conversation_id=?";
export const REGENERATE_ASSISTANT_SQL =
  "UPDATE messages SET id=?,turn_id=?,content=?,reasoning=?,activity_json=?,incomplete=0,created_at=? WHERE id=? AND conversation_id=? AND owner_id=? AND role='assistant' AND incomplete=0 AND sequence=(SELECT MAX(sequence) FROM messages WHERE conversation_id=? AND owner_id=?)";

export function regenerationContext(messages: Conversation['messages'], assistantId: string) {
  const assistantIndex = messages.findIndex(({ id }) => id === assistantId);
  const assistant = messages[assistantIndex];
  const user = messages[assistantIndex - 1];
  if (
    !assistant ||
    assistant.id !== assistantId ||
    assistant.role !== 'assistant' ||
    assistant.incomplete ||
    !user ||
    user.role !== 'user'
  )
    return null;
  return { assistant, user, history: messages.slice(0, assistantIndex - 1) };
}

export function editContext(messages: Conversation['messages'], userId: string) {
  const userIndex = messages.findIndex(({ id }) => id === userId);
  const user = messages[userIndex];
  if (!user || user.role !== 'user') return null;
  return {
    user,
    history: messages.slice(0, userIndex),
    replacedAssistant:
      messages[userIndex + 1]?.role === 'assistant' ? messages[userIndex + 1] : null,
  };
}

export function turnReplayDisposition(
  status: string,
  createdAt: string,
  now = Date.now(),
): 'active' | 'recover' | 'replay' | 'blocked' {
  if (status === 'streaming') {
    const age = now - Date.parse(createdAt);
    return Number.isFinite(age) && age > ORPHANED_TURN_AFTER_MS ? 'recover' : 'active';
  }
  if (status === 'completed' || status === 'cancelled') return 'replay';
  return 'blocked';
}

export function conversationStreamingDisposition(
  createdAt: string,
  now = Date.now(),
): 'active' | 'recover' {
  const disposition = turnReplayDisposition('streaming', createdAt, now);
  return disposition === 'recover' ? 'recover' : 'active';
}

export async function personaFor(db: D1Database, ownerId: string, id: string): Promise<Persona> {
  const builtin = id
    ? DEFAULT_PERSONAS.find((persona) => persona.id === id)
    : DEFAULT_PERSONAS.find((persona) => persona.id === 'thinking-partner');
  if (builtin) return builtin;
  const row = await first<Persona>(
    db
      .prepare(
        'SELECT id,name,prompt,brevity,challenge,tone,revision FROM personas WHERE id=? AND owner_id=?',
      )
      .bind(id, ownerId),
  );
  if (!row) throw new HttpError(404, 'Persona not found');
  return row;
}

export function createDurableStream(
  run: (output: ReadableStreamDefaultController<Uint8Array>) => Promise<void>,
  cancel: () => void,
  waitUntil: (task: Promise<void>) => void,
) {
  return new ReadableStream<Uint8Array>({
    start(output) {
      const lifecycle = run(output);
      waitUntil(lifecycle);
    },
    cancel,
  });
}

export async function batchIfAny(db: D1Database, statements: D1PreparedStatement[]) {
  if (statements.length > 0) await db.batch(statements);
}

export const chatRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();
chatRoutes.post('/turns', async (c) => {
  const parsed = chatRequestSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new HttpError(400, 'Invalid chat request', parsed.error.flatten());
  const ownerId = c.get('userId');
  let conversation = await loadConversation(c.env.DB, ownerId, parsed.data.conversationId, {
    renewExpired: !parsed.data.regenerateMessageId,
    branchId: parsed.data.branchId,
  });
  const regeneration = parsed.data.regenerateMessageId
    ? regenerationContext(conversation.messages, parsed.data.regenerateMessageId)
    : null;
  const edit = parsed.data.editMessageId
    ? editContext(conversation.messages, parsed.data.editMessageId)
    : null;
  if (parsed.data.regenerateMessageId && parsed.data.editMessageId)
    throw new HttpError(400, 'Choose either a message edit or regeneration');
  const previous = await first<{
    id: string;
    status: string;
    created_at: string;
    branch_id: string;
  }>(
    c.env.DB.prepare(
      'SELECT id,status,created_at,branch_id FROM turns WHERE owner_id=? AND request_id=?',
    ).bind(ownerId, parsed.data.requestId),
  );
  const noteRow =
    conversation.noteId === null
      ? null
      : await first<{
          id: string;
          markdown: string;
          revision: number;
          provenance_json: string;
          created_at: string;
          updated_at: string;
        }>(
          c.env.DB.prepare(
            'SELECT id,markdown,revision,provenance_json,created_at,updated_at FROM notes WHERE id=? AND owner_id=?',
          ).bind(conversation.noteId, ownerId),
        );
  if (!previous && conversation.noteId !== null && !noteRow)
    throw new HttpError(404, 'Note not found');
  if (!previous && conversation.noteId === null && parsed.data.noteRevision !== null)
    throw new HttpError(409, 'Note revision conflict', { currentRevision: null });
  if (!previous && noteRow && noteRow.revision !== parsed.data.noteRevision)
    throw new HttpError(409, 'Note revision conflict', { currentRevision: noteRow.revision });
  let requestMessage = parsed.data.message;
  if (regeneration) {
    requestMessage = regeneration.user.content;
    conversation.messages = regeneration.history;
  } else if (edit) {
    conversation.messages = edit.history;
  }
  let recoveredUserMessage: { id: string; sequence: number } | null = null;
  if (previous) {
    const disposition = turnReplayDisposition(previous.status, previous.created_at);
    if (disposition === 'active' || disposition === 'blocked')
      throw new HttpError(409, 'Turn already in progress');
    if (disposition === 'recover') {
      abortActiveTurn(previous.id, 'generation deadline exceeded');
      const recoveredAt = nowIso();
      const userMessage = await first<{
        id: string;
        content: string;
        sequence: number;
      }>(
        c.env.DB.prepare(
          "SELECT id,content,sequence FROM messages WHERE turn_id=? AND owner_id=? AND role='user' ORDER BY sequence LIMIT 1",
        ).bind(previous.id, ownerId),
      );
      await c.env.DB.batch([
        c.env.DB.prepare(
          "UPDATE turns SET status='failed',completed_at=?,request_id=request_id || ':orphaned:' || id WHERE id=? AND owner_id=? AND status='streaming'",
        ).bind(recoveredAt, previous.id, ownerId),
        c.env.DB.prepare(
          "UPDATE interventions SET status='invalidated' WHERE turn_id=? AND owner_id=? AND status='pending'",
        ).bind(previous.id, ownerId),
      ]);
      conversation = await loadConversation(c.env.DB, ownerId, parsed.data.conversationId, {
        renewExpired: !parsed.data.regenerateMessageId,
        branchId: previous.branch_id,
      });
      if (userMessage) {
        recoveredUserMessage = { id: userMessage.id, sequence: userMessage.sequence };
        requestMessage = userMessage.content;
        conversation.messages = conversation.messages.filter(
          (message) => message.id !== userMessage.id,
        );
      }
    } else {
      const message = await first<{
        id: string;
        content: string;
        reasoning: string | null;
        created_at: string;
        incomplete: number;
        activity_json: string;
      }>(
        c.env.DB.prepare(
          "SELECT id,content,reasoning,created_at,incomplete,activity_json FROM messages WHERE turn_id=? AND owner_id=? AND role='assistant'",
        ).bind(previous.id, ownerId),
      );
      const event: ChatEvent = message
        ? (() => {
            const activity = parseJson<{
              tools?: ToolActivity[];
              sources?: MessageSource[];
              contextCompacted?: boolean;
            }>(message.activity_json, {});
            return {
              type: 'done',
              message: {
                id: message.id,
                role: 'assistant',
                content: message.content,
                ...(message.reasoning ? { reasoning: message.reasoning } : {}),
                createdAt: message.created_at,
                ...(activity.tools?.length ? { tools: activity.tools } : {}),
                ...(activity.sources?.length ? { sources: activity.sources } : {}),
                ...(activity.contextCompacted ? { contextCompacted: true } : {}),
                incomplete: Boolean(message.incomplete),
              },
              conversationId: conversation.id,
              branchId: previous.branch_id,
              title: conversation.title,
              expiresAt: conversation.expiresAt,
            };
          })()
        : { type: 'error', message: 'The previous turn did not produce a response.' };
      return new Response(sse(event), {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      });
    }
  }
  if (parsed.data.regenerateMessageId && !regeneration)
    throw new HttpError(409, 'Completed response not found on this branch');
  if (parsed.data.editMessageId && !edit) throw new HttpError(404, 'Message to edit was not found');
  const conversationStreaming = await first<{ id: string; created_at: string }>(
    c.env.DB.prepare(
      "SELECT id,created_at FROM turns WHERE branch_id=? AND owner_id=? AND status='streaming' LIMIT 1",
    ).bind(conversation.branchId, ownerId),
  );
  if (conversationStreaming) {
    const disposition = conversationStreamingDisposition(conversationStreaming.created_at);
    if (disposition === 'active')
      throw new HttpError(409, 'A turn is already in progress for this conversation');
    abortActiveTurn(conversationStreaming.id, 'generation deadline exceeded');
    const recoveredAt = nowIso();
    const recovered = await c.env.DB.prepare(
      "UPDATE turns SET status='failed',completed_at=? WHERE id=? AND owner_id=? AND status='streaming' AND created_at=?",
    )
      .bind(recoveredAt, conversationStreaming.id, ownerId, conversationStreaming.created_at)
      .run();
    if (recovered.meta.changes === 1) {
      await c.env.DB.prepare(
        "UPDATE interventions SET status='invalidated' WHERE turn_id=? AND owner_id=? AND status='pending'",
      )
        .bind(conversationStreaming.id, ownerId)
        .run();
    }
  }
  const persona = await personaFor(c.env.DB, ownerId, parsed.data.personaId);
  const pendingRow = await first<{ payload_json: string }>(
    c.env.DB.prepare(
      "SELECT payload_json FROM interventions WHERE branch_id=? AND owner_id=? AND status='pending' AND kind!='ghost' ORDER BY created_at DESC LIMIT 1",
    ).bind(conversation.branchId, ownerId),
  );
  const pendingIntervention = pendingRow
    ? parseJson<Intervention | undefined>(pendingRow.payload_json, undefined)
    : undefined;
  const turnId = newId();
  // An interrupted answer has no useful alternate path to preserve. Reuse its branch;
  // completed exchanges retain their history as a sibling branch, like ChatGPT/Claude edits.
  const editInPlace = Boolean(edit?.replacedAssistant?.incomplete);
  const branchFork = regeneration ?? (editInPlace ? null : edit);
  const branchId = branchFork ? newId() : conversation.branchId;
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + RETENTION_MS).toISOString();
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  await c.env.DB.prepare(
    "INSERT INTO usage_periods (owner_id,plan,used,unit_limit,resets_at,input_tokens,output_tokens) VALUES (?,'free',0,10,?,0,0) ON CONFLICT(owner_id) DO NOTHING",
  )
    .bind(ownerId, tomorrow.toISOString())
    .run();
  await c.env.DB.prepare(
    "UPDATE usage_periods SET used=0,resets_at=? WHERE owner_id=? AND plan='free' AND resets_at<=?",
  )
    .bind(tomorrow.toISOString(), ownerId, createdAt)
    .run();
  if (branchFork)
    await c.env.DB.prepare(
      `INSERT INTO conversation_branches
       (id,conversation_id,owner_id,head_message_id,forked_from_message_id,is_default,status,last_user_activity_at,expires_at,created_at)
       VALUES (?,?,?,?,?,0,'active',?,?,?)`,
    )
      .bind(
        branchId,
        conversation.id,
        ownerId,
        regeneration ? regeneration.user.id : (conversation.messages.at(-1)?.id ?? null),
        regeneration
          ? regeneration.assistant.id
          : (edit?.replacedAssistant?.id ?? edit?.user.id ?? null),
        createdAt,
        expiresAt,
        createdAt,
      )
      .run();
  try {
    await c.env.DB.prepare(
      "INSERT INTO turns (id,request_id,conversation_id,owner_id,status,created_at,branch_id) VALUES (?,?,?,?, 'streaming',?,?)",
    )
      .bind(turnId, parsed.data.requestId, conversation.id, ownerId, createdAt, branchId)
      .run();
  } catch {
    if (branchFork)
      await c.env.DB.prepare("UPDATE conversation_branches SET status='expired' WHERE id=?")
        .bind(branchId)
        .run();
    throw new HttpError(409, 'A turn is already in progress for this conversation');
  }
  await c.env.DB.prepare('UPDATE usage_periods SET used=used+1 WHERE owner_id=?')
    .bind(ownerId)
    .run();
  const userMessageId =
    regeneration?.user.id ?? (editInPlace ? edit!.user.id : recoveredUserMessage?.id) ?? newId();
  const userMessageStatement = regeneration
    ? null
    : editInPlace
      ? c.env.DB.prepare(
          "UPDATE messages SET content=?,turn_id=?,created_at=? WHERE id=? AND owner_id=? AND role='user'",
        ).bind(requestMessage, turnId, createdAt, edit!.user.id, ownerId)
      : recoveredUserMessage
        ? c.env.DB.prepare('UPDATE messages SET turn_id=? WHERE id=? AND owner_id=?').bind(
            turnId,
            recoveredUserMessage.id,
            ownerId,
          )
        : c.env.DB.prepare(
            "INSERT INTO messages (id,conversation_id,turn_id,owner_id,role,content,sequence,created_at,parent_message_id,origin_branch_id) VALUES (?,?,?,?, 'user',?,(SELECT COALESCE(MAX(sequence),0)+1 FROM messages WHERE conversation_id=?),?,?,?)",
          ).bind(
            userMessageId,
            conversation.id,
            turnId,
            ownerId,
            requestMessage,
            conversation.id,
            createdAt,
            conversation.messages.at(-1)?.id ?? null,
            branchId,
          );
  // A new user message advances the conversation, which expires any note
  // proposal the user left undecided. Without this a ghost stays pending in the
  // note across every later turn until it is explicitly accepted or rejected.
  const advancesConversation = !regeneration && !editInPlace && !recoveredUserMessage;
  await batchIfAny(c.env.DB, [
    ...(editInPlace && edit?.replacedAssistant
      ? [
          c.env.DB.prepare(
            "DELETE FROM messages WHERE id=? AND owner_id=? AND role='assistant' AND incomplete=1",
          ).bind(edit.replacedAssistant.id, ownerId),
        ]
      : []),
    ...(advancesConversation
      ? [
          c.env.DB.prepare(
            "UPDATE note_suggestions SET status='invalidated',updated_at=? WHERE owner_id=? AND conversation_id=? AND status='pending'",
          ).bind(createdAt, ownerId, conversation.id),
        ]
      : []),
    ...(userMessageStatement ? [userMessageStatement] : []),
    ...[
      c.env.DB.prepare(
        "UPDATE conversations SET persona_id=?,persona_snapshot_json=?,last_user_activity_at=?,expires_at=?,learning_checks_enabled=?,title=CASE WHEN title IN ('New conversation','New thread') THEN ? ELSE title END WHERE id=? AND owner_id=?",
      ).bind(
        persona.id,
        JSON.stringify(persona),
        createdAt,
        expiresAt,
        parsed.data.action === 'stop_checks' ? 0 : conversation.learningChecksEnabled ? 1 : 0,
        conversationTitle(requestMessage),
        conversation.id,
        ownerId,
      ),
      c.env.DB.prepare(
        "UPDATE conversation_branches SET last_user_activity_at=?,expires_at=? WHERE conversation_id=? AND owner_id=? AND status='active'",
      ).bind(createdAt, expiresAt, conversation.id, ownerId),
    ],
  ]);
  conversation.expiresAt = expiresAt;
  if (
    !regeneration &&
    (conversation.title === 'New conversation' || conversation.title === 'New thread')
  )
    conversation.title = conversationTitle(requestMessage);
  const note: Note | null = noteRow
    ? {
        id: noteRow.id,
        title: conversation.title,
        markdown: noteRow.markdown,
        revision: noteRow.revision,
        provenance: parseJson<ProvenanceSpan[]>(noteRow.provenance_json, []),
        createdAt: noteRow.created_at,
        updatedAt: noteRow.updated_at,
      }
    : null;
  const controller = new AbortController();
  registerActiveTurn(turnId, conversation.id, controller);
  const cancelFromRequest = () => controller.abort('client disconnected');
  if (c.req.raw.signal.aborted) cancelFromRequest();
  else c.req.raw.signal.addEventListener('abort', cancelFromRequest, { once: true });
  const agent = createAgentService(c.env, (task) => c.executionCtx.waitUntil(task));
  const turnConversation: Conversation = { ...conversation, branchId };
  const stream = createDurableStream(
    async (output) => {
      let assistantText = '';
      let assistantReasoning = '';
      let doneEvent: Extract<ChatEvent, { type: 'done' }> | undefined;
      const annotations: Extract<ChatEvent, { type: 'annotation' }>['annotation'][] = [];
      const tools = new Map<string, ToolActivity>();
      const sources = new Map<string, MessageSource>();
      let contextCompacted = false;
      let inputTokens = 0;
      let outputTokens = 0;
      let emitted = false;
      const emit = (event: ChatEvent) => {
        try {
          output.enqueue(sse(event));
          emitted = true;
        } catch {
          controller.abort('client disconnected');
        }
      };
      try {
        if (controller.signal.aborted) throw new Error('Turn cancelled');
        const events = await agent.streamTurn(
          {
            ownerId,
            telemetryUserId: c.get('authSubject'),
            turnId,
            requestId: parsed.data.requestId,
            conversation: turnConversation,
            note,
            persona,
            message: requestMessage,
            action: parsed.data.action,
            pendingIntervention: branchFork ? undefined : pendingIntervention,
          },
          controller.signal,
        );
        for await (const event of events) {
          const state = await first<{ status: string }>(
            c.env.DB.prepare('SELECT status FROM turns WHERE id=? AND owner_id=?').bind(
              turnId,
              ownerId,
            ),
          );
          if (!state || state.status !== 'streaming') {
            controller.abort('cancelled or expired');
            throw new Error('Turn cancelled');
          }
          if (event.type === 'text') assistantText += event.text;
          if (event.type === 'reasoning') assistantReasoning += event.text;
          if (event.type === 'done') doneEvent = event;
          if (event.type === 'annotation') annotations.push(event.annotation);
          if (event.type === 'tool') tools.set(event.tool.id, event.tool);
          if (event.type === 'source') sources.set(event.source.url, event.source);
          if (event.type === 'context-compacted') contextCompacted = true;
          if (event.type === 'usage') {
            inputTokens = event.usage.inputTokens;
            outputTokens = event.usage.outputTokens;
          }
          if (event.type === 'intervention') {
            await c.env.DB.prepare(
              "UPDATE interventions SET status='superseded' WHERE branch_id=? AND owner_id=? AND status='pending'",
            )
              .bind(branchId, ownerId)
              .run();
            await c.env.DB.prepare(
              "INSERT INTO interventions (id,conversation_id,turn_id,owner_id,kind,payload_json,status,created_at,branch_id) VALUES (?,?,?,?,?,?,'pending',?,?)",
            )
              .bind(
                event.intervention.id,
                conversation.id,
                turnId,
                ownerId,
                event.intervention.kind,
                JSON.stringify(event.intervention),
                nowIso(),
                branchId,
              )
              .run();
          }
          if (event.type !== 'done') emit(event);
        }
        const generatedMessage = doneEvent?.message ?? {
          id: newId(),
          role: 'assistant' as const,
          content: assistantText,
          ...(assistantReasoning ? { reasoning: assistantReasoning } : {}),
          createdAt: nowIso(),
        };
        const message = generatedMessage;
        const activityJson = JSON.stringify({
          tools: message.tools ?? [...tools.values()],
          sources: message.sources ?? [...sources.values()],
          contextCompacted: message.contextCompacted ?? contextCompacted,
        });
        const liveConversation = await first<{ id: string }>(
          c.env.DB.prepare(
            "SELECT id FROM conversations WHERE id=? AND owner_id=? AND status='active' AND expires_at>?",
          ).bind(conversation.id, ownerId, nowIso()),
        );
        if (!liveConversation) throw new Error('Conversation expired');
        if (controller.signal.aborted) throw new Error('Turn cancelled');
        const completionResults = await c.env.DB.batch([
          c.env.DB.prepare(
            `INSERT INTO messages (id,conversation_id,turn_id,owner_id,role,content,reasoning,activity_json,incomplete,sequence,created_at,parent_message_id,origin_branch_id,persona_name)
             SELECT ?,?,?,?,'assistant',?,?,?,0,(SELECT COALESCE(MAX(sequence),0)+1 FROM messages WHERE conversation_id=?),?,?,?,? WHERE EXISTS (
               SELECT 1 FROM turns t JOIN conversation_branches b ON b.id=t.branch_id AND b.owner_id=t.owner_id
               WHERE t.id=? AND t.owner_id=? AND t.status='streaming' AND b.id=? AND b.status='active' AND b.expires_at>?
             )`,
          ).bind(
            message.id,
            conversation.id,
            turnId,
            ownerId,
            message.content,
            message.reasoning ?? null,
            activityJson,
            conversation.id,
            message.createdAt,
            userMessageId,
            branchId,
            persona.name,
            turnId,
            ownerId,
            branchId,
            nowIso(),
          ),
          c.env.DB.prepare(
            "UPDATE turns SET status='completed',completed_at=? WHERE id=? AND owner_id=? AND branch_id=? AND status='streaming' AND EXISTS (SELECT 1 FROM messages WHERE id=? AND turn_id=? AND owner_id=?)",
          ).bind(nowIso(), turnId, ownerId, branchId, message.id, turnId, ownerId),
          c.env.DB.prepare(
            "UPDATE conversation_branches SET head_message_id=? WHERE id=? AND owner_id=? AND status='active' AND EXISTS (SELECT 1 FROM turns WHERE id=? AND owner_id=? AND status='completed')",
          ).bind(message.id, branchId, ownerId, turnId, ownerId),
          c.env.DB.prepare(
            'UPDATE turns SET input_tokens=?,output_tokens=? WHERE id=? AND owner_id=?',
          ).bind(inputTokens, outputTokens, turnId, ownerId),
          c.env.DB.prepare(
            'UPDATE usage_periods SET input_tokens=input_tokens+?,output_tokens=output_tokens+? WHERE owner_id=?',
          ).bind(inputTokens, outputTokens, ownerId),
          ...agentHighlightStatements(c.env.DB, {
            messageId: message.id,
            ownerId,
            content: message.content,
            annotations: message.annotations ?? annotations,
            updatedAt: message.createdAt,
          }),
        ]);
        if (
          completionResults[0]?.meta.changes !== 1 ||
          completionResults[1]?.meta.changes !== 1 ||
          completionResults[2]?.meta.changes !== 1
        )
          throw new Error('Response changed during regeneration');
        if (controller.signal.aborted) throw new Error('Turn cancelled');
        emit({
          type: 'done',
          message: {
            ...message,
            annotations: message.annotations ?? annotations,
            ...(contextCompacted ? { contextCompacted: true } : {}),
          },
          conversationId: conversation.id,
          branchId,
          title: conversation.title,
          expiresAt,
          ...(doneEvent?.annotationsHandled !== undefined
            ? { annotationsHandled: doneEvent.annotationsHandled }
            : {}),
        });
      } catch (error) {
        const cancelled = controller.signal.aborted;
        const partialMessageId = newId();
        const partialCreatedAt = nowIso();
        const partialActivity = {
          tools: [...tools.values()].map((tool) =>
            tool.state === 'running'
              ? { ...tool, state: 'error' as const, summary: 'Stopped' }
              : tool,
          ),
          sources: [...sources.values()],
          contextCompacted,
        };
        const partialMessage: Message = {
          id: partialMessageId,
          role: 'assistant',
          content: assistantText,
          ...(assistantReasoning ? { reasoning: assistantReasoning } : {}),
          ...(partialActivity.tools.length ? { tools: partialActivity.tools } : {}),
          ...(partialActivity.sources.length ? { sources: partialActivity.sources } : {}),
          ...(contextCompacted ? { contextCompacted: true } : {}),
          incomplete: true,
          createdAt: partialCreatedAt,
        };
        let partialPersisted = false;
        const exists = await first<{ id: string }>(
          c.env.DB.prepare(
            "SELECT id FROM conversations WHERE id=? AND owner_id=? AND status='active' AND expires_at>?",
          ).bind(conversation.id, ownerId, nowIso()),
        );
        if (exists) {
          const failureResults = await c.env.DB.batch([
            ...(!branchFork
              ? [
                  c.env.DB.prepare(
                    "INSERT OR IGNORE INTO messages (id,conversation_id,turn_id,owner_id,role,content,reasoning,activity_json,incomplete,sequence,created_at,parent_message_id,origin_branch_id) VALUES (?,?,?,?, 'assistant',?,?,?,1,(SELECT COALESCE(MAX(sequence),0)+1 FROM messages WHERE conversation_id=?),?,?,?)",
                  ).bind(
                    partialMessageId,
                    conversation.id,
                    turnId,
                    ownerId,
                    assistantText,
                    assistantReasoning || null,
                    JSON.stringify(partialActivity),
                    conversation.id,
                    partialCreatedAt,
                    userMessageId,
                    branchId,
                  ),
                ]
              : []),
            ...(!branchFork
              ? [
                  c.env.DB.prepare(
                    "UPDATE conversation_branches SET head_message_id=? WHERE id=? AND owner_id=? AND status='active' AND EXISTS (SELECT 1 FROM messages WHERE id=? AND owner_id=? AND incomplete=1)",
                  ).bind(partialMessageId, branchId, ownerId, partialMessageId, ownerId),
                ]
              : []),
            ...(branchFork
              ? [
                  c.env.DB.prepare(
                    "UPDATE conversation_branches SET status='expired',head_message_id=? WHERE id=? AND owner_id=? AND is_default=0",
                  ).bind(userMessageId, branchId, ownerId),
                ]
              : []),
            c.env.DB.prepare(
              "UPDATE turns SET status=?,completed_at=? WHERE id=? AND owner_id=? AND status='streaming'",
            ).bind(cancelled ? 'cancelled' : 'failed', nowIso(), turnId, ownerId),
            ...(cancelled
              ? [
                  c.env.DB.prepare(
                    "UPDATE turns SET status='cancelled',completed_at=? WHERE id=? AND owner_id=? AND status='completed'",
                  ).bind(nowIso(), turnId, ownerId),
                  c.env.DB.prepare(
                    "UPDATE messages SET incomplete=1 WHERE turn_id=? AND owner_id=? AND role='assistant'",
                  ).bind(turnId, ownerId),
                ]
              : []),
          ]);
          partialPersisted = !branchFork && failureResults[0]?.meta.changes === 1;
        }
        if (!emitted)
          await c.env.DB.prepare('UPDATE usage_periods SET used=MAX(0,used-1) WHERE owner_id=?')
            .bind(ownerId)
            .run();
        emit({
          type: 'error',
          message: cancelled
            ? 'Turn cancelled'
            : (aiProviderErrorMessage(error) ??
              (error instanceof Error ? error.message : 'Turn failed')),
          ...(!cancelled && partialPersisted ? { partialMessage } : {}),
        });
      } finally {
        c.req.raw.signal.removeEventListener('abort', cancelFromRequest);
        removeActiveTurn(turnId);
        try {
          output.close();
        } catch {
          /* response was already cancelled */
        }
      }
    },
    cancelFromRequest,
    (task) => c.executionCtx.waitUntil(task),
  );
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
});

chatRoutes.post('/turns/:id/cancel', async (c) => {
  const row = await first<{ id: string; status: string }>(
    c.env.DB.prepare(
      'SELECT id,status FROM turns WHERE (id=? OR request_id=?) AND owner_id=? ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1',
    ).bind(c.req.param('id'), c.req.param('id'), c.get('userId'), c.req.param('id')),
  );
  if (!row) throw new HttpError(404, 'Turn not found');
  abortActiveTurn(row.id, 'cancelled');
  if (row.status === 'streaming')
    await c.env.DB.prepare(
      "UPDATE turns SET status='cancelled',completed_at=? WHERE id=? AND owner_id=?",
    )
      .bind(nowIso(), row.id, c.get('userId'))
      .run();
  return c.json({ cancelled: true });
});

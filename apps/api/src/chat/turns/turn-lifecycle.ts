import {
  type ChatEvent,
  type ChatRequest,
  type Conversation,
  type Intervention,
  type Message,
  type MessageSource,
  type Note,
  type Persona,
  type ProvenanceSpan,
  type ToolActivity,
} from '@walden/contracts';
import { conversationTitle } from '@walden/domain';
import { first, parseJson } from '../../db/client';
import { HttpError, newId, nowIso } from '../../http';
import { loadConversation, RETENTION_MS } from '../conversations/conversations';
import { abortActiveTurn } from './active-turns';
import {
  batchIfAny,
  conversationStreamingDisposition,
  editContext,
  type NoteRow,
  type PreviousTurn,
  personaFor,
  type ReplayMessage,
  regenerationContext,
  turnReplayDisposition,
} from './turn-support';

export type TurnRuntime = {
  db: D1Database;
  ownerId: string;
};

type Regeneration = NonNullable<ReturnType<typeof regenerationContext>>;
type Edit = NonNullable<ReturnType<typeof editContext>>;

type TurnRecords = {
  conversation: Conversation;
  regeneration: Regeneration | null;
  edit: Edit | null;
  previous: PreviousTurn | null;
  noteRow: NoteRow | null;
};

type RecoveredUserMessage = { id: string; sequence: number };

type TurnInput = {
  request: ChatRequest;
  conversation: Conversation;
  regeneration: Regeneration | null;
  edit: Edit | null;
  previous: PreviousTurn | null;
  noteRow: NoteRow | null;
  requestMessage: string;
  recoveredUserMessage: RecoveredUserMessage | null;
  pendingRow?: { id: string; payload_json: string };
};

export type PreparedTurn = {
  turnId: string;
  branchId: string;
  branchFork: boolean;
  userMessageId: string;
  conversation: Conversation;
  note: Note | null;
  persona: Persona;
  requestMessage: string;
  request: ChatRequest;
  pendingIntervention: Intervention | undefined;
};

export type PreparedTurnResult =
  | { kind: 'replay'; event: ChatEvent }
  | { kind: 'stream'; turn: PreparedTurn };

async function loadTurnRecords(runtime: TurnRuntime, request: ChatRequest): Promise<TurnRecords> {
  const { db, ownerId } = runtime;
  const conversation = await loadConversation(db, ownerId, request.conversationId, {
    renewExpired: !request.regenerateMessageId,
    branchId: request.branchId,
  });
  const regeneration = request.regenerateMessageId
    ? regenerationContext(conversation.messages, request.regenerateMessageId)
    : null;
  const edit = request.editMessageId
    ? editContext(conversation.messages, request.editMessageId)
    : null;
  if (request.regenerateMessageId && request.editMessageId)
    throw new HttpError(400, 'Choose either a message edit or regeneration');
  const previous = await first<PreviousTurn>(
    db
      .prepare('SELECT id,status,created_at,branch_id FROM turns WHERE owner_id=? AND request_id=?')
      .bind(ownerId, request.requestId),
  );
  const noteRow = await loadNoteRow(db, ownerId, conversation.noteId);
  validateNoteRevision(request, conversation, previous, noteRow);
  return { conversation, regeneration, edit, previous, noteRow };
}

async function loadNoteRow(
  db: D1Database,
  ownerId: string,
  noteId: string | null,
): Promise<NoteRow | null> {
  if (noteId === null) return null;
  return first<NoteRow>(
    db
      .prepare(
        'SELECT id,markdown,revision,provenance_json,created_at,updated_at FROM notes WHERE id=? AND owner_id=?',
      )
      .bind(noteId, ownerId),
  );
}

function validateNoteRevision(
  request: ChatRequest,
  conversation: Conversation,
  previous: PreviousTurn | null,
  noteRow: NoteRow | null,
) {
  if (!previous && conversation.noteId !== null && !noteRow)
    throw new HttpError(404, 'Note not found');
  if (!previous && conversation.noteId === null && request.noteRevision !== null)
    throw new HttpError(409, 'Note revision conflict', { currentRevision: null });
  if (!previous && noteRow && noteRow.revision !== request.noteRevision)
    throw new HttpError(409, 'Note revision conflict', { currentRevision: noteRow.revision });
}

async function replayPreviousTurn(
  runtime: TurnRuntime,
  previous: PreviousTurn,
  conversation: Conversation,
): Promise<ChatEvent> {
  const message = await first<ReplayMessage>(
    runtime.db
      .prepare(
        "SELECT id,content,reasoning,created_at,incomplete,activity_json FROM messages WHERE turn_id=? AND owner_id=? AND role='assistant'",
      )
      .bind(previous.id, runtime.ownerId),
  );
  if (!message) return { type: 'error', message: 'The previous turn did not produce a response.' };
  const activity = parseJson<{
    tools?: ToolActivity[];
    sources?: MessageSource[];
    contextCompacted?: boolean;
    learningCheck?: Message['learningCheck'];
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
      ...(activity.learningCheck ? { learningCheck: activity.learningCheck } : {}),
      incomplete: Boolean(message.incomplete),
    },
    conversationId: conversation.id,
    branchId: previous.branch_id,
    title: conversation.title,
    expiresAt: conversation.expiresAt,
  };
}

async function recoverPreviousTurn(
  runtime: TurnRuntime,
  request: ChatRequest,
  state: TurnRecords,
  disposition: ReturnType<typeof turnReplayDisposition>,
): Promise<{
  conversation: Conversation;
  requestMessage: string;
  recoveredUserMessage: RecoveredUserMessage | null;
}> {
  const { db, ownerId } = runtime;
  const previous = state.previous;
  if (!previous)
    return {
      conversation: state.conversation,
      requestMessage: request.message,
      recoveredUserMessage: null,
    };
  if (disposition === 'active' || disposition === 'blocked')
    throw new HttpError(409, 'Turn already in progress');
  if (disposition === 'replay')
    throw new Error('replay should be handled before previous-turn recovery');
  abortActiveTurn(previous.id, 'generation deadline exceeded');
  const recoveredAt = nowIso();
  const userMessage = await first<{ id: string; content: string; sequence: number }>(
    db
      .prepare(
        "SELECT id,content,sequence FROM messages WHERE turn_id=? AND owner_id=? AND role='user' ORDER BY sequence LIMIT 1",
      )
      .bind(previous.id, ownerId),
  );
  await db.batch([
    db
      .prepare(
        "UPDATE turns SET status='failed',completed_at=?,request_id=request_id || ':orphaned:' || id WHERE id=? AND owner_id=? AND status='streaming'",
      )
      .bind(recoveredAt, previous.id, ownerId),
    db
      .prepare(
        "UPDATE interventions SET status='invalidated' WHERE turn_id=? AND owner_id=? AND status='pending'",
      )
      .bind(previous.id, ownerId),
  ]);
  const conversation = await loadConversation(db, ownerId, request.conversationId, {
    renewExpired: !request.regenerateMessageId,
    branchId: previous.branch_id,
  });
  if (!userMessage)
    return { conversation, requestMessage: request.message, recoveredUserMessage: null };
  conversation.messages = conversation.messages.filter(({ id }) => id !== userMessage.id);
  return {
    conversation,
    requestMessage: userMessage.content,
    recoveredUserMessage: { id: userMessage.id, sequence: userMessage.sequence },
  };
}

async function recoverStreamingTurn(runtime: TurnRuntime, conversation: Conversation) {
  const { db, ownerId } = runtime;
  const streaming = await first<{ id: string; created_at: string }>(
    db
      .prepare(
        "SELECT id,created_at FROM turns WHERE branch_id=? AND owner_id=? AND status='streaming' LIMIT 1",
      )
      .bind(conversation.branchId, ownerId),
  );
  if (!streaming) return;
  const disposition = conversationStreamingDisposition(streaming.created_at);
  if (disposition === 'active')
    throw new HttpError(409, 'A turn is already in progress for this conversation');
  abortActiveTurn(streaming.id, 'generation deadline exceeded');
  const recoveredAt = nowIso();
  const recovered = await db
    .prepare(
      "UPDATE turns SET status='failed',completed_at=? WHERE id=? AND owner_id=? AND status='streaming' AND created_at=?",
    )
    .bind(recoveredAt, streaming.id, ownerId, streaming.created_at)
    .run();
  if (recovered.meta.changes !== 1) return;
  await db
    .prepare(
      "UPDATE interventions SET status='invalidated' WHERE turn_id=? AND owner_id=? AND status='pending'",
    )
    .bind(streaming.id, ownerId)
    .run();
}

function validateLearningCheck(
  request: ChatRequest,
  pendingIntervention: Intervention | undefined,
) {
  const response = request.learningCheckResponse;
  if (!response) return;
  const questionIds = new Set(
    pendingIntervention?.kind === 'learning_check'
      ? pendingIntervention.questions.map(({ id }) => id)
      : [],
  );
  const invalid =
    pendingIntervention?.kind !== 'learning_check' ||
    response.checkId !== pendingIntervention.id ||
    Object.keys(response.answers).some((id) => !questionIds.has(id));
  if (invalid) throw new HttpError(409, 'This learning check is no longer pending');
}

async function reserveTurn(runtime: TurnRuntime, input: TurnInput, persona: Persona) {
  const { db, ownerId } = runtime;
  const editInPlace = Boolean(input.edit?.replacedAssistant?.incomplete);
  const branchFork = Boolean(input.regeneration || (input.edit && !editInPlace));
  const branchId = branchFork ? newId() : input.conversation.branchId;
  const turnId = newId();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + RETENTION_MS).toISOString();
  await initializeUsagePeriod(db, ownerId, createdAt);
  if (branchFork) await createBranch(db, input, branchId, ownerId, createdAt, expiresAt);
  try {
    await db
      .prepare(
        "INSERT INTO turns (id,request_id,conversation_id,owner_id,status,created_at,branch_id) VALUES (?,?,?,?, 'streaming',?,?)",
      )
      .bind(turnId, input.request.requestId, input.conversation.id, ownerId, createdAt, branchId)
      .run();
  } catch {
    if (branchFork)
      await db
        .prepare("UPDATE conversation_branches SET status='expired' WHERE id=?")
        .bind(branchId)
        .run();
    throw new HttpError(409, 'A turn is already in progress for this conversation');
  }
  await db.prepare('UPDATE usage_periods SET used=used+1 WHERE owner_id=?').bind(ownerId).run();
  return { branchId, branchFork, turnId, createdAt, expiresAt, editInPlace, persona };
}

async function initializeUsagePeriod(db: D1Database, ownerId: string, createdAt: string) {
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  await db
    .prepare(
      "INSERT INTO usage_periods (owner_id,plan,used,unit_limit,resets_at,input_tokens,output_tokens) VALUES (?,'free',0,10,?,0,0) ON CONFLICT(owner_id) DO NOTHING",
    )
    .bind(ownerId, tomorrow.toISOString())
    .run();
  await db
    .prepare(
      "UPDATE usage_periods SET used=0,resets_at=? WHERE owner_id=? AND plan='free' AND resets_at<=?",
    )
    .bind(tomorrow.toISOString(), ownerId, createdAt)
    .run();
}

async function createBranch(
  db: D1Database,
  input: TurnInput,
  branchId: string,
  ownerId: string,
  createdAt: string,
  expiresAt: string,
) {
  await db
    .prepare(
      `INSERT INTO conversation_branches
       (id,conversation_id,owner_id,head_message_id,forked_from_message_id,is_default,status,last_user_activity_at,expires_at,created_at)
       VALUES (?,?,?,?,?,0,'active',?,?,?)`,
    )
    .bind(
      branchId,
      input.conversation.id,
      ownerId,
      input.regeneration
        ? input.regeneration.user.id
        : (input.conversation.messages.at(-1)?.id ?? null),
      input.regeneration
        ? input.regeneration.assistant.id
        : (input.edit?.replacedAssistant?.id ?? input.edit?.user.id ?? null),
      createdAt,
      expiresAt,
      createdAt,
    )
    .run();
}

function userMessageStatement(
  runtime: TurnRuntime,
  input: TurnInput,
  reservation: Awaited<ReturnType<typeof reserveTurn>>,
  userMessageId: string,
) {
  const { db } = runtime;
  if (input.regeneration) return null;
  if (reservation.editInPlace)
    return db
      .prepare(
        "UPDATE messages SET content=?,turn_id=?,created_at=? WHERE id=? AND owner_id=? AND role='user'",
      )
      .bind(
        input.requestMessage,
        reservation.turnId,
        reservation.createdAt,
        input.edit!.user.id,
        runtime.ownerId,
      );
  if (input.recoveredUserMessage)
    return db
      .prepare('UPDATE messages SET turn_id=? WHERE id=? AND owner_id=?')
      .bind(reservation.turnId, input.recoveredUserMessage.id, runtime.ownerId);
  return db
    .prepare(
      "INSERT INTO messages (id,conversation_id,turn_id,owner_id,role,content,activity_json,sequence,created_at,parent_message_id,origin_branch_id) VALUES (?,?,?,?, 'user',?,?,(SELECT COALESCE(MAX(sequence),0)+1 FROM messages WHERE conversation_id=?),?,?,?)",
    )
    .bind(
      userMessageId,
      input.conversation.id,
      reservation.turnId,
      runtime.ownerId,
      input.requestMessage,
      JSON.stringify(
        input.request.learningCheckResponse
          ? { learningCheckResponse: input.request.learningCheckResponse }
          : {},
      ),
      input.conversation.id,
      reservation.createdAt,
      input.conversation.messages.at(-1)?.id ?? null,
      reservation.branchId,
    );
}

function turnSetupStatements(
  runtime: TurnRuntime,
  input: TurnInput,
  reservation: Awaited<ReturnType<typeof reserveTurn>>,
  persona: Persona,
  userMessageStatementValue: D1PreparedStatement | null,
) {
  const { db, ownerId } = runtime;
  const advances = !input.regeneration && !reservation.editInPlace && !input.recoveredUserMessage;
  return [
    ...(reservation.editInPlace && input.edit?.replacedAssistant
      ? [
          db
            .prepare(
              "DELETE FROM messages WHERE id=? AND owner_id=? AND role='assistant' AND incomplete=1",
            )
            .bind(input.edit.replacedAssistant.id, ownerId),
        ]
      : []),
    ...(advances
      ? [
          db
            .prepare(
              "UPDATE note_suggestions SET status='invalidated',updated_at=? WHERE owner_id=? AND conversation_id=? AND status='pending'",
            )
            .bind(reservation.createdAt, ownerId, input.conversation.id),
        ]
      : []),
    ...(input.pendingRow && advances
      ? [
          db
            .prepare(
              "UPDATE interventions SET status='resolved' WHERE id=? AND owner_id=? AND status='pending'",
            )
            .bind(input.pendingRow.id, ownerId),
        ]
      : []),
    ...(userMessageStatementValue ? [userMessageStatementValue] : []),
    db
      .prepare(
        "UPDATE conversations SET persona_id=?,persona_snapshot_json=?,last_user_activity_at=?,expires_at=?,learning_checks_enabled=?,title=CASE WHEN title IN ('New conversation','New thread') THEN ? ELSE title END WHERE id=? AND owner_id=?",
      )
      .bind(
        persona.id,
        JSON.stringify(persona),
        reservation.createdAt,
        reservation.expiresAt,
        input.request.action === 'stop_checks'
          ? 0
          : input.conversation.learningChecksEnabled
            ? 1
            : 0,
        conversationTitle(input.requestMessage),
        input.conversation.id,
        ownerId,
      ),
    db
      .prepare(
        "UPDATE conversation_branches SET last_user_activity_at=?,expires_at=? WHERE conversation_id=? AND owner_id=? AND status='active'",
      )
      .bind(reservation.createdAt, reservation.expiresAt, input.conversation.id, ownerId),
  ];
}

async function persistTurnSetup(
  runtime: TurnRuntime,
  input: TurnInput,
  reservation: Awaited<ReturnType<typeof reserveTurn>>,
  persona: Persona,
) {
  const userMessageId =
    input.regeneration?.user.id ??
    (reservation.editInPlace ? input.edit!.user.id : input.recoveredUserMessage?.id) ??
    newId();
  const statement = userMessageStatement(runtime, input, reservation, userMessageId);
  await batchIfAny(
    runtime.db,
    turnSetupStatements(runtime, input, reservation, persona, statement),
  );
  return userMessageId;
}

async function prepareStreamTurn(
  runtime: TurnRuntime,
  input: TurnInput,
  persona: Persona,
  pendingIntervention: Intervention | undefined,
): Promise<PreparedTurn> {
  const reservation = await reserveTurn(runtime, input, persona);
  const userMessageId = await persistTurnSetup(runtime, input, reservation, persona);
  input.conversation.expiresAt = reservation.expiresAt;
  if (
    !input.regeneration &&
    (input.conversation.title === 'New conversation' || input.conversation.title === 'New thread')
  )
    input.conversation.title = conversationTitle(input.requestMessage);
  const note = input.noteRow
    ? {
        id: input.noteRow.id,
        title: input.conversation.title,
        markdown: input.noteRow.markdown,
        revision: input.noteRow.revision,
        provenance: parseJson<ProvenanceSpan[]>(input.noteRow.provenance_json, []),
        createdAt: input.noteRow.created_at,
        updatedAt: input.noteRow.updated_at,
      }
    : null;
  return {
    turnId: reservation.turnId,
    branchId: reservation.branchId,
    branchFork: reservation.branchFork,
    userMessageId,
    conversation: { ...input.conversation, branchId: reservation.branchId },
    note,
    persona,
    requestMessage: input.requestMessage,
    request: input.request,
    pendingIntervention: reservation.branchFork ? undefined : pendingIntervention,
  };
}

export async function prepareTurn(
  runtime: TurnRuntime,
  request: ChatRequest,
): Promise<PreparedTurnResult> {
  const records = await loadTurnRecords(runtime, request);
  let conversation = records.conversation;
  let requestMessage = request.message;
  let recoveredUserMessage: RecoveredUserMessage | null = null;
  if (records.regeneration) {
    requestMessage = records.regeneration.user.content;
    conversation.messages = records.regeneration.history;
  } else if (records.edit) {
    conversation.messages = records.edit.history;
  }
  if (records.previous) {
    const disposition = turnReplayDisposition(records.previous.status, records.previous.created_at);
    if (disposition === 'replay')
      return {
        kind: 'replay',
        event: await replayPreviousTurn(runtime, records.previous, conversation),
      };
    const recovered = await recoverPreviousTurn(
      runtime,
      request,
      { ...records, conversation },
      disposition,
    );
    conversation = recovered.conversation;
    requestMessage = recovered.requestMessage;
    recoveredUserMessage = recovered.recoveredUserMessage;
    records.previous = null;
  }
  if (request.regenerateMessageId && !records.regeneration)
    throw new HttpError(409, 'Completed response not found on this branch');
  if (request.editMessageId && !records.edit)
    throw new HttpError(404, 'Message to edit was not found');
  await recoverStreamingTurn(runtime, conversation);
  const persona = await personaFor(runtime.db, runtime.ownerId, request.personaId);
  const pendingRow = await first<{ id: string; payload_json: string }>(
    runtime.db
      .prepare(
        "SELECT id,payload_json FROM interventions WHERE branch_id=? AND owner_id=? AND status='pending' AND kind!='ghost' ORDER BY created_at DESC LIMIT 1",
      )
      .bind(conversation.branchId, runtime.ownerId),
  );
  const pendingIntervention = pendingRow
    ? parseJson<Intervention | undefined>(pendingRow.payload_json, undefined)
    : undefined;
  validateLearningCheck(request, pendingIntervention);
  const input: TurnInput = {
    request,
    conversation,
    regeneration: records.regeneration,
    edit: records.edit,
    previous: records.previous,
    noteRow: records.noteRow,
    requestMessage,
    recoveredUserMessage,
    pendingRow: pendingRow ?? undefined,
  };
  return {
    kind: 'stream',
    turn: await prepareStreamTurn(runtime, input, persona, pendingIntervention),
  };
}

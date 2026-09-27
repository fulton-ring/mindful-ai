import {
  type ChatRequest,
  type Conversation,
  type Intervention,
  modelWeight,
  type Note,
  type Persona,
  type ProvenanceSpan,
} from '@walden/contracts';
import { conversationTitle } from '@walden/domain';
import { first, parseJson } from '../../db/client';
import { HttpError, newId, nowIso } from '../../http';
import type { LoadedAttachment } from '../attachments/attachments';
import { loadConversation, RETENTION_MS } from '../conversations/repository';
import { chargeMessage, type MessageLimit, refundMessage } from './message-limit';
import {
  batchIfAny,
  editContext,
  type NoteRow,
  type PreviousTurn,
  personaFor,
  regenerationContext,
  turnReplayDisposition,
} from './turn-support';

export type TurnRuntime = {
  db: D1Database;
  ownerId: string;
  /** Omitted only by tests that exercise admission without a message budget. */
  messageLimit?: MessageLimit;
  /** Resolves the model a persona will run on; defaults to the persona's own model. */
  modelFor?: (persona: Persona) => string;
};

type TurnModel = { model: string | null; weight: number };

type Regeneration = NonNullable<ReturnType<typeof regenerationContext>>;
type Edit = NonNullable<ReturnType<typeof editContext>>;

type TurnRecords = {
  conversation: Conversation;
  regeneration: Regeneration | null;
  edit: Edit | null;
  previous: PreviousTurn | null;
  noteRow: NoteRow | null;
};

type TurnInput = {
  request: ChatRequest;
  attachments: LoadedAttachment[];
  conversation: Conversation;
  regeneration: Regeneration | null;
  edit: Edit | null;
  previous: PreviousTurn | null;
  noteRow: NoteRow | null;
  requestMessage: string;
  pendingRow?: { id: string; payload_json: string };
};

export type PreparedTurn = {
  turnId: string;
  branchId: string;
  sourceBranchId: string;
  branchFork: boolean;
  userMessageId: string;
  conversation: Conversation;
  note: Note | null;
  persona: Persona;
  requestMessage: string;
  attachments?: LoadedAttachment[];
  request: ChatRequest;
  pendingIntervention: Intervention | undefined;
};

type PreparedTurnResult = { kind: 'replay' } | { kind: 'stream'; turn: PreparedTurn };

async function loadTurnRecords(runtime: TurnRuntime, request: ChatRequest): Promise<TurnRecords> {
  const { db, ownerId } = runtime;
  const [conversation, previous] = await Promise.all([
    loadConversation(db, ownerId, request.conversationId, {
      renewExpired: !request.regenerateMessageId,
      branchId: request.branchId,
    }),
    first<PreviousTurn>(
      db
        .prepare(
          'SELECT id,status,created_at,branch_id FROM turns WHERE owner_id=? AND request_id=?',
        )
        .bind(ownerId, request.requestId),
    ),
  ]);
  const regeneration = request.regenerateMessageId
    ? regenerationContext(conversation.messages, request.regenerateMessageId)
    : null;
  const edit = request.editMessageId
    ? editContext(conversation.messages, request.editMessageId)
    : null;
  if (request.regenerateMessageId && request.editMessageId)
    throw new HttpError(400, 'Choose either a message edit or regeneration');
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

async function rejectOverlappingTurn(runtime: TurnRuntime, conversation: Conversation) {
  const streaming = await first(
    runtime.db
      .prepare(
        "SELECT id FROM turns WHERE branch_id=? AND owner_id=? AND status='streaming' LIMIT 1",
      )
      .bind(conversation.branchId, runtime.ownerId),
  );
  if (streaming) throw new HttpError(409, 'A turn is already in progress for this conversation');
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

async function reserveTurn(
  runtime: TurnRuntime,
  input: TurnInput,
  persona: Persona,
  turnModel: TurnModel,
) {
  const { db, ownerId } = runtime;
  const editInPlace = Boolean(input.edit?.replacedAssistant?.incomplete);
  const branchFork = Boolean(input.regeneration || (input.edit && !editInPlace));
  const branchId = branchFork ? newId() : input.conversation.branchId;
  const turnId = newId();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + RETENTION_MS).toISOString();
  if (branchFork) await createBranch(db, input, branchId, ownerId, createdAt);
  try {
    await db
      .prepare(
        "INSERT INTO turns (id,request_id,conversation_id,owner_id,status,created_at,branch_id,source_branch_id,request_json,model,weight) VALUES (?,?,?,?, 'streaming',?,?,?,?,?,?)",
      )
      .bind(
        turnId,
        input.request.requestId,
        input.conversation.id,
        ownerId,
        createdAt,
        branchId,
        input.conversation.branchId,
        JSON.stringify(input.request),
        turnModel.model,
        turnModel.weight,
      )
      .run();
  } catch {
    if (branchFork)
      await db
        .prepare("UPDATE conversation_branches SET status='expired' WHERE id=?")
        .bind(branchId)
        .run();
    throw new HttpError(409, 'A turn is already in progress for this conversation');
  }
  return { branchId, branchFork, turnId, createdAt, expiresAt, editInPlace, persona };
}

async function createBranch(
  db: D1Database,
  input: TurnInput,
  branchId: string,
  ownerId: string,
  createdAt: string,
) {
  await db
    .prepare(
      `INSERT INTO conversation_branches
       (id,conversation_id,owner_id,head_message_id,forked_from_message_id,is_default,status,created_at)
       VALUES (?,?,?,?,?,0,'active',?)`,
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
  return db
    .prepare(
      "INSERT INTO messages (id,conversation_id,turn_id,owner_id,role,content,activity_json,created_at,parent_message_id,origin_branch_id) VALUES (?,?,?,?, 'user',?,?,?,?,?)",
    )
    .bind(
      userMessageId,
      input.conversation.id,
      reservation.turnId,
      runtime.ownerId,
      input.requestMessage,
      JSON.stringify({
        ...(input.request.learningCheckResponse
          ? { learningCheckResponse: input.request.learningCheckResponse }
          : {}),
        ...(input.attachments.length
          ? {
              attachments: input.attachments.map(({ id, name, mimeType, size }) => ({
                id,
                name,
                mimeType,
                size,
              })),
            }
          : {}),
      }),
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
  const advances = !input.regeneration && !reservation.editInPlace;
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
        "UPDATE conversations SET persona_id=?,last_user_activity_at=?,expires_at=?,learning_checks_enabled=?,title=CASE WHEN title IN ('New conversation','New thread') THEN ? ELSE title END WHERE id=? AND owner_id=?",
      )
      .bind(
        persona.id,
        reservation.createdAt,
        reservation.expiresAt,
        input.request.action === 'stop_checks'
          ? 0
          : input.conversation.learningChecksEnabled
            ? 1
            : 0,
        conversationTitle(input.requestMessage || input.attachments[0]?.name || 'New thread'),
        input.conversation.id,
        ownerId,
      ),
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
    (reservation.editInPlace ? input.edit!.user.id : undefined) ??
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
  turnModel: TurnModel,
): Promise<PreparedTurn> {
  const reservation = await reserveTurn(runtime, input, persona, turnModel);
  const userMessageId = await persistTurnSetup(runtime, input, reservation, persona);
  input.conversation.expiresAt = reservation.expiresAt;
  if (
    !input.regeneration &&
    (input.conversation.title === 'New conversation' || input.conversation.title === 'New thread')
  )
    input.conversation.title = conversationTitle(
      input.requestMessage || input.attachments[0]?.name || 'New thread',
    );
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
    sourceBranchId: input.conversation.branchId,
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
  attachments: LoadedAttachment[] = [],
): Promise<PreparedTurnResult> {
  const records = await loadTurnRecords(runtime, request);
  const conversation = records.conversation;
  let requestMessage = request.message;
  if (records.regeneration) {
    requestMessage = records.regeneration.user.content;
    conversation.messages = records.regeneration.history;
  } else if (records.edit) {
    conversation.messages = records.edit.history;
  }
  if (records.previous) {
    const disposition = turnReplayDisposition(records.previous.status);
    if (disposition === 'replay') return { kind: 'replay' };
    throw new HttpError(409, 'This request already has a turn.');
  }
  if (request.regenerateMessageId && !records.regeneration)
    throw new HttpError(409, 'Completed response not found on this branch');
  if (request.editMessageId && !records.edit)
    throw new HttpError(404, 'Message to edit was not found');
  const [, persona, pendingRow] = await Promise.all([
    rejectOverlappingTurn(runtime, conversation),
    personaFor(runtime.db, runtime.ownerId, request.personaId),
    first<{ id: string; payload_json: string }>(
      runtime.db
        .prepare(
          "SELECT id,payload_json FROM interventions WHERE branch_id=? AND owner_id=? AND status='pending' AND kind!='ghost' ORDER BY created_at DESC LIMIT 1",
        )
        .bind(conversation.branchId, runtime.ownerId),
    ),
  ]);
  const pendingIntervention = pendingRow
    ? parseJson<Intervention | undefined>(pendingRow.payload_json, undefined)
    : undefined;
  validateLearningCheck(request, pendingIntervention);
  const model = runtime.modelFor?.(persona) ?? persona.model ?? null;
  const turnModel = { model, weight: modelWeight(model ?? '') };
  const input: TurnInput = {
    request,
    attachments,
    conversation,
    regeneration: records.regeneration,
    edit: records.edit,
    previous: records.previous,
    noteRow: records.noteRow,
    requestMessage,
    pendingRow: pendingRow ?? undefined,
  };
  // Charge last, once every check has passed, and refund if admission fails.
  const window = runtime.messageLimit
    ? await chargeMessage(runtime.db, runtime.ownerId, runtime.messageLimit, turnModel.weight)
    : null;
  try {
    return {
      kind: 'stream',
      turn: {
        ...(await prepareStreamTurn(runtime, input, persona, pendingIntervention, turnModel)),
        attachments,
      },
    };
  } catch (error) {
    if (window) await refundMessage(runtime.db, runtime.ownerId, window, turnModel.weight);
    throw error;
  }
}

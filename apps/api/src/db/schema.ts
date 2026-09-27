import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// Application schema. Mastra owns and initializes its agent_* tables separately.
export const accountPrivacy = sqliteTable(
  'account_privacy',
  {
    ownerId: text('owner_id').references((): AnySQLiteColumn => users.id, {
      onDelete: 'cascade',
      onUpdate: 'no action',
    }),
    enabled: integer('enabled').notNull().default(sql.raw('1')),
    disclosureVersion: text('disclosure_version').notNull(),
    acknowledgedAt: text('acknowledged_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    revision: text('revision').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId] }),
    check('account_privacy_check_1', sql.raw('enabled IN (0,1)')),
  ],
);

export const conversationBranches = sqliteTable(
  'conversation_branches',
  {
    id: text('id'),
    conversationId: text('conversation_id')
      .notNull()
      .references((): AnySQLiteColumn => conversations.id, {
        onDelete: 'cascade',
        onUpdate: 'no action',
      }),
    ownerId: text('owner_id')
      .notNull()
      .references((): AnySQLiteColumn => users.id, { onDelete: 'cascade', onUpdate: 'no action' }),
    headMessageId: text('head_message_id').references((): AnySQLiteColumn => messages.id, {
      onDelete: 'set null',
      onUpdate: 'no action',
    }),
    forkedFromMessageId: text('forked_from_message_id').references(
      (): AnySQLiteColumn => messages.id,
      { onDelete: 'set null', onUpdate: 'no action' },
    ),
    isDefault: integer('is_default').notNull().default(sql.raw('0')),
    status: text('status').notNull().default(sql.raw("'active'")),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex('one_default_conversation_branch')
      .on(table.conversationId)
      .where(sql.raw('is_default=1')),
    index('conversation_branches_conversation').on(table.conversationId),
    check('conversation_branches_check_1', sql.raw('is_default IN (0,1)')),
  ],
);

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id'),
    ownerId: text('owner_id')
      .notNull()
      .references((): AnySQLiteColumn => users.id, { onDelete: 'cascade', onUpdate: 'no action' }),
    noteId: text('note_id').references((): AnySQLiteColumn => notes.id, {
      onDelete: 'set null',
      onUpdate: 'no action',
    }),
    personaId: text('persona_id'),
    lastUserActivityAt: text('last_user_activity_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    status: text('status').notNull().default(sql.raw("'active'")),
    createdAt: text('created_at').notNull(),
    title: text('title').notNull().default(sql.raw("'New conversation'")),
    learningChecksEnabled: integer('learning_checks_enabled').notNull().default(sql.raw('1')),
    webSearchEnabled: integer('web_search_enabled').notNull().default(sql.raw('1')),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex('one_conversation_per_note').on(table.noteId).where(sql.raw('note_id IS NOT NULL')),
    index('conversations_owner_activity').on(table.ownerId, table.lastUserActivityAt),
    index('conversations_expiry').on(table.expiresAt),
    check('conversations_check_1', sql.raw('web_search_enabled IN (0,1)')),
    check('conversations_check_2', sql.raw('learning_checks_enabled IN (0,1)')),
  ],
);

export const hiddenPersonas = sqliteTable(
  'hidden_personas',
  {
    ownerId: text('owner_id')
      .notNull()
      .references((): AnySQLiteColumn => users.id, { onDelete: 'cascade', onUpdate: 'no action' }),
    personaId: text('persona_id').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.personaId] })],
);

export const interventions = sqliteTable(
  'interventions',
  {
    id: text('id'),
    conversationId: text('conversation_id')
      .notNull()
      .references((): AnySQLiteColumn => conversations.id, {
        onDelete: 'cascade',
        onUpdate: 'no action',
      }),
    turnId: text('turn_id')
      .notNull()
      .references((): AnySQLiteColumn => turns.id, { onDelete: 'cascade', onUpdate: 'no action' }),
    ownerId: text('owner_id')
      .notNull()
      .references((): AnySQLiteColumn => users.id, { onDelete: 'cascade', onUpdate: 'no action' }),
    kind: text('kind').notNull(),
    payloadJson: text('payload_json').notNull(),
    status: text('status').notNull().default(sql.raw("'pending'")),
    createdAt: text('created_at').notNull(),
    branchId: text('branch_id')
      .notNull()
      .references((): AnySQLiteColumn => conversationBranches.id, {
        onDelete: 'cascade',
        onUpdate: 'no action',
      }),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index('interventions_turn').on(table.turnId),
    uniqueIndex('one_pending_intervention_per_branch')
      .on(table.branchId)
      .where(sql.raw("status='pending'")),
  ],
);

export const messageHighlights = sqliteTable(
  'message_highlights',
  {
    messageId: text('message_id')
      .notNull()
      .references((): AnySQLiteColumn => messages.id, {
        onDelete: 'cascade',
        onUpdate: 'no action',
      }),
    ownerId: text('owner_id')
      .notNull()
      .references((): AnySQLiteColumn => users.id, { onDelete: 'cascade', onUpdate: 'no action' }),
    origin: text('origin').notNull().default(sql.raw("'user'")),
    start: integer('start').notNull(),
    end: integer('end').notNull(),
    quote: text('quote').notNull(),
    color: text('color'),
    kind: text('kind'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.origin, table.start, table.end] }),
    index('message_highlights_owner_message').on(table.ownerId, table.messageId),
    check('message_highlights_check_1', sql.raw("origin IN ('user','agent')")),
    check('message_highlights_check_2', sql.raw('start>=0 AND end>start')),
    check(
      'message_highlights_check_3',
      sql.raw("color IS NULL OR color IN ('yellow','green','blue','pink','purple')"),
    ),
    check('message_highlights_check_4', sql.raw("origin='user' OR color IS NULL")),
  ],
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id'),
    conversationId: text('conversation_id')
      .notNull()
      .references((): AnySQLiteColumn => conversations.id, {
        onDelete: 'cascade',
        onUpdate: 'no action',
      }),
    turnId: text('turn_id').references((): AnySQLiteColumn => turns.id, {
      onDelete: 'set null',
      onUpdate: 'no action',
    }),
    ownerId: text('owner_id')
      .notNull()
      .references((): AnySQLiteColumn => users.id, { onDelete: 'cascade', onUpdate: 'no action' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    incomplete: integer('incomplete').notNull().default(sql.raw('0')),
    createdAt: text('created_at').notNull(),
    reasoning: text('reasoning'),
    activityJson: text('activity_json').notNull().default(sql.raw("'{}'")),
    parentMessageId: text('parent_message_id').references((): AnySQLiteColumn => messages.id, {
      onDelete: 'set null',
      onUpdate: 'no action',
    }),
    originBranchId: text('origin_branch_id').references(
      (): AnySQLiteColumn => conversationBranches.id,
      { onDelete: 'set null', onUpdate: 'no action' },
    ),
    personaName: text('persona_name'),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index('messages_conversation').on(table.conversationId),
    index('messages_turn').on(table.turnId),
    index('messages_parent').on(table.parentMessageId),
    check('messages_check_1', sql.raw('incomplete IN (0,1)')),
  ],
);

export const noteEdits = sqliteTable(
  'note_edits',
  {
    id: text('id'),
    noteId: text('note_id')
      .notNull()
      .references((): AnySQLiteColumn => notes.id, { onDelete: 'cascade', onUpdate: 'no action' }),
    ownerId: text('owner_id')
      .notNull()
      .references((): AnySQLiteColumn => users.id, { onDelete: 'cascade', onUpdate: 'no action' }),
    operationId: text('operation_id').notNull(),
    baseRevision: integer('base_revision').notNull(),
    resultRevision: integer('result_revision').notNull(),
    beforeMarkdown: text('before_markdown').notNull(),
    beforeProvenanceJson: text('before_provenance_json').notNull(),
    afterMarkdown: text('after_markdown').notNull(),
    afterProvenanceJson: text('after_provenance_json').notNull(),
    undone: integer('undone').notNull().default(sql.raw('0')),
    createdAt: text('created_at').notNull(),
    discarded: integer('discarded').notNull().default(sql.raw('0')),
    suggestionChangesJson: text('suggestion_changes_json'),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    check('note_edits_check_1', sql.raw('undone IN (0,1) AND discarded IN (0,1)')),
    index('note_edits_note_revision').on(table.noteId, sql`${table.resultRevision} desc`),
    uniqueIndex('note_edits_owner_id_note_id_operation_id_unique').on(
      table.ownerId,
      table.noteId,
      table.operationId,
    ),
  ],
);

export const noteHistoryRequests = sqliteTable(
  'note_history_requests',
  {
    ownerId: text('owner_id')
      .notNull()
      .references((): AnySQLiteColumn => users.id, { onDelete: 'cascade', onUpdate: 'no action' }),
    noteId: text('note_id')
      .notNull()
      .references((): AnySQLiteColumn => notes.id, { onDelete: 'cascade', onUpdate: 'no action' }),
    operationId: text('operation_id').notNull(),
    action: text('action').notNull(),
    baseRevision: integer('base_revision').notNull(),
    editId: text('edit_id'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.noteId, table.operationId] })],
);

export const noteSuggestionCancellations = sqliteTable(
  'note_suggestion_cancellations',
  {
    ownerId: text('owner_id')
      .notNull()
      .references((): AnySQLiteColumn => users.id, { onDelete: 'cascade', onUpdate: 'no action' }),
    attemptId: text('attempt_id').notNull(),
    conversationId: text('conversation_id')
      .notNull()
      .references((): AnySQLiteColumn => conversations.id, {
        onDelete: 'cascade',
        onUpdate: 'no action',
      }),
    branchId: text('branch_id').notNull(),
    sourceMessageId: text('source_message_id')
      .notNull()
      .references((): AnySQLiteColumn => messages.id, {
        onDelete: 'cascade',
        onUpdate: 'no action',
      }),
    createdAt: text('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.attemptId] })],
);

export const noteSuggestions = sqliteTable(
  'note_suggestions',
  {
    id: text('id'),
    noteId: text('note_id')
      .notNull()
      .references((): AnySQLiteColumn => notes.id, { onDelete: 'cascade', onUpdate: 'no action' }),
    ownerId: text('owner_id')
      .notNull()
      .references((): AnySQLiteColumn => users.id, { onDelete: 'cascade', onUpdate: 'no action' }),
    conversationId: text('conversation_id').notNull(),
    sourceMessageId: text('source_message_id').notNull(),
    baseRevision: integer('base_revision').notNull(),
    oldText: text('old_text').notNull(),
    newText: text('new_text').notNull(),
    reason: text('reason').notNull(),
    status: text('status').notNull().default(sql.raw("'pending'")),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    branchId: text('branch_id')
      .notNull()
      .references((): AnySQLiteColumn => conversationBranches.id, {
        onDelete: 'cascade',
        onUpdate: 'no action',
      }),
    generationKey: text('generation_key').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex('one_pending_note_suggestion_per_generation')
      .on(table.ownerId, table.conversationId, table.branchId, table.generationKey)
      .where(sql.raw("status='pending'")),
    index('note_suggestions_generation').on(
      table.ownerId,
      table.conversationId,
      table.branchId,
      table.generationKey,
    ),
    index('note_suggestions_note_status').on(
      table.noteId,
      table.status,
      sql`${table.createdAt} desc`,
    ),
  ],
);

export const notes = sqliteTable(
  'notes',
  {
    id: text('id'),
    ownerId: text('owner_id')
      .notNull()
      .references((): AnySQLiteColumn => users.id, { onDelete: 'cascade', onUpdate: 'no action' }),
    markdown: text('markdown').notNull().default(sql.raw("''")),
    revision: integer('revision').notNull().default(sql.raw('0')),
    provenanceJson: text('provenance_json').notNull().default(sql.raw("'[]'")),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    title: text('title').notNull().default(sql.raw("''")),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index('notes_owner_updated').on(table.ownerId, sql`${table.updatedAt} desc`),
  ],
);

export const personas = sqliteTable(
  'personas',
  {
    id: text('id'),
    ownerId: text('owner_id')
      .notNull()
      .references((): AnySQLiteColumn => users.id, { onDelete: 'cascade', onUpdate: 'no action' }),
    name: text('name').notNull(),
    prompt: text('prompt').notNull(),
    model: text('model'),
    brevity: text('brevity').notNull(),
    challenge: text('challenge').notNull(),
    tone: text('tone').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    replacesPersonaId: text('replaces_persona_id'),
    icon: text('icon'),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex('personas_owner_replaces')
      .on(table.ownerId, table.replacesPersonaId)
      .where(sql.raw('replaces_persona_id IS NOT NULL')),
    index('personas_owner').on(table.ownerId),
    check(
      'personas_check_1',
      sql.raw(
        "icon IS NULL OR icon IN ('compass','swords','graduation-cap','lightbulb','book','flask','pencil','user')",
      ),
    ),
  ],
);

export const telemetryDeletions = sqliteTable(
  'telemetry_deletions',
  {
    distinctId: text('distinct_id'),
    requestedAt: text('requested_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.distinctId] })],
);

export const turns = sqliteTable(
  'turns',
  {
    id: text('id'),
    requestId: text('request_id').notNull(),
    conversationId: text('conversation_id')
      .notNull()
      .references((): AnySQLiteColumn => conversations.id, {
        onDelete: 'cascade',
        onUpdate: 'no action',
      }),
    ownerId: text('owner_id')
      .notNull()
      .references((): AnySQLiteColumn => users.id, { onDelete: 'cascade', onUpdate: 'no action' }),
    status: text('status').notNull(),
    createdAt: text('created_at').notNull(),
    completedAt: text('completed_at'),
    branchId: text('branch_id')
      .notNull()
      .references((): AnySQLiteColumn => conversationBranches.id, {
        onDelete: 'cascade',
        onUpdate: 'no action',
      }),
    sourceBranchId: text('source_branch_id')
      .notNull()
      .references((): AnySQLiteColumn => conversationBranches.id, {
        onDelete: 'cascade',
        onUpdate: 'no action',
      }),
    inputJson: text('input_json'),
    requestJson: text('request_json'),
    userMessageId: text('user_message_id'),
    /** Model the turn was admitted with and its message-budget weight. */
    model: text('model'),
    weight: integer('weight').notNull().default(sql.raw('1')),
    executionEpoch: integer('execution_epoch').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex('one_streaming_turn_per_branch')
      .on(table.branchId)
      .where(sql.raw("status='streaming'")),
    uniqueIndex('turns_owner_id_request_id_unique').on(table.ownerId, table.requestId),
    index('turns_conversation').on(table.conversationId),
  ],
);

export const turnEvents = sqliteTable(
  'turn_events',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    turnId: text('turn_id')
      .notNull()
      .references((): AnySQLiteColumn => turns.id, { onDelete: 'cascade', onUpdate: 'no action' }),
    eventJson: text('event_json').notNull(),
  },
  (table) => [index('turn_events_replay').on(table.turnId, table.seq)],
);

export const turnCancellations = sqliteTable(
  'turn_cancellations',
  {
    ownerId: text('owner_id')
      .notNull()
      .references((): AnySQLiteColumn => users.id, { onDelete: 'cascade', onUpdate: 'no action' }),
    requestId: text('request_id').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.requestId] })],
);

/** Anchored message budget: the account's current window start and weight spent in it. */
export const messageWindows = sqliteTable(
  'message_windows',
  {
    ownerId: text('owner_id').references((): AnySQLiteColumn => users.id, {
      onDelete: 'cascade',
      onUpdate: 'no action',
    }),
    startedAt: text('started_at').notNull(),
    used: integer('used').notNull().default(sql.raw('0')),
  },
  (table) => [primaryKey({ columns: [table.ownerId] })],
);

export const users = sqliteTable(
  'users',
  {
    id: text('id'),
    authSubject: text('auth_subject').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletionPending: integer('deletion_pending').notNull().default(sql.raw('0')),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex('users_auth_subject_unique').on(table.authSubject),
    check('users_check_1', sql.raw('deletion_pending IN (0,1)')),
  ],
);

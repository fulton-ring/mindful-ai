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
    retentionDisabled: integer('retention_disabled').notNull().default(0),
    purgeStartedAt: text('purge_started_at'),
    purgeToken: text('purge_token'),
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
    createdAt: text('created_at').notNull(),
    parentMessageId: text('parent_message_id').references((): AnySQLiteColumn => messages.id, {
      onDelete: 'set null',
      onUpdate: 'no action',
    }),
    originBranchId: text('origin_branch_id').references(
      (): AnySQLiteColumn => conversationBranches.id,
      { onDelete: 'set null', onUpdate: 'no action' },
    ),
    /** The WaldenUIMessage JSON; highlights and annotations are attached on load. */
    uiMessage: text('ui_message').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index('messages_conversation').on(table.conversationId),
    index('messages_turn').on(table.turnId),
    index('messages_parent').on(table.parentMessageId),
    check('messages_check_1', sql.raw("role IN ('user','assistant')")),
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
    executionGeneration: integer('execution_generation').notNull().default(0),
    descriptorVersion: integer('descriptor_version').notNull().default(1),
    descriptorJson: text('descriptor_json'),
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
    authProvider: text('auth_provider').notNull().default('clerk'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletionPending: integer('deletion_pending').notNull().default(sql.raw('0')),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex('users_auth_identity_unique').on(table.authProvider, table.authSubject),
    check('users_check_1', sql.raw('deletion_pending IN (0,1)')),
  ],
);

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey().notNull(),
  value: text('value').notNull(),
});

export const turnEvents = sqliteTable(
  'turn_events',
  {
    turnId: text('turn_id')
      .notNull()
      .references(() => turns.id, { onDelete: 'cascade' }),
    generation: integer('generation').notNull(),
    sequence: integer('sequence').notNull(),
    eventJson: text('event_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.turnId, table.sequence] }),
    index('turn_events_created_at').on(table.createdAt),
    check('turn_events_generation_check', sql`${table.generation}>=0`),
    check('turn_events_sequence_check', sql`${table.sequence}>=0`),
  ],
);

export const researchSources = sqliteTable(
  'research_sources',
  {
    id: text('id').primaryKey().notNull(),
    ownerScope: text('owner_scope').notNull(),
    sourceUrl: text('source_url').notNull(),
    blobKey: text('blob_key').notNull(),
    contentHash: text('content_hash').notNull(),
    modelRevision: text('model_revision').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('research_sources_owner_url').on(table.ownerScope, table.sourceUrl),
    index('research_sources_owner_scope').on(table.ownerScope),
  ],
);

export const researchChunks = sqliteTable(
  'research_chunks',
  {
    id: text('id').primaryKey().notNull(),
    sourceId: text('source_id')
      .notNull()
      .references(() => researchSources.id, { onDelete: 'cascade' }),
    ownerScope: text('owner_scope').notNull(),
    ordinal: integer('ordinal').notNull(),
    text: text('text').notNull(),
    embedding: text('embedding').notNull(),
    modelRevision: text('model_revision').notNull(),
  },
  (table) => [
    uniqueIndex('research_chunks_source_ordinal').on(table.sourceId, table.ordinal),
    index('research_chunks_owner_scope').on(table.ownerScope),
  ],
);

export const researchIndexingJobs = sqliteTable(
  'research_indexing_jobs',
  {
    id: text('id').primaryKey().notNull(),
    ownerScope: text('owner_scope').notNull(),
    sourceUrl: text('source_url').notNull(),
    blobKey: text('blob_key').notNull(),
    contentHash: text('content_hash').notNull(),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('research_indexing_jobs_owner_url').on(table.ownerScope, table.sourceUrl),
    index('research_indexing_jobs_owner_scope').on(table.ownerScope),
    check(
      'research_indexing_jobs_status_check',
      sql`${table.status} IN ('pending','running','complete','failed')`,
    ),
  ],
);
// research_chunks_fts is managed in SQL: Drizzle cannot describe virtual tables.

export { authAccount, authSession, authUser, authVerification } from './auth-schema';

export const turnExecutionState = sqliteTable(
  'turn_execution_state',
  {
    turnId: text('turn_id')
      .primaryKey()
      .notNull()
      .references(() => turns.id, { onDelete: 'cascade' }),
    stateJson: text('state_json').notNull(),
    alarmAt: integer('alarm_at'),
    endedAt: integer('ended_at'),
  },
  (table) => [index('turn_execution_state_alarm_at').on(table.alarmAt)],
);

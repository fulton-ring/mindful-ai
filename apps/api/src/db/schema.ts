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

export const billingCustomers = sqliteTable(
  'billing_customers',
  {
    ownerId: text('owner_id').references((): AnySQLiteColumn => users.id, {
      onDelete: 'cascade',
      onUpdate: 'no action',
    }),
    customerId: text('customer_id').notNull(),
    subscriptionId: text('subscription_id'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId] }),
    uniqueIndex('billing_customers_customer_id_unique').on(table.customerId),
  ],
);

export const billingEvents = sqliteTable(
  'billing_events',
  {
    id: text('id'),
    processedAt: text('processed_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.id] })],
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
    lastUserActivityAt: text('last_user_activity_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex('one_default_conversation_branch')
      .on(table.conversationId)
      .where(sql.raw('is_default=1')),
    index('conversation_branches_expiry').on(table.status, table.expiresAt),
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
    personaSnapshotJson: text('persona_snapshot_json'),
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
    index('conversations_expiry').on(table.status, table.expiresAt),
    check('conversations_check_1', sql.raw('web_search_enabled IN (0,1)')),
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
    branchId: text('branch_id').references((): AnySQLiteColumn => conversationBranches.id, {
      onDelete: 'cascade',
      onUpdate: 'no action',
    }),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
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
    index('message_highlights_message_origin').on(table.messageId, table.origin),
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
    sequence: integer('sequence').notNull(),
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
    index('messages_conversation').on(table.conversationId, table.sequence),
    uniqueIndex('messages_conversation_id_sequence_unique').on(
      table.conversationId,
      table.sequence,
    ),
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
    undoneAt: text('undone_at'),
    suggestionChangesJson: text('suggestion_changes_json'),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
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
    conversationId: text('conversation_id'),
    sourceMessageId: text('source_message_id'),
    baseRevision: integer('base_revision').notNull(),
    oldText: text('old_text').notNull(),
    newText: text('new_text').notNull(),
    reason: text('reason').notNull(),
    status: text('status').notNull().default(sql.raw("'pending'")),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    decidedAt: text('decided_at'),
    branchId: text('branch_id').references((): AnySQLiteColumn => conversationBranches.id, {
      onDelete: 'cascade',
      onUpdate: 'no action',
    }),
    generationKey: text('generation_key'),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex('one_pending_note_suggestion_per_generation')
      .on(table.ownerId, table.conversationId, table.branchId, table.generationKey)
      .where(sql.raw("status='pending'")),
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
    brevity: text('brevity').notNull(),
    challenge: text('challenge').notNull(),
    tone: text('tone').notNull(),
    revision: integer('revision').notNull().default(sql.raw('0')),
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

export const productEvents = sqliteTable(
  'product_events',
  {
    id: text('id'),
    ownerId: text('owner_id')
      .notNull()
      .references((): AnySQLiteColumn => users.id, { onDelete: 'cascade', onUpdate: 'no action' }),
    sessionId: text('session_id').notNull(),
    kind: text('kind').notNull(),
    metadataJson: text('metadata_json').notNull().default(sql.raw("'{}'")),
    occurredAt: text('occurred_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.id] })],
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
    inputTokens: integer('input_tokens').notNull().default(sql.raw('0')),
    outputTokens: integer('output_tokens').notNull().default(sql.raw('0')),
    createdAt: text('created_at').notNull(),
    completedAt: text('completed_at'),
    branchId: text('branch_id').references((): AnySQLiteColumn => conversationBranches.id, {
      onDelete: 'cascade',
      onUpdate: 'no action',
    }),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex('one_streaming_turn_per_branch')
      .on(table.branchId)
      .where(sql.raw("status='streaming'")),
    uniqueIndex('turns_owner_id_request_id_unique').on(table.ownerId, table.requestId),
  ],
);

export const usagePeriods = sqliteTable(
  'usage_periods',
  {
    ownerId: text('owner_id').references((): AnySQLiteColumn => users.id, {
      onDelete: 'cascade',
      onUpdate: 'no action',
    }),
    plan: text('plan').notNull().default(sql.raw("'free'")),
    used: integer('used').notNull().default(sql.raw('0')),
    unitLimit: integer('unit_limit').notNull().default(sql.raw('10')),
    resetsAt: text('resets_at').notNull(),
    inputTokens: integer('input_tokens').notNull().default(sql.raw('0')),
    outputTokens: integer('output_tokens').notNull().default(sql.raw('0')),
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
  ],
);

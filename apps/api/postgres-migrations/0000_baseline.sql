-- PostgreSQL application schema. JSON stays text to preserve the storage contract.
CREATE TABLE "account_privacy" (
	"owner_id" text PRIMARY KEY,
	"enabled" integer DEFAULT 1 NOT NULL,
	"disclosure_version" text NOT NULL,
	"acknowledged_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"revision" text NOT NULL,
	CONSTRAINT "account_privacy_check_1" CHECK(enabled IN (0,1))
);

CREATE TABLE "conversation_branches" (
	"id" text PRIMARY KEY,
	"conversation_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"head_message_id" text,
	"forked_from_message_id" text,
	"is_default" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "conversation_branches_check_1" CHECK(is_default IN (0,1))
);

CREATE UNIQUE INDEX "one_default_conversation_branch" ON "conversation_branches" ("conversation_id") WHERE is_default=1;
CREATE INDEX "conversation_branches_conversation" ON "conversation_branches" ("conversation_id");
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY,
	"owner_id" text NOT NULL,
	"note_id" text,
	"persona_id" text,
	"last_user_activity_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" text NOT NULL,
	"title" text DEFAULT 'New conversation' NOT NULL,
	"learning_checks_enabled" integer DEFAULT 1 NOT NULL,
	"web_search_enabled" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "conversations_check_1" CHECK(web_search_enabled IN (0,1)),
	CONSTRAINT "conversations_check_2" CHECK(learning_checks_enabled IN (0,1))
);

CREATE UNIQUE INDEX "one_conversation_per_note" ON "conversations" ("note_id") WHERE note_id IS NOT NULL;
CREATE INDEX "conversations_owner_activity" ON "conversations" ("owner_id","last_user_activity_at");
CREATE INDEX "conversations_expiry" ON "conversations" ("expires_at");
CREATE TABLE "hidden_personas" (
	"owner_id" text NOT NULL,
	"persona_id" text NOT NULL,
	"created_at" text NOT NULL,
	PRIMARY KEY("owner_id", "persona_id")
);

CREATE TABLE "interventions" (
	"id" text PRIMARY KEY,
	"conversation_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload_json" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" text NOT NULL,
	"branch_id" text NOT NULL
);

CREATE INDEX "interventions_turn" ON "interventions" ("turn_id");
CREATE UNIQUE INDEX "one_pending_intervention_per_branch" ON "interventions" ("branch_id") WHERE status='pending';
CREATE TABLE "message_highlights" (
	"message_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"origin" text DEFAULT 'user' NOT NULL,
	"start" integer NOT NULL,
	"end" integer NOT NULL,
	"quote" text NOT NULL,
	"color" text,
	"kind" text,
	"updated_at" text NOT NULL,
	PRIMARY KEY("message_id", "origin", "start", "end"),
	CONSTRAINT "message_highlights_check_1" CHECK(origin IN ('user','agent')),
	CONSTRAINT "message_highlights_check_2" CHECK(start>=0 AND "end">start),
	CONSTRAINT "message_highlights_check_3" CHECK(color IS NULL OR color IN ('yellow','green','blue','pink','purple')),
	CONSTRAINT "message_highlights_check_4" CHECK(origin='user' OR color IS NULL)
);

CREATE INDEX "message_highlights_owner_message" ON "message_highlights" ("owner_id","message_id");
CREATE TABLE "message_windows" (
	"owner_id" text PRIMARY KEY,
	"started_at" text NOT NULL,
	"used" integer DEFAULT 0 NOT NULL
);

CREATE TABLE "messages" (
	"id" text PRIMARY KEY,
	"conversation_id" text NOT NULL,
	"turn_id" text,
	"owner_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" text NOT NULL,
	"parent_message_id" text,
	"origin_branch_id" text,
	"ui_message" text NOT NULL,
	CONSTRAINT "messages_check_1" CHECK(role IN ('user','assistant'))
);

CREATE INDEX "messages_conversation" ON "messages" ("conversation_id");
CREATE INDEX "messages_turn" ON "messages" ("turn_id");
CREATE INDEX "messages_parent" ON "messages" ("parent_message_id");
CREATE TABLE "note_edits" (
	"id" text PRIMARY KEY,
	"note_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"base_revision" integer NOT NULL,
	"result_revision" integer NOT NULL,
	"before_markdown" text NOT NULL,
	"before_provenance_json" text NOT NULL,
	"after_markdown" text NOT NULL,
	"after_provenance_json" text NOT NULL,
	"undone" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"discarded" integer DEFAULT 0 NOT NULL,
	"suggestion_changes_json" text,
	CONSTRAINT "note_edits_check_1" CHECK(undone IN (0,1) AND discarded IN (0,1))
);

CREATE INDEX "note_edits_note_revision" ON "note_edits" ("note_id","result_revision" desc);
CREATE UNIQUE INDEX "note_edits_owner_id_note_id_operation_id_unique" ON "note_edits" ("owner_id","note_id","operation_id");
CREATE TABLE "note_history_requests" (
	"owner_id" text NOT NULL,
	"note_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"action" text NOT NULL,
	"base_revision" integer NOT NULL,
	"edit_id" text,
	"created_at" text NOT NULL,
	PRIMARY KEY("owner_id", "note_id", "operation_id")
);

CREATE TABLE "note_suggestion_cancellations" (
	"owner_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"source_message_id" text NOT NULL,
	"created_at" text NOT NULL,
	PRIMARY KEY("owner_id", "attempt_id")
);

CREATE TABLE "note_suggestions" (
	"id" text PRIMARY KEY,
	"note_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"source_message_id" text NOT NULL,
	"base_revision" integer NOT NULL,
	"old_text" text NOT NULL,
	"new_text" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"branch_id" text NOT NULL,
	"generation_key" text NOT NULL
);

CREATE UNIQUE INDEX "one_pending_note_suggestion_per_generation" ON "note_suggestions" ("owner_id","conversation_id","branch_id","generation_key") WHERE status='pending';
CREATE INDEX "note_suggestions_generation" ON "note_suggestions" ("owner_id","conversation_id","branch_id","generation_key");
CREATE INDEX "note_suggestions_note_status" ON "note_suggestions" ("note_id","status","created_at" desc);
CREATE TABLE "notes" (
	"id" text PRIMARY KEY,
	"owner_id" text NOT NULL,
	"markdown" text DEFAULT '' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"provenance_json" text DEFAULT '[]' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"title" text DEFAULT '' NOT NULL
);

CREATE INDEX "notes_owner_updated" ON "notes" ("owner_id","updated_at" desc);
CREATE TABLE "personas" (
	"id" text PRIMARY KEY,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"model" text,
	"brevity" text NOT NULL,
	"challenge" text NOT NULL,
	"tone" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"replaces_persona_id" text,
	"icon" text,
	CONSTRAINT "personas_check_1" CHECK(icon IS NULL OR icon IN ('compass','swords','graduation-cap','lightbulb','book','flask','pencil','user'))
);

CREATE UNIQUE INDEX "personas_owner_replaces" ON "personas" ("owner_id","replaces_persona_id") WHERE replaces_persona_id IS NOT NULL;
CREATE INDEX "personas_owner" ON "personas" ("owner_id");
CREATE TABLE "telemetry_deletions" (
	"distinct_id" text PRIMARY KEY,
	"requested_at" text NOT NULL
);

CREATE TABLE "turn_cancellations" (
	"owner_id" text NOT NULL,
	"request_id" text NOT NULL,
	"created_at" text NOT NULL,
	PRIMARY KEY("owner_id", "request_id")
);

CREATE TABLE "turns" (
	"id" text PRIMARY KEY,
	"request_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" text NOT NULL,
	"completed_at" text,
	"branch_id" text NOT NULL,
	"source_branch_id" text NOT NULL,
	"input_json" text,
	"request_json" text,
	"user_message_id" text,
	"model" text,
	"weight" integer DEFAULT 1 NOT NULL
);

CREATE UNIQUE INDEX "one_streaming_turn_per_branch" ON "turns" ("branch_id") WHERE status='streaming';
CREATE UNIQUE INDEX "turns_owner_id_request_id_unique" ON "turns" ("owner_id","request_id");
CREATE INDEX "turns_conversation" ON "turns" ("conversation_id");
CREATE TABLE "users" (
	"id" text PRIMARY KEY,
	"auth_subject" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deletion_pending" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "users_check_1" CHECK(deletion_pending IN (0,1))
);

CREATE UNIQUE INDEX "users_auth_subject_unique" ON "users" ("auth_subject");

ALTER TABLE "account_privacy" ADD FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "conversation_branches" ADD FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "conversation_branches" ADD FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "conversation_branches" ADD FOREIGN KEY ("head_message_id") REFERENCES "messages"("id") ON UPDATE no action ON DELETE set null;
ALTER TABLE "conversation_branches" ADD FOREIGN KEY ("forked_from_message_id") REFERENCES "messages"("id") ON UPDATE no action ON DELETE set null;
ALTER TABLE "conversations" ADD FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "conversations" ADD FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON UPDATE no action ON DELETE set null;
ALTER TABLE "hidden_personas" ADD FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "interventions" ADD FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "interventions" ADD FOREIGN KEY ("turn_id") REFERENCES "turns"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "interventions" ADD FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "interventions" ADD FOREIGN KEY ("branch_id") REFERENCES "conversation_branches"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "message_highlights" ADD FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "message_highlights" ADD FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "message_windows" ADD FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "messages" ADD FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "messages" ADD FOREIGN KEY ("turn_id") REFERENCES "turns"("id") ON UPDATE no action ON DELETE set null;
ALTER TABLE "messages" ADD FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "messages" ADD FOREIGN KEY ("parent_message_id") REFERENCES "messages"("id") ON UPDATE no action ON DELETE set null;
ALTER TABLE "messages" ADD FOREIGN KEY ("origin_branch_id") REFERENCES "conversation_branches"("id") ON UPDATE no action ON DELETE set null;
ALTER TABLE "note_edits" ADD FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "note_edits" ADD FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "note_history_requests" ADD FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "note_history_requests" ADD FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "note_suggestion_cancellations" ADD FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "note_suggestion_cancellations" ADD FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "note_suggestion_cancellations" ADD FOREIGN KEY ("source_message_id") REFERENCES "messages"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "note_suggestions" ADD FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "note_suggestions" ADD FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "note_suggestions" ADD FOREIGN KEY ("branch_id") REFERENCES "conversation_branches"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "notes" ADD FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "personas" ADD FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "turn_cancellations" ADD FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "turns" ADD FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "turns" ADD FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "turns" ADD FOREIGN KEY ("branch_id") REFERENCES "conversation_branches"("id") ON UPDATE no action ON DELETE cascade;
ALTER TABLE "turns" ADD FOREIGN KEY ("source_branch_id") REFERENCES "conversation_branches"("id") ON UPDATE no action ON DELETE cascade;

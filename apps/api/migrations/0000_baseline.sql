CREATE TABLE `account_privacy` (
	`owner_id` text PRIMARY KEY,
	`enabled` integer DEFAULT 1 NOT NULL,
	`disclosure_version` text NOT NULL,
	`acknowledged_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`revision` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "account_privacy_check_1" CHECK(enabled IN (0,1))
);
--> statement-breakpoint
CREATE TABLE `conversation_branches` (
	`id` text PRIMARY KEY,
	`conversation_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`head_message_id` text,
	`forked_from_message_id` text,
	`is_default` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`head_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`forked_from_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "conversation_branches_check_1" CHECK(is_default IN (0,1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_default_conversation_branch` ON `conversation_branches` (`conversation_id`) WHERE is_default=1;--> statement-breakpoint
CREATE INDEX `conversation_branches_conversation` ON `conversation_branches` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	`note_id` text,
	`persona_id` text,
	`last_user_activity_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`title` text DEFAULT 'New conversation' NOT NULL,
	`learning_checks_enabled` integer DEFAULT 1 NOT NULL,
	`web_search_enabled` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "conversations_check_1" CHECK(web_search_enabled IN (0,1)),
	CONSTRAINT "conversations_check_2" CHECK(learning_checks_enabled IN (0,1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_conversation_per_note` ON `conversations` (`note_id`) WHERE note_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `conversations_owner_activity` ON `conversations` (`owner_id`,`last_user_activity_at`);--> statement-breakpoint
CREATE INDEX `conversations_expiry` ON `conversations` (`expires_at`);--> statement-breakpoint
CREATE TABLE `hidden_personas` (
	`owner_id` text NOT NULL,
	`persona_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `persona_id`),
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `interventions` (
	`id` text PRIMARY KEY,
	`conversation_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`branch_id` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`branch_id`) REFERENCES `conversation_branches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `interventions_turn` ON `interventions` (`turn_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `one_pending_intervention_per_branch` ON `interventions` (`branch_id`) WHERE status='pending';--> statement-breakpoint
CREATE TABLE `message_highlights` (
	`message_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`origin` text DEFAULT 'user' NOT NULL,
	`start` integer NOT NULL,
	`end` integer NOT NULL,
	`quote` text NOT NULL,
	`color` text,
	`kind` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`message_id`, `origin`, `start`, `end`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "message_highlights_check_1" CHECK(origin IN ('user','agent')),
	CONSTRAINT "message_highlights_check_2" CHECK(start>=0 AND end>start),
	CONSTRAINT "message_highlights_check_3" CHECK(color IS NULL OR color IN ('yellow','green','blue','pink','purple')),
	CONSTRAINT "message_highlights_check_4" CHECK(origin='user' OR color IS NULL)
);
--> statement-breakpoint
CREATE INDEX `message_highlights_owner_message` ON `message_highlights` (`owner_id`,`message_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY,
	`conversation_id` text NOT NULL,
	`turn_id` text,
	`owner_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`incomplete` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`reasoning` text,
	`activity_json` text DEFAULT '{}' NOT NULL,
	`parent_message_id` text,
	`origin_branch_id` text,
	`persona_name` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`origin_branch_id`) REFERENCES `conversation_branches`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "messages_check_1" CHECK(incomplete IN (0,1))
);
--> statement-breakpoint
CREATE INDEX `messages_conversation` ON `messages` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `messages_turn` ON `messages` (`turn_id`);--> statement-breakpoint
CREATE INDEX `messages_parent` ON `messages` (`parent_message_id`);--> statement-breakpoint
CREATE TABLE `note_edits` (
	`id` text PRIMARY KEY,
	`note_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`base_revision` integer NOT NULL,
	`result_revision` integer NOT NULL,
	`before_markdown` text NOT NULL,
	`before_provenance_json` text NOT NULL,
	`after_markdown` text NOT NULL,
	`after_provenance_json` text NOT NULL,
	`undone` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`discarded` integer DEFAULT 0 NOT NULL,
	`suggestion_changes_json` text,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "note_edits_check_1" CHECK(undone IN (0,1) AND discarded IN (0,1))
);
--> statement-breakpoint
CREATE INDEX `note_edits_note_revision` ON `note_edits` (`note_id`,"result_revision" desc);--> statement-breakpoint
CREATE UNIQUE INDEX `note_edits_owner_id_note_id_operation_id_unique` ON `note_edits` (`owner_id`,`note_id`,`operation_id`);--> statement-breakpoint
CREATE TABLE `note_history_requests` (
	`owner_id` text NOT NULL,
	`note_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`action` text NOT NULL,
	`base_revision` integer NOT NULL,
	`edit_id` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `note_id`, `operation_id`),
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `note_suggestion_cancellations` (
	`owner_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`source_message_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `attempt_id`),
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `note_suggestions` (
	`id` text PRIMARY KEY,
	`note_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`source_message_id` text NOT NULL,
	`base_revision` integer NOT NULL,
	`old_text` text NOT NULL,
	`new_text` text NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`branch_id` text NOT NULL,
	`generation_key` text NOT NULL,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`branch_id`) REFERENCES `conversation_branches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_pending_note_suggestion_per_generation` ON `note_suggestions` (`owner_id`,`conversation_id`,`branch_id`,`generation_key`) WHERE status='pending';--> statement-breakpoint
CREATE INDEX `note_suggestions_generation` ON `note_suggestions` (`owner_id`,`conversation_id`,`branch_id`,`generation_key`);--> statement-breakpoint
CREATE INDEX `note_suggestions_note_status` ON `note_suggestions` (`note_id`,`status`,"created_at" desc);--> statement-breakpoint
CREATE TABLE `notes` (
	`id` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	`markdown` text DEFAULT '' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`provenance_json` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notes_owner_updated` ON `notes` (`owner_id`,"updated_at" desc);--> statement-breakpoint
CREATE TABLE `personas` (
	`id` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`prompt` text NOT NULL,
	`model` text,
	`brevity` text NOT NULL,
	`challenge` text NOT NULL,
	`tone` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`replaces_persona_id` text,
	`icon` text,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "personas_check_1" CHECK(icon IS NULL OR icon IN ('compass','swords','graduation-cap','lightbulb','book','flask','pencil','user'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `personas_owner_replaces` ON `personas` (`owner_id`,`replaces_persona_id`) WHERE replaces_persona_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `personas_owner` ON `personas` (`owner_id`);--> statement-breakpoint
CREATE TABLE `telemetry_deletions` (
	`distinct_id` text PRIMARY KEY,
	`requested_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `turn_cancellations` (
	`owner_id` text NOT NULL,
	`request_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `request_id`),
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `turn_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`turn_id` text NOT NULL,
	`event_json` text NOT NULL,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `turn_events_replay` ON `turn_events` (`turn_id`,`seq`);--> statement-breakpoint
CREATE TABLE `turns` (
	`id` text PRIMARY KEY,
	`request_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`completed_at` text,
	`branch_id` text NOT NULL,
	`source_branch_id` text NOT NULL,
	`input_json` text,
	`request_json` text,
	`user_message_id` text,
	`execution_epoch` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`branch_id`) REFERENCES `conversation_branches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_branch_id`) REFERENCES `conversation_branches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_streaming_turn_per_branch` ON `turns` (`branch_id`) WHERE status='streaming';--> statement-breakpoint
CREATE UNIQUE INDEX `turns_owner_id_request_id_unique` ON `turns` (`owner_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `turns_conversation` ON `turns` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY,
	`auth_subject` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deletion_pending` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "users_check_1" CHECK(deletion_pending IN (0,1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_auth_subject_unique` ON `users` (`auth_subject`);--> statement-breakpoint
-- Hand-written: drizzle-kit does not generate triggers. Keep these when regenerating.
CREATE TRIGGER prevent_cancelled_turn_admission BEFORE INSERT ON turns
WHEN EXISTS(SELECT 1 FROM turn_cancellations WHERE owner_id=NEW.owner_id AND request_id=NEW.request_id)
BEGIN SELECT RAISE(ABORT,'Turn cancelled before admission'); END;
--> statement-breakpoint
CREATE TRIGGER prevent_overlapping_turn_branches BEFORE INSERT ON turns
WHEN NEW.status='streaming' AND EXISTS (
  SELECT 1 FROM turns t WHERE t.status='streaming' AND (
    t.branch_id IN (NEW.branch_id,NEW.source_branch_id) OR
    t.source_branch_id IN (NEW.branch_id,NEW.source_branch_id)
  )
)
BEGIN SELECT RAISE(ABORT,'A turn is already in progress for this branch'); END;

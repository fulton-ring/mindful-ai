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
CREATE TABLE `billing_customers` (
	`owner_id` text PRIMARY KEY,
	`customer_id` text NOT NULL,
	`subscription_id` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_customers_customer_id_unique` ON `billing_customers` (`customer_id`);--> statement-breakpoint
CREATE TABLE `billing_events` (
	`id` text PRIMARY KEY,
	`processed_at` text NOT NULL
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
	`last_user_activity_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`head_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`forked_from_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_default_conversation_branch` ON `conversation_branches` (`conversation_id`) WHERE is_default=1;--> statement-breakpoint
CREATE INDEX `conversation_branches_expiry` ON `conversation_branches` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	`note_id` text,
	`persona_id` text,
	`persona_snapshot_json` text,
	`last_user_activity_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`title` text DEFAULT 'New conversation' NOT NULL,
	`learning_checks_enabled` integer DEFAULT 1 NOT NULL,
	`web_search_enabled` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "conversations_check_1" CHECK(web_search_enabled IN (0,1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_conversation_per_note` ON `conversations` (`note_id`) WHERE note_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `conversations_expiry` ON `conversations` (`status`,`expires_at`);--> statement-breakpoint
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
	`branch_id` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`branch_id`) REFERENCES `conversation_branches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
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
CREATE INDEX `message_highlights_message_origin` ON `message_highlights` (`message_id`,`origin`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY,
	`conversation_id` text NOT NULL,
	`turn_id` text,
	`owner_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`incomplete` integer DEFAULT 0 NOT NULL,
	`sequence` integer NOT NULL,
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
	FOREIGN KEY (`origin_branch_id`) REFERENCES `conversation_branches`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `messages_conversation` ON `messages` (`conversation_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_conversation_id_sequence_unique` ON `messages` (`conversation_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `note_edits` (
	`id` text PRIMARY KEY,
	`note_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`base_revision` integer NOT NULL,
	`result_revision` integer NOT NULL,
	`before_title` text NOT NULL,
	`before_markdown` text NOT NULL,
	`before_provenance_json` text NOT NULL,
	`after_title` text NOT NULL,
	`after_markdown` text NOT NULL,
	`after_provenance_json` text NOT NULL,
	`undone` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`kind` text DEFAULT 'user_edit' NOT NULL,
	`suggestion_id` text,
	`before_suggestion_status` text,
	`after_suggestion_status` text,
	`discarded` integer DEFAULT 0 NOT NULL,
	`undone_at` text,
	`suggestion_changes_json` text,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
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
	`conversation_id` text,
	`source_message_id` text,
	`base_revision` integer NOT NULL,
	`base_markdown` text NOT NULL,
	`old_text` text NOT NULL,
	`new_text` text NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decision_edit_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`decided_at` text,
	`branch_id` text,
	`generation_key` text,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`branch_id`) REFERENCES `conversation_branches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_pending_note_suggestion_per_generation` ON `note_suggestions` (`owner_id`,`conversation_id`,`branch_id`,`generation_key`) WHERE status='pending';--> statement-breakpoint
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
	`brevity` text NOT NULL,
	`challenge` text NOT NULL,
	`tone` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
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
CREATE TABLE `product_events` (
	`id` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `telemetry_deletions` (
	`distinct_id` text PRIMARY KEY,
	`requested_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `turns` (
	`id` text PRIMARY KEY,
	`request_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`status` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`completed_at` text,
	`branch_id` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`branch_id`) REFERENCES `conversation_branches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_streaming_turn_per_branch` ON `turns` (`branch_id`) WHERE status='streaming';--> statement-breakpoint
CREATE UNIQUE INDEX `turns_owner_id_request_id_unique` ON `turns` (`owner_id`,`request_id`);--> statement-breakpoint
CREATE TABLE `usage_periods` (
	`owner_id` text PRIMARY KEY,
	`plan` text DEFAULT 'free' NOT NULL,
	`used` integer DEFAULT 0 NOT NULL,
	`unit_limit` integer DEFAULT 10 NOT NULL,
	`resets_at` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY,
	`auth_subject` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deletion_pending` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_auth_subject_unique` ON `users` (`auth_subject`);
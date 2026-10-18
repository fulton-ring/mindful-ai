CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` text,
	`refresh_token_expires_at` text,
	`scope` text,
	`password` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `auth_user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `auth_account_user` ON `auth_account` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `auth_account_identity` ON `auth_account` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `auth_session` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `auth_user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_session_token_unique` ON `auth_session` (`token`);--> statement-breakpoint
CREATE INDEX `auth_session_user` ON `auth_session` (`user_id`);--> statement-breakpoint
CREATE TABLE `auth_user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_user_email_unique` ON `auth_user` (`email`);--> statement-breakpoint
CREATE TABLE `auth_verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_verification_identifier` ON `auth_verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `research_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`owner_scope` text NOT NULL,
	`ordinal` integer NOT NULL,
	`text` text NOT NULL,
	`embedding` text NOT NULL,
	`model_revision` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `research_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_chunks_source_ordinal` ON `research_chunks` (`source_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `research_chunks_owner_scope` ON `research_chunks` (`owner_scope`);--> statement-breakpoint
CREATE TABLE `research_indexing_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_scope` text NOT NULL,
	`source_url` text NOT NULL,
	`blob_key` text NOT NULL,
	`content_hash` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`updated_at` text NOT NULL,
	CONSTRAINT "research_indexing_jobs_status_check" CHECK("research_indexing_jobs"."status" IN ('pending','running','complete','failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_indexing_jobs_owner_url` ON `research_indexing_jobs` (`owner_scope`,`source_url`);--> statement-breakpoint
CREATE INDEX `research_indexing_jobs_owner_scope` ON `research_indexing_jobs` (`owner_scope`);--> statement-breakpoint
CREATE TABLE `research_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_scope` text NOT NULL,
	`source_url` text NOT NULL,
	`blob_key` text NOT NULL,
	`content_hash` text NOT NULL,
	`model_revision` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_sources_owner_url` ON `research_sources` (`owner_scope`,`source_url`);--> statement-breakpoint
CREATE INDEX `research_sources_owner_scope` ON `research_sources` (`owner_scope`);--> statement-breakpoint
CREATE TABLE `turn_events` (
	`turn_id` text NOT NULL,
	`generation` integer NOT NULL,
	`sequence` integer NOT NULL,
	`event_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`turn_id`, `sequence`),
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "turn_events_generation_check" CHECK("turn_events"."generation">=0),
	CONSTRAINT "turn_events_sequence_check" CHECK("turn_events"."sequence">=0)
);
--> statement-breakpoint
CREATE INDEX `turn_events_created_at` ON `turn_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `turn_execution_state` (
	`turn_id` text PRIMARY KEY NOT NULL,
	`state_json` text NOT NULL,
	`alarm_at` integer,
	`ended_at` integer,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `turn_execution_state_alarm_at` ON `turn_execution_state` (`alarm_at`);--> statement-breakpoint
DROP INDEX `users_auth_subject_unique`;--> statement-breakpoint
ALTER TABLE `users` ADD `auth_provider` text DEFAULT 'clerk' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `users_auth_identity_unique` ON `users` (`auth_provider`,`auth_subject`);--> statement-breakpoint
ALTER TABLE `turns` ADD `execution_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `turns` ADD `descriptor_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `turns` ADD `descriptor_json` text;
--> statement-breakpoint
-- Hand-written: Drizzle cannot describe virtual tables. Preserve on regeneration.
CREATE VIRTUAL TABLE research_chunks_fts USING fts5(chunk_id UNINDEXED,owner_scope UNINDEXED,text);

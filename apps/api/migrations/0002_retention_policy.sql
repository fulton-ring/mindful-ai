ALTER TABLE `conversations` ADD `retention_disabled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `purge_started_at` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `purge_token` text;
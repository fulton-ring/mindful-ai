ALTER TABLE `turns` ADD `model` text;--> statement-breakpoint
ALTER TABLE `turns` ADD `weight` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX `turns_owner_created` ON `turns` (`owner_id`,`created_at`);
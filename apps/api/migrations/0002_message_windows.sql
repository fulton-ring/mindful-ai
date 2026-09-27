CREATE TABLE `message_windows` (
	`owner_id` text PRIMARY KEY,
	`started_at` text NOT NULL,
	`used` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DROP INDEX `turns_owner_created`;
UPDATE `note_edits`
SET `suggestion_changes_json` = json_array(json_object(
  'id', `suggestion_id`,
  'beforeStatus', `before_suggestion_status`,
  'afterStatus', `after_suggestion_status`
))
WHERE `suggestion_changes_json` IS NULL
  AND `suggestion_id` IS NOT NULL
  AND `before_suggestion_status` IS NOT NULL
  AND `after_suggestion_status` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `note_edits` DROP COLUMN `before_title`;--> statement-breakpoint
ALTER TABLE `note_edits` DROP COLUMN `after_title`;--> statement-breakpoint
ALTER TABLE `note_edits` DROP COLUMN `kind`;--> statement-breakpoint
ALTER TABLE `note_edits` DROP COLUMN `suggestion_id`;--> statement-breakpoint
ALTER TABLE `note_edits` DROP COLUMN `before_suggestion_status`;--> statement-breakpoint
ALTER TABLE `note_edits` DROP COLUMN `after_suggestion_status`;--> statement-breakpoint
ALTER TABLE `note_suggestions` DROP COLUMN `base_markdown`;--> statement-breakpoint
ALTER TABLE `note_suggestions` DROP COLUMN `decision_edit_id`;

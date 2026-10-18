ALTER TABLE `teams` ADD `parent_id` text;--> statement-breakpoint
CREATE INDEX `teams_parent_idx` ON `teams` (`parent_id`);
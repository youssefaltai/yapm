ALTER TABLE `runs` ADD `engine` text;--> statement-breakpoint
UPDATE `runs` SET `engine` = 'claude' WHERE `started_at` IS NOT NULL;
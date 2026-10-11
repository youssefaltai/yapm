ALTER TABLE `machines` ADD `engines` text;--> statement-breakpoint
ALTER TABLE `users` ADD `engine` text DEFAULT 'claude' NOT NULL;
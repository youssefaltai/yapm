CREATE TABLE `issue_subscriptions` (
	`issue_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`issue_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `issue_subscriptions_user_idx` ON `issue_subscriptions` (`user_id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`actor_id` text,
	`issue_id` text,
	`comment_id` text,
	`request_id` text,
	`data` text,
	`read_at` integer,
	`snoozed_until_at` integer,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notifications_user_idx` ON `notifications` (`user_id`,`created_at`);--> statement-breakpoint
-- Existing issues: their creators and assignees follow them, as they would have from the start.
INSERT OR IGNORE INTO `issue_subscriptions` (`issue_id`, `user_id`, `created_at`) SELECT `id`, `creator_id`, `created_at` FROM `issues` WHERE `creator_id` IS NOT NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `issue_subscriptions` (`issue_id`, `user_id`, `created_at`) SELECT `id`, `assignee_id`, `updated_at` FROM `issues` WHERE `assignee_id` IS NOT NULL;

CREATE TABLE `feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`author_id` text,
	`run_id` text,
	`issue_id` text,
	`request_id` text,
	`addressed_at` integer,
	`addressed_by_id` text,
	`addressed_note` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `feedback_agent_idx` ON `feedback` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`entity_id` text NOT NULL,
	`content` text NOT NULL,
	`author_id` text,
	`run_id` text,
	`reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `revisions_entity_idx` ON `revisions` (`subject`,`entity_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `users` ADD `lessons` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `handbook` text;
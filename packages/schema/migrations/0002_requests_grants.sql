CREATE TABLE `grants` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`resource` text,
	`scope` text NOT NULL,
	`subject_id` text,
	`note` text,
	`created_by_id` text NOT NULL,
	`request_id` text,
	`use_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `grants_action_idx` ON `grants` (`action`);--> statement-breakpoint
CREATE TABLE `requests` (
	`id` text PRIMARY KEY NOT NULL,
	`requester_id` text NOT NULL,
	`title` text NOT NULL,
	`action` text NOT NULL,
	`resource` text,
	`reason` text NOT NULL,
	`details` text,
	`issue_id` text,
	`run_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`answered_by_id` text,
	`answered_at` integer,
	`answer` text,
	`grant_id` text,
	`consumed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `requests_status_idx` ON `requests` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `requests_requester_idx` ON `requests` (`requester_id`,`action`);--> statement-breakpoint
CREATE INDEX `requests_issue_idx` ON `requests` (`issue_id`);
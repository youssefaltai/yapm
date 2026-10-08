CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`user_id` text NOT NULL,
	`parent_id` text,
	`body` text NOT NULL,
	`edited_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `comments_issue_idx` ON `comments` (`issue_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `issue_labels` (
	`issue_id` text NOT NULL,
	`label_id` text NOT NULL,
	PRIMARY KEY(`issue_id`, `label_id`)
);
--> statement-breakpoint
CREATE INDEX `issue_labels_label_idx` ON `issue_labels` (`label_id`);--> statement-breakpoint
CREATE TABLE `issue_relations` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`issue_id` text NOT NULL,
	`related_issue_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_relations_pair_idx` ON `issue_relations` (`issue_id`,`related_issue_id`,`type`);--> statement-breakpoint
CREATE INDEX `issue_relations_related_idx` ON `issue_relations` (`related_issue_id`);--> statement-breakpoint
CREATE TABLE `issues` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`state_id` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`estimate` integer,
	`assignee_id` text,
	`creator_id` text,
	`parent_id` text,
	`due_date` text,
	`sort_order` real NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`canceled_at` integer,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issues_team_number_idx` ON `issues` (`team_id`,`number`);--> statement-breakpoint
CREATE INDEX `issues_state_idx` ON `issues` (`state_id`);--> statement-breakpoint
CREATE INDEX `issues_assignee_idx` ON `issues` (`assignee_id`);--> statement-breakpoint
CREATE INDEX `issues_parent_idx` ON `issues` (`parent_id`);--> statement-breakpoint
CREATE INDEX `issues_updated_idx` ON `issues` (`updated_at`);--> statement-breakpoint
CREATE TABLE `reactions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`emoji` text NOT NULL,
	`comment_id` text,
	`issue_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `reactions_comment_idx` ON `reactions` (`comment_id`);--> statement-breakpoint
CREATE INDEX `reactions_issue_idx` ON `reactions` (`issue_id`);--> statement-breakpoint
CREATE INDEX `reactions_user_idx` ON `reactions` (`user_id`);
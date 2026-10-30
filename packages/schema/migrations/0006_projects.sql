CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`icon` text,
	`project_id` text,
	`initiative_id` text,
	`creator_id` text,
	`updated_by_id` text,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `documents_project_idx` ON `documents` (`project_id`);--> statement-breakpoint
CREATE INDEX `documents_updated_idx` ON `documents` (`updated_at`);--> statement-breakpoint
CREATE TABLE `initiatives` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'planned' NOT NULL,
	`owner_id` text,
	`target_date` text,
	`sort_order` real NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project_milestones` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`target_date` text,
	`sort_order` real NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `project_milestones_project_idx` ON `project_milestones` (`project_id`);--> statement-breakpoint
CREATE TABLE `project_teams` (
	`project_id` text NOT NULL,
	`team_id` text NOT NULL,
	PRIMARY KEY(`project_id`, `team_id`)
);
--> statement-breakpoint
CREATE INDEX `project_teams_team_idx` ON `project_teams` (`team_id`);--> statement-breakpoint
CREATE TABLE `project_updates` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`body` text NOT NULL,
	`health` text NOT NULL,
	`edited_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `project_updates_project_idx` ON `project_updates` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`summary` text,
	`description` text,
	`icon` text,
	`color` text NOT NULL,
	`state` text DEFAULT 'planned' NOT NULL,
	`lead_id` text,
	`initiative_id` text,
	`creator_id` text,
	`start_date` text,
	`target_date` text,
	`sort_order` real NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`canceled_at` integer,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `projects_initiative_idx` ON `projects` (`initiative_id`);--> statement-breakpoint
ALTER TABLE `issues` ADD `project_id` text;--> statement-breakpoint
ALTER TABLE `issues` ADD `project_milestone_id` text;--> statement-breakpoint
CREATE INDEX `issues_project_idx` ON `issues` (`project_id`);--> statement-breakpoint
ALTER TABLE `notifications` ADD `project_id` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `project_update_id` text;
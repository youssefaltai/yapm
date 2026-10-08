CREATE TABLE `custom_views` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`icon` text,
	`color` text,
	`filter_data` text NOT NULL,
	`team_id` text,
	`owner_id` text NOT NULL,
	`shared` integer DEFAULT true NOT NULL,
	`sort_order` real NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cycles` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`number` integer NOT NULL,
	`name` text,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`completed_at` integer,
	`history` text NOT NULL,
	`uncompleted_count` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cycles_team_number_idx` ON `cycles` (`team_id`,`number`);--> statement-breakpoint
ALTER TABLE `issues` ADD `cycle_id` text;--> statement-breakpoint
CREATE INDEX `issues_cycle_idx` ON `issues` (`cycle_id`);--> statement-breakpoint
ALTER TABLE `teams` ADD `triage_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `teams` ADD `cycles_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `teams` ADD `cycle_duration` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `teams` ADD `cycle_start_day` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `teams` ADD `cycle_cooldown` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `teams` ADD `upcoming_cycle_count` integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE `teams` ADD `cycle_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `timezone` text DEFAULT 'UTC' NOT NULL;
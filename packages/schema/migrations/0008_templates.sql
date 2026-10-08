CREATE TABLE `templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`type` text DEFAULT 'issue' NOT NULL,
	`team_id` text NOT NULL,
	`template_data` text NOT NULL,
	`schedule` text,
	`next_run_at` integer,
	`last_run_at` integer,
	`creator_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `templates_team_idx` ON `templates` (`team_id`);--> statement-breakpoint
CREATE INDEX `templates_next_idx` ON `templates` (`next_run_at`);
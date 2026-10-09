CREATE TABLE `metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`numerator` text NOT NULL,
	`denominator` text,
	`unit` text,
	`target` real,
	`direction` text,
	`creator_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `metrics_name_idx` ON `metrics` (`name`) WHERE archived_at is null;
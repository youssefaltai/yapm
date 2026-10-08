CREATE TABLE `metric_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text DEFAULT '' NOT NULL,
	`counts` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `metric_snapshots_day_idx` ON `metric_snapshots` (`scope`,`scope_id`,`date`);
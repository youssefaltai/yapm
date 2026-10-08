ALTER TABLE `issues` ADD `sla_started_at` integer;--> statement-breakpoint
ALTER TABLE `issues` ADD `sla_breaches_at` integer;--> statement-breakpoint
ALTER TABLE `issues` ADD `sla_breached_at` integer;--> statement-breakpoint
CREATE INDEX `issues_sla_idx` ON `issues` (`sla_breaches_at`);--> statement-breakpoint
ALTER TABLE `teams` ADD `sla_hours` text;--> statement-breakpoint
ALTER TABLE `teams` ADD `auto_archive_period` integer DEFAULT 6 NOT NULL;
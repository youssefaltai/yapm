ALTER TABLE `runs` ADD `model` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `effort` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `route_rule` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `cost_usd` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `model_floor` text DEFAULT 'small' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `model_ceiling` text DEFAULT 'top' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `top_runs_per_week` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `model_routing` text;
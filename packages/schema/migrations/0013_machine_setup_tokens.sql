CREATE TABLE `machine_setup_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`created_by_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`machine_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machine_setup_tokens_hash_idx` ON `machine_setup_tokens` (`token_hash`);
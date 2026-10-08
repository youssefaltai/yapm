CREATE TABLE `machines` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`pairing_code` text NOT NULL,
	`token_hash` text NOT NULL,
	`tags` text NOT NULL,
	`mcps` text NOT NULL,
	`capacity` integer DEFAULT 2 NOT NULL,
	`version` text,
	`last_seen_at` integer,
	`approved_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machines_token_idx` ON `machines` (`token_hash`);--> statement-breakpoint
CREATE TABLE `run_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`events` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_logs_run_seq_idx` ON `run_logs` (`run_id`,`seq`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`issue_id` text,
	`trigger` text,
	`goal` text,
	`model_tier` text DEFAULT 'standard' NOT NULL,
	`not_before` integer,
	`machine_id` text,
	`session_id` text,
	`resume_of_run_id` text,
	`result` text,
	`error` text,
	`stop_requested_at` integer,
	`stop_reason` text,
	`stopped_by_id` text,
	`waiting_on_request_id` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`num_turns` integer DEFAULT 0 NOT NULL,
	`log_count` integer DEFAULT 0 NOT NULL,
	`started_at` integer,
	`heartbeat_at` integer,
	`ended_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `runs_status_idx` ON `runs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `runs_agent_idx` ON `runs` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `runs_issue_idx` ON `runs` (`issue_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `api_tokens` ADD `expires_at` integer;--> statement-breakpoint
ALTER TABLE `api_tokens` ADD `run_id` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `dispatched_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `runner_tags` text;
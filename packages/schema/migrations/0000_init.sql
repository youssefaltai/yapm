CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_hash_idx` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `api_tokens_user_idx` ON `api_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text,
	`run_id` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`data` text,
	`reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_events_entity_idx` ON `audit_events` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_events_actor_idx` ON `audit_events` (`actor_id`);--> statement-breakpoint
CREATE INDEX `audit_events_created_idx` ON `audit_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `auth_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`challenge` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `labels` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `labels_team_idx` ON `labels` (`team_id`);--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer NOT NULL,
	`transports` text,
	`name` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE INDEX `passkeys_user_idx` ON `passkeys` (`user_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `team_memberships` (
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`team_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `team_memberships_user_idx` ON `team_memberships` (`user_id`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`icon` text,
	`color` text,
	`lead_id` text,
	`issue_count` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_key_unique` ON `teams` (`key`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`display_name` text NOT NULL,
	`email` text,
	`title` text,
	`avatar_url` text,
	`manager_id` text,
	`charter` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `users_manager_idx` ON `users` (`manager_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_single_owner_idx` ON `users` (`kind`) WHERE kind = 'owner';--> statement-breakpoint
CREATE TABLE `workflow_states` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`color` text NOT NULL,
	`description` text,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workflow_states_team_idx` ON `workflow_states` (`team_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_url_key_unique` ON `workspaces` (`url_key`);
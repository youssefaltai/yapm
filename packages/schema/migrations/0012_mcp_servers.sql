CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`machine_id` text NOT NULL,
	`name` text NOT NULL,
	`transport` text NOT NULL,
	`url` text,
	`command` text,
	`args` text,
	`agent_ids` text,
	`status` text DEFAULT 'installing' NOT NULL,
	`status_detail` text,
	`auth_url` text,
	`auth_state` text,
	`auth_code` text,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_servers_machine_name_idx` ON `mcp_servers` (`machine_id`,`name`);--> statement-breakpoint
CREATE INDEX `mcp_servers_state_idx` ON `mcp_servers` (`auth_state`);
CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text,
	`command` text,
	`args` text,
	`auth` text NOT NULL,
	`secret_env` text,
	`how_to_connect` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`secret` text,
	`oauth` text,
	`request_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_servers_name_unique` ON `mcp_servers` (`name`);
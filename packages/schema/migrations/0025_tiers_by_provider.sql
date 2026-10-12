ALTER TABLE `machines` ADD `providers` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `provider` text;--> statement-breakpoint
ALTER TABLE `users` ADD `models` text;--> statement-breakpoint
UPDATE `workspaces` SET `model_routing` = json_set(`model_routing`, '$.tiers.small.provider', 'anthropic', '$.tiers.standard.provider', 'anthropic', '$.tiers.top.provider', 'anthropic') WHERE `model_routing` IS NOT NULL;--> statement-breakpoint
UPDATE `runs` SET `provider` = 'anthropic' WHERE `engine` IS NULL OR `engine` = 'claude';--> statement-breakpoint
UPDATE `runs` SET `provider` = substr(`model`, 1, instr(`model`, '/') - 1), `model` = substr(`model`, instr(`model`, '/') + 1) WHERE `engine` = 'opencode' AND instr(`model`, '/') > 0;

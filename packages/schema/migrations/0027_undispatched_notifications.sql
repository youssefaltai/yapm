CREATE INDEX `notifications_undispatched_idx` ON `notifications` (`created_at`) WHERE "notifications"."dispatched_at" is null;--> statement-breakpoint
-- Earlier notifications were looked at when they were made; only new ones wait for the sweep.
UPDATE `notifications` SET `dispatched_at` = `created_at` WHERE `dispatched_at` IS NULL;

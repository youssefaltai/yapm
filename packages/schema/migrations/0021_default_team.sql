-- Companies started without a team; every issue needs one, as in Linear, so a company without
-- one gets the team setup now creates: named after it, keyed like suggestKey, with the owner
-- and the CEO as members, Linear's default states and its audit entry. The new team carries a
-- marker in its description until the last statement, so the others find it and only it.
INSERT INTO `teams` (`id`, `key`, `name`, `description`, `created_at`, `updated_at`)
WITH RECURSIVE
  `company` AS (
    SELECT `name`, upper(`name`) || ' ' AS `n` FROM `workspaces`
    ORDER BY `created_at` LIMIT 1
  ),
  -- The name's characters, each marked as part of a word (a letter or digit) or not.
  `chars` (`i`, `c`, `word`) AS (
    SELECT 1, substr(`n`, 1, 1), substr(`n`, 1, 1) GLOB '[A-Z0-9]' FROM `company`
    UNION ALL
    SELECT `i` + 1, substr(`n`, `i` + 1, 1), substr(`n`, `i` + 1, 1) GLOB '[A-Z0-9]'
    FROM `chars`, `company` WHERE `i` < length(`n`)
  ),
  -- Walks them in order, keeping each word's initial and the whole first word.
  `walk` (`i`, `initials`, `first`, `apart`) AS (
    SELECT 1, '', '', 1
    UNION ALL
    SELECT `walk`.`i` + 1,
      CASE WHEN `word` AND `apart` THEN `initials` || `c` ELSE `initials` END,
      CASE WHEN `word` AND (`initials` = '' OR (length(`initials`) = 1 AND NOT `apart`))
        THEN `first` || `c` ELSE `first` END,
      NOT `word`
    FROM `walk` JOIN `chars` ON `chars`.`i` = `walk`.`i`
  ),
  `picked` AS (
    SELECT CASE WHEN length(`initials`) >= 2 THEN `initials`
      ELSE substr(CASE WHEN `first` = '' THEN 'TEAM' ELSE `first` END, 1, 3) END AS `k`
    FROM `walk` ORDER BY `i` DESC LIMIT 1
  ),
  `uuid` AS (SELECT lower(hex(randomblob(16))) AS `h`)
SELECT
  substr(`h`, 1, 8) || '-' || substr(`h`, 9, 4) || '-4' || substr(`h`, 14, 3) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) || substr(`h`, 18, 3) || '-' || substr(`h`, 21, 12),
  CASE WHEN substr(`k`, 1, 1) BETWEEN 'A' AND 'Z' THEN substr(`k`, 1, 7) ELSE substr('T' || `k`, 1, 7) END,
  `name`,
  '0021_default_team',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM `company`, `picked`, `uuid`
WHERE NOT EXISTS (SELECT 1 FROM `teams`);
--> statement-breakpoint
INSERT INTO `team_memberships` (`team_id`, `user_id`, `created_at`)
SELECT `t`.`id`, `u`.`id`, `t`.`created_at`
FROM `teams` `t`, `users` `u`
WHERE `t`.`description` = '0021_default_team'
  AND (`u`.`kind` = 'owner' OR `u`.`id` = (
    SELECT `c`.`id` FROM `users` `c` JOIN `users` `o` ON `o`.`id` = `c`.`manager_id`
    WHERE `c`.`kind` = 'agent' AND `o`.`kind` = 'owner' ORDER BY `c`.`created_at` LIMIT 1
  ));
--> statement-breakpoint
INSERT INTO `workflow_states` (`id`, `team_id`, `name`, `type`, `color`, `position`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(16))), `t`.`id`, `v`.`column1`, `v`.`column2`, `v`.`column3`, `v`.`column4`,
  `t`.`created_at`, `t`.`created_at`
FROM `teams` `t`, (VALUES
  ('Triage', 'triage', '#fc7840', 0),
  ('Backlog', 'backlog', '#bec2c8', 1),
  ('Todo', 'unstarted', '#e2e2e2', 2),
  ('In Progress', 'started', '#f2c94c', 3),
  ('In Review', 'started', '#0f973d', 4),
  ('Done', 'completed', '#5e6ad2', 5),
  ('Canceled', 'canceled', '#95a2b3', 6),
  ('Duplicate', 'canceled', '#95a2b3', 7)
) `v`
WHERE `t`.`description` = '0021_default_team';
--> statement-breakpoint
INSERT INTO `audit_events` (`id`, `actor_id`, `action`, `entity_type`, `entity_id`, `data`, `created_at`)
SELECT lower(hex(randomblob(16))), (SELECT `id` FROM `users` WHERE `kind` = 'owner'), 'team.create',
  'team', `t`.`id`, json_object('key', `t`.`key`, 'name', `t`.`name`, 'leadId', NULL), `t`.`created_at`
FROM `teams` `t`
WHERE `t`.`description` = '0021_default_team';
--> statement-breakpoint
UPDATE `teams` SET `description` = NULL WHERE `description` = '0021_default_team';

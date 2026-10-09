-- Defaults saved while the palette was grey get Linear's colours back; chosen colours stay.
UPDATE `workflow_states` SET `color` = CASE
  WHEN `type` = 'triage' THEN '#fc7840'
  WHEN `type` = 'backlog' THEN '#bec2c8'
  WHEN `type` = 'unstarted' THEN '#e2e2e2'
  WHEN `type` = 'started' AND `name` = 'In Review' THEN '#0f973d'
  WHEN `type` = 'started' THEN '#f2c94c'
  WHEN `type` = 'completed' THEN '#5e6ad2'
  ELSE '#95a2b3'
END
WHERE (`type`, `color`) IN (
  VALUES ('triage', '#8b8b90'), ('backlog', '#6c6c71'), ('unstarted', '#8b8b90'),
    ('started', '#aaaaae'), ('completed', '#d0d0d3'), ('canceled', '#5e5e63')
);
--> statement-breakpoint
UPDATE `labels` SET `color` = json_extract(
  '["#5e6ad2","#26b5ce","#4cb782","#f2c94c","#f2994a","#eb5757","#bb87fc"]',
  '$[' || (length(`name`) % 7) || ']'
) WHERE `color` = '#bec2c8';
--> statement-breakpoint
UPDATE `projects` SET `color` = json_extract(
  '["#5e6ad2","#26b5ce","#4cb782","#f2c94c","#f2994a","#eb5757","#bb87fc"]',
  '$[' || (CAST(`sort_order` AS INTEGER) % 7) || ']'
) WHERE `color` = '#8b8b90';

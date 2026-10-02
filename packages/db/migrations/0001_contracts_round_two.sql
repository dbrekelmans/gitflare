CREATE TABLE `cloud_session_events` (
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`body` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `seq`)
);
--> statement-breakpoint
CREATE TABLE `revision_reviews` (
	`revision_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`change_id` text NOT NULL,
	`findings` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`revision_id`, `attempt`)
);
--> statement-breakpoint
CREATE INDEX `revision_reviews_change` ON `revision_reviews` (`change_id`);--> statement-breakpoint
CREATE TABLE `session_launches` (
	`session_id` text PRIMARY KEY NOT NULL,
	`prompt` text NOT NULL,
	`requested_at` integer NOT NULL,
	`launched_at` integer
);
--> statement-breakpoint
ALTER TABLE `ci_runs` ADD `reason` text;--> statement-breakpoint
ALTER TABLE `decision_events` ADD `wording` text;--> statement-breakpoint
-- Earlier events recorded the statement only. The title and rationale they
-- changed are not recoverable, so the decision's current ones stand in.
UPDATE `decision_events` SET `wording` = json_object(
	'before', json_object('title', coalesce((SELECT `title` FROM `decisions` WHERE `decisions`.`id` = `decision_events`.`decision_id`), ''), 'statement', `statement_before`, 'rationale', coalesce((SELECT `rationale` FROM `decisions` WHERE `decisions`.`id` = `decision_events`.`decision_id`), '')),
	'after', json_object('title', coalesce((SELECT `title` FROM `decisions` WHERE `decisions`.`id` = `decision_events`.`decision_id`), ''), 'statement', `statement_after`, 'rationale', coalesce((SELECT `rationale` FROM `decisions` WHERE `decisions`.`id` = `decision_events`.`decision_id`), ''))
) WHERE `statement_before` IS NOT NULL AND `statement_after` IS NOT NULL AND `statement_before` <> `statement_after`;--> statement-breakpoint
ALTER TABLE `decision_events` DROP COLUMN `statement_before`;--> statement-breakpoint
ALTER TABLE `decision_events` DROP COLUMN `statement_after`;--> statement-breakpoint
-- SQLite cannot add a NOT NULL column without a default. Existing versions
-- take their version number as the attempt, which is unique per revision.
ALTER TABLE `intents` ADD `attempt` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
UPDATE `intents` SET `attempt` = `version`;--> statement-breakpoint
CREATE UNIQUE INDEX `intents_revision_attempt` ON `intents` (`revision_id`,`attempt`);--> statement-breakpoint
ALTER TABLE `repositories` ADD `import_failed_at` integer;--> statement-breakpoint
ALTER TABLE `repositories` ADD `import_error` text;--> statement-breakpoint
ALTER TABLE `sections` ADD `stats` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `learned_at` integer;
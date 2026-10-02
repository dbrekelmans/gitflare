CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`change_id` text NOT NULL,
	`section_id` text NOT NULL,
	`user_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`withdrawn_at` integer,
	`withdrawn_reason` text
);
--> statement-breakpoint
CREATE INDEX `approvals_change` ON `approvals` (`change_id`);--> statement-breakpoint
CREATE INDEX `approvals_section` ON `approvals` (`section_id`);--> statement-breakpoint
CREATE TABLE `captured_sessions` (
	`change_id` text NOT NULL,
	`agent_session_id` text NOT NULL,
	`agent` text NOT NULL,
	`model` text,
	`checkpoint_ids` text NOT NULL,
	`turn_count` integer NOT NULL,
	`attribution` text,
	PRIMARY KEY(`change_id`, `agent_session_id`)
);
--> statement-breakpoint
CREATE TABLE `change_commits` (
	`change_id` text NOT NULL,
	`sha` text NOT NULL,
	`revision_id` text NOT NULL,
	`position` integer NOT NULL,
	`message` text NOT NULL,
	`author_name` text NOT NULL,
	`author_email` text NOT NULL,
	`authored_at` integer NOT NULL,
	`checkpoint_ids` text NOT NULL,
	PRIMARY KEY(`change_id`, `sha`)
);
--> statement-breakpoint
CREATE TABLE `change_decisions` (
	`change_id` text NOT NULL,
	`decision_id` text NOT NULL,
	`relation` text NOT NULL,
	`similarity` real NOT NULL,
	`thread_id` text,
	PRIMARY KEY(`change_id`, `decision_id`)
);
--> statement-breakpoint
CREATE TABLE `change_events` (
	`change_id` text NOT NULL,
	`seq` integer NOT NULL,
	`body` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`change_id`, `seq`)
);
--> statement-breakpoint
CREATE TABLE `changes` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`session_id` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`author_id` text NOT NULL,
	`head_ref` text NOT NULL,
	`base_sha` text NOT NULL,
	`head_sha` text NOT NULL,
	`head_revision_id` text NOT NULL,
	`opened_at` integer NOT NULL,
	`ready_at` integer,
	`merged_at` integer,
	`merged_by` text,
	`merge_sha` text,
	`closed_at` integer,
	`last_event_seq` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `changes_session` ON `changes` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `changes_repository_number` ON `changes` (`repository_id`,`number`);--> statement-breakpoint
CREATE INDEX `changes_status` ON `changes` (`status`,`opened_at`);--> statement-breakpoint
CREATE INDEX `changes_author` ON `changes` (`author_id`,`status`);--> statement-breakpoint
CREATE TABLE `checkpoints` (
	`repository_id` text NOT NULL,
	`checkpoint_id` text NOT NULL,
	`ref` text NOT NULL,
	`tip_sha` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`repository_id`, `checkpoint_id`)
);
--> statement-breakpoint
CREATE TABLE `ci_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`change_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`stage_run_id` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ci_runs_stage_run` ON `ci_runs` (`stage_run_id`);--> statement-breakpoint
CREATE INDEX `ci_runs_change` ON `ci_runs` (`change_id`);--> statement-breakpoint
CREATE TABLE `ci_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	`command` text NOT NULL,
	`status` text NOT NULL,
	`exit_code` integer,
	`started_at` integer,
	`finished_at` integer,
	`log_tail` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ci_steps_run_name` ON `ci_steps` (`run_id`,`name`);--> statement-breakpoint
CREATE TABLE `decision_events` (
	`id` text PRIMARY KEY NOT NULL,
	`decision_id` text NOT NULL,
	`kind` text NOT NULL,
	`change_id` text,
	`thread_id` text,
	`user_id` text,
	`strength_before` real NOT NULL,
	`strength_after` real NOT NULL,
	`statement_before` text,
	`statement_after` text,
	`note` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `decision_events_decision` ON `decision_events` (`decision_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`path` text NOT NULL,
	`title` text NOT NULL,
	`statement` text NOT NULL,
	`rationale` text DEFAULT '' NOT NULL,
	`scope` text NOT NULL,
	`status` text NOT NULL,
	`strength` real NOT NULL,
	`origin` text NOT NULL,
	`origin_change_id` text,
	`origin_thread_id` text,
	`file_sha` text,
	`embedding` text,
	`embedding_model` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `decisions_repository_path` ON `decisions` (`repository_id`,`path`);--> statement-breakpoint
CREATE INDEX `decisions_repository_status` ON `decisions` (`repository_id`,`status`);--> statement-breakpoint
CREATE TABLE `git_tokens` (
	`token_id` text PRIMARY KEY NOT NULL,
	`repo_name` text NOT NULL,
	`user_id` text,
	`session_id` text,
	`scope` text NOT NULL,
	`purpose` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE INDEX `git_tokens_repo` ON `git_tokens` (`repo_name`);--> statement-breakpoint
CREATE INDEX `git_tokens_user` ON `git_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `intents` (
	`id` text PRIMARY KEY NOT NULL,
	`change_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`version` integer NOT NULL,
	`statement` text NOT NULL,
	`grade` text NOT NULL,
	`checkpoint_ids` text NOT NULL,
	`model` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `intents_change_version` ON `intents` (`change_id`,`version`);--> statement-breakpoint
CREATE TABLE `model_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`agent` text NOT NULL,
	`user_id` text,
	`repository_id` text,
	`change_id` text,
	`session_id` text,
	`model` text NOT NULL,
	`requested_model` text NOT NULL,
	`gateway_log_id` text,
	`usage` text NOT NULL,
	`cost_micro_usd` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `model_calls_change` ON `model_calls` (`change_id`);--> statement-breakpoint
CREATE INDEX `model_calls_created` ON `model_calls` (`created_at`);--> statement-breakpoint
CREATE TABLE `organisations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`settings` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organisations_slug_unique` ON `organisations` (`slug`);--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`slug` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`head_sha` text,
	`capture_enabled` integer DEFAULT false NOT NULL,
	`next_change_number` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_slug` ON `repositories` (`slug`);--> statement-breakpoint
CREATE TABLE `revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`change_id` text NOT NULL,
	`number` integer NOT NULL,
	`base_sha` text NOT NULL,
	`head_sha` text NOT NULL,
	`pushed_at` integer NOT NULL,
	`commits` integer NOT NULL,
	`files_changed` integer NOT NULL,
	`insertions` integer NOT NULL,
	`deletions` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `revisions_change_number` ON `revisions` (`change_id`,`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `revisions_change_head` ON `revisions` (`change_id`,`head_sha`);--> statement-breakpoint
CREATE TABLE `sections` (
	`id` text PRIMARY KEY NOT NULL,
	`change_id` text NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`explanation` text NOT NULL,
	`files` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_revision_id` text NOT NULL,
	`updated_revision_id` text NOT NULL,
	`removed_at` integer
);
--> statement-breakpoint
CREATE INDEX `sections_change` ON `sections` (`change_id`,`position`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`title` text NOT NULL,
	`fork_repo` text NOT NULL,
	`base_sha` text NOT NULL,
	`created_at` integer NOT NULL,
	`ended_at` integer,
	`fork_deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_fork_repo` ON `sessions` (`fork_repo`);--> statement-breakpoint
CREATE INDEX `sessions_user` ON `sessions` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `sessions_repository` ON `sessions` (`repository_id`,`status`);--> statement-breakpoint
CREATE TABLE `stage_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`change_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`stage` text NOT NULL,
	`attempt` integer NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`started_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stage_runs_attempt` ON `stage_runs` (`revision_id`,`stage`,`attempt`);--> statement-breakpoint
CREATE INDEX `stage_runs_change` ON `stage_runs` (`change_id`);--> statement-breakpoint
CREATE TABLE `thread_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`seq` integer NOT NULL,
	`author_kind` text NOT NULL,
	`author_user_id` text,
	`body` text NOT NULL,
	`action` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_messages_seq` ON `thread_messages` (`thread_id`,`seq`);--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`change_id` text NOT NULL,
	`section_id` text,
	`kind` text NOT NULL,
	`origin` text NOT NULL,
	`status` text NOT NULL,
	`finding` text,
	`anchor` text,
	`anchor_revision_id` text,
	`dismissal` text,
	`decision_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`settled_at` integer,
	`settled_by` text,
	`message_count` integer DEFAULT 0 NOT NULL,
	`last_message_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `threads_change` ON `threads` (`change_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`subject` text NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_subject` ON `users` (`subject`);--> statement-breakpoint
CREATE INDEX `users_email` ON `users` (`email`);
CREATE TABLE `agent_event_index` (
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`file_offset` integer NOT NULL,
	`summary` text NOT NULL,
	`ts` integer NOT NULL,
	PRIMARY KEY(`run_id`, `seq`),
	FOREIGN KEY (`run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `agent_run` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`adapter` text NOT NULL,
	`mode` text NOT NULL,
	`title` text,
	`prompt` text NOT NULL,
	`state` text NOT NULL,
	`worktree_id` text,
	`pid` integer,
	`pid_start_token` text,
	`external_session_id` text,
	`run_dir` text NOT NULL,
	`last_seq` integer DEFAULT 0 NOT NULL,
	`cancel_requested` integer DEFAULT 0 NOT NULL,
	`detail_purged` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`end_reason` text,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktree`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `run_state_idx` ON `agent_run` (`state`);--> statement-breakpoint
CREATE INDEX `run_project_idx` ON `agent_run` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `approval` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`tool` text NOT NULL,
	`detail` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by` text,
	FOREIGN KEY (`run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `approval_run_idx` ON `approval` (`run_id`,`status`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`detail_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `core_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`type` text NOT NULL,
	`scope_json` text NOT NULL,
	`payload_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`root_path` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_opened_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_root_path_unique` ON `project` (`root_path`);--> statement-breakpoint
CREATE TABLE `setting` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `worktree` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`branch` text NOT NULL,
	`path` text NOT NULL,
	`base_commit` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `worktree_project_idx` ON `worktree` (`project_id`,`status`);
CREATE TABLE `auth_challenges` (
	`email` text PRIMARY KEY NOT NULL,
	`code_digest` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_challenges_expiry_idx` ON `auth_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `auth_rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_rate_limits_window_idx` ON `auth_rate_limits` (`window_start`);--> statement-breakpoint
CREATE TABLE `inboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`imap_host` text NOT NULL,
	`imap_port` integer NOT NULL,
	`imap_username` text NOT NULL,
	`smtp_host` text NOT NULL,
	`smtp_port` integer NOT NULL,
	`smtp_username` text NOT NULL,
	`separate_smtp_credentials` integer NOT NULL,
	`encrypted_credentials` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inboxes_user_email_idx` ON `inboxes` (`user_id`,`email`);--> statement-breakpoint
CREATE TABLE `send_receipts` (
	`user_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`inbox_id` text NOT NULL,
	`status` text NOT NULL,
	`sent_copy` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `submission_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inbox_id`) REFERENCES `inboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `send_receipts_expiry_idx` ON `send_receipts` (`expires_at`);--> statement-breakpoint
CREATE INDEX `send_receipts_inbox_idx` ON `send_receipts` (`inbox_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_digest` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expiry_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);
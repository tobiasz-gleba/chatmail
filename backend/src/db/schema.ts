import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const appMetadata = sqliteTable("app_metadata", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  createdAt: integer("created_at").notNull(),
});

export const authChallenges = sqliteTable("auth_challenges", {
  email: text("email").primaryKey(),
  codeDigest: text("code_digest").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
}, table => [index("auth_challenges_expiry_idx").on(table.expiresAt)]);

export const authRateLimits = sqliteTable("auth_rate_limits", {
  key: text("key").primaryKey(),
  windowStart: integer("window_start").notNull(),
  count: integer("count").notNull(),
}, table => [index("auth_rate_limits_window_idx").on(table.windowStart)]);

export const sessions = sqliteTable("sessions", {
  tokenDigest: text("token_digest").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, table => [
  index("sessions_user_idx").on(table.userId),
  index("sessions_expiry_idx").on(table.expiresAt),
]);

export const inboxes = sqliteTable("inboxes", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  imapHost: text("imap_host").notNull(),
  imapPort: integer("imap_port").notNull(),
  imapUsername: text("imap_username").notNull(),
  smtpHost: text("smtp_host").notNull(),
  smtpPort: integer("smtp_port").notNull(),
  smtpUsername: text("smtp_username").notNull(),
  separateSmtpCredentials: integer("separate_smtp_credentials", { mode: "boolean" }).notNull(),
  encryptedCredentials: text("encrypted_credentials").notNull(),
}, table => [uniqueIndex("inboxes_user_email_idx").on(table.userId, table.email)]);

export const sendReceipts = sqliteTable("send_receipts", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  submissionId: text("submission_id").notNull(),
  inboxId: text("inbox_id").notNull().references(() => inboxes.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  sentCopy: integer("sent_copy", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, table => [
  primaryKey({ columns: [table.userId, table.submissionId] }),
  index("send_receipts_expiry_idx").on(table.expiresAt),
  index("send_receipts_inbox_idx").on(table.inboxId),
]);

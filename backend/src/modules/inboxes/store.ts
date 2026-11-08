import { and, asc, eq, getTableColumns, ne } from "drizzle-orm";
import { createDatabase } from "../../db/client";
import { inboxes } from "../../db/schema";
import type { Inbox } from "../../../../shared/contracts";
import { decryptCredentials, encryptCredentials, type Passwords } from "./credentials";

export type MailAccount = Inbox & Passwords;
type InboxRow = typeof inboxes.$inferSelect;
type SettingsRow = Omit<InboxRow, "encryptedCredentials" | "userId">;
const { userId: _owner, encryptedCredentials: _secret, ...settingsColumns } = getTableColumns(inboxes);

function toInbox(row: SettingsRow): Inbox {
  return {
    id: row.id, email: row.email,
    imap: { host: row.imapHost, port: row.imapPort, username: row.imapUsername },
    smtp: { host: row.smtpHost, port: row.smtpPort, username: row.smtpUsername },
    separateSmtpCredentials: row.separateSmtpCredentials,
  };
}

export async function listInboxes(env: Env, userId: string): Promise<Inbox[]> {
  const rows = await createDatabase(env.DB).select(settingsColumns).from(inboxes)
    .where(eq(inboxes.userId, userId)).orderBy(asc(inboxes.email));
  return rows.map(toInbox);
}

function owned(userId: string, id: string) {
  return and(eq(inboxes.userId, userId), eq(inboxes.id, id));
}

export async function getInbox(env: Env, userId: string, id: string): Promise<Inbox | null> {
  const row = await createDatabase(env.DB).select(settingsColumns).from(inboxes).where(owned(userId, id)).get();
  return row ? toInbox(row) : null;
}

export async function loadAccountVersion(env: Env, userId: string, id: string) {
  const row = await createDatabase(env.DB).select().from(inboxes).where(owned(userId, id)).get();
  if (!row) return null;
  const inbox = toInbox(row);
  const passwords = await decryptCredentials(env.MAIL_KEY, userId, inbox, row.encryptedCredentials);
  return { account: { ...inbox, ...passwords }, version: row.encryptedCredentials };
}

export async function getMailAccount(env: Env, userId: string, id: string): Promise<MailAccount | null> {
  return (await loadAccountVersion(env, userId, id))?.account ?? null;
}

export async function persistAccount(env: Env, userId: string, account: MailAccount, previousVersion?: string) {
  const { password, smtpPassword, ...inbox } = account;
  const stored = {
    id: inbox.id, userId, email: inbox.email,
    imapHost: inbox.imap.host, imapPort: inbox.imap.port, imapUsername: inbox.imap.username,
    smtpHost: inbox.smtp.host, smtpPort: inbox.smtp.port, smtpUsername: inbox.smtp.username,
    separateSmtpCredentials: inbox.separateSmtpCredentials,
    encryptedCredentials: await encryptCredentials(env.MAIL_KEY, userId, inbox, { password, smtpPassword }),
  };
  const db = createDatabase(env.DB);
  if (!previousVersion) {
    const created = await db.insert(inboxes).values(stored).onConflictDoNothing().returning({ id: inboxes.id }).get();
    return created ? inbox : null;
  }
  // A connection check can take time. Never replace newer settings or resurrect a disconnected inbox.
  try {
    const updated = await db.update(inboxes).set(stored)
      .where(and(owned(userId, inbox.id), eq(inboxes.encryptedCredentials, previousVersion)))
      .returning({ id: inboxes.id }).get();
    return updated ? inbox : null;
  } catch (error) {
    const duplicate = await db.select({ id: inboxes.id }).from(inboxes)
      .where(and(eq(inboxes.userId, userId), eq(inboxes.email, inbox.email), ne(inboxes.id, inbox.id))).get();
    if (duplicate) return null;
    throw error;
  }
}

export async function disconnectInbox(env: Env, userId: string, id: string): Promise<boolean> {
  const removed = await createDatabase(env.DB).delete(inboxes).where(owned(userId, id)).returning({ id: inboxes.id }).get();
  return Boolean(removed);
}

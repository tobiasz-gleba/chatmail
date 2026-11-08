import { and, eq, lte } from "drizzle-orm";
import { createDatabase } from "../../db/client";
import { sendReceipts } from "../../db/schema";

export const receiptLifetime = 24 * 60 * 60 * 1000;
export const pendingTimeout = 2 * 60 * 1000;
export type Receipt = typeof sendReceipts.$inferSelect;
type ReceiptStatus = "pending" | "sent" | "unconfirmed" | "failed" | "partial";

function matches(userId: string, submissionId: string) {
  return and(eq(sendReceipts.userId, userId), eq(sendReceipts.submissionId, submissionId));
}

export async function lookupReceipt(db: D1Database, userId: string, submissionId: string) {
  return createDatabase(db).select().from(sendReceipts).where(matches(userId, submissionId)).get();
}

export async function reserveReceipt(db: D1Database, userId: string, inboxId: string, submissionId: string) {
  const database = createDatabase(db);
  const now = Date.now();
  const issuedAt = Number(submissionId.split(".")[0]);
  await database.delete(sendReceipts).where(lte(sendReceipts.expiresAt, now));
  const row = await database.insert(sendReceipts).values({
    userId, inboxId, submissionId, status: "pending", createdAt: now,
    expiresAt: Math.max(now, issuedAt) + receiptLifetime,
  }).onConflictDoNothing().returning().get();
  return row;
}

export async function recordOutcome(db: D1Database, receipt: Receipt, status: ReceiptStatus, sentCopy = false) {
  await createDatabase(db).update(sendReceipts).set({ status, sentCopy })
    .where(matches(receipt.userId, receipt.submissionId));
}

export async function makeMessageId(secret: string, userId: string, submissionId: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`outbound-v1\0${userId}\0${submissionId}`));
  const local = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return `<${local}@chatmail.invalid>`;
}

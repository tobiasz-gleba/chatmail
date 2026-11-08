import { Hono, type Context } from "hono";
import type { SendInput, SendResult } from "@shared/contracts";
import { apiError, type AppEnv } from "../../http";
import { ensureSent, findSent, prepareMessage, SmtpSubmissionError, submitSmtp } from "../../mail/transport";
import { getMailAccount, listInboxes, type MailAccount } from "../inboxes/store";
import { resolveReplyTarget } from "../mail/reply";
import { MailRequestError } from "../mail/tokens";
import { InvalidMessage, makeMessage } from "./message";
import { lookupReceipt, makeMessageId, pendingTimeout, receiptLifetime, recordOutcome, reserveReceipt, type Receipt } from "./receipts";

const live = { ensureSent, findSent, prepareMessage, submitSmtp, getMailAccount, listInboxes, resolveReplyTarget };
type Delivery = typeof live;
type SendContext = Context<AppEnv>;
type Submission = Pick<SendInput, "inboxId" | "submissionId">;

function validSubmission(value: unknown): value is Submission {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<Submission>;
  return typeof input.inboxId === "string" && input.inboxId.length > 0 && input.inboxId.length <= 128 &&
    typeof input.submissionId === "string" &&
    /^\d{13}\.[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(input.submissionId);
}

function validDraft(value: Submission): value is SendInput {
  const input = value as Partial<SendInput>;
  return typeof input.body === "string" &&
    (input.replyToId === undefined || (typeof input.replyToId === "string" && !!input.replyToId)) &&
    (input.to === undefined || (Array.isArray(input.to) && input.to.every(address => typeof address === "string"))) &&
    (input.subject === undefined || typeof input.subject === "string");
}

async function receiptStatus(env: Env, delivery: Delivery, account: MailAccount, receipt: Receipt): Promise<SendResult> {
  if (receipt.status === "failed") return { status: "failed" };
  if (receipt.status === "sent" && receipt.sentCopy) return { status: "sent", sentCopy: true };
  if (receipt.status === "pending" && Date.now() - receipt.createdAt < pendingTimeout) return { status: "pending" };

  const status = receipt.status === "sent" ? "sent" : "unconfirmed";
  const partial = receipt.status === "partial";
  const messageId = await makeMessageId(env.AUTH_SECRET, receipt.userId, receipt.submissionId);
  let found: boolean;
  try {
    found = await delivery.findSent(account, messageId);
  } catch {
    return { status, partial, sentCopy: receipt.sentCopy, checkedSent: false };
  }
  if (found) {
    await recordOutcome(env.DB, receipt, partial ? "partial" : "sent", true);
    return { status: partial ? "unconfirmed" : "sent", partial, sentCopy: true, checkedSent: true };
  }
  // A missing Sent copy cannot establish that the SMTP server rejected the message.
  return { status, partial, sentCopy: false, checkedSent: true };
}

async function submit(c: SendContext, delivery: Delivery, input: SendInput, account: MailAccount) {
  const userId = c.get("user").id;
  const messageId = await makeMessageId(c.env.AUTH_SECRET, userId, input.submissionId);
  const parent = input.replyToId ? await delivery.resolveReplyTarget(c.env, userId, input.replyToId) : null;
  const identities = parent ? (await delivery.listInboxes(c.env, userId)).map(inbox => inbox.email) : [];
  const message = makeMessage(account.email, messageId, input, parent, identities);
  const raw = await delivery.prepareMessage(message);

  // Claim immediately before the irreversible step. Exactly one concurrent request may submit.
  const reserved = await reserveReceipt(c.env.DB, userId, account.id, input.submissionId);
  if (!reserved) {
    const existing = await lookupReceipt(c.env.DB, userId, input.submissionId);
    if (!existing || existing.inboxId !== account.id) {
      return apiError(c, 409, "SUBMISSION_CONFLICT", "This submission belongs to a different inbox.");
    }
    return c.json(await receiptStatus(c.env, delivery, account, existing));
  }

  let partial = false;
  try {
    await delivery.submitSmtp(account, message, raw);
  } catch (error) {
    partial = error instanceof SmtpSubmissionError && error.partial;
    if (!partial) {
      const status = error instanceof SmtpSubmissionError && !error.uncertain ? "failed" : "unconfirmed";
      await recordOutcome(c.env.DB, reserved, status);
      return c.json<SendResult>({ status });
    }
  }

  // Commit acceptance before IMAP. An append failure must never turn into another SMTP submission.
  const outcome = partial ? "partial" : "sent";
  await recordOutcome(c.env.DB, reserved, outcome);
  let sentCopy = false;
  try {
    await delivery.ensureSent(account, messageId, raw);
    sentCopy = true;
  } catch {
    // SMTP acceptance and preserving a copy are separate outcomes; status can recheck the mailbox.
  }
  if (sentCopy) await recordOutcome(c.env.DB, reserved, outcome, true);
  return c.json<SendResult>({ status: partial ? "unconfirmed" : "sent", partial, sentCopy });
}

export function createSendRoutes(delivery: Delivery = live) {
  async function handle(c: SendContext, checkOnly: boolean) {
    const input: unknown = await c.req.json().catch(() => null);
    if (!validSubmission(input)) return apiError(c, 400, "INVALID_SUBMISSION", "The submission ID or sending inbox is invalid.");
    const age = Date.now() - Number(input.submissionId.slice(0, 13));
    if (age >= receiptLifetime || age < -5 * 60_000) {
      return apiError(c, 410, "SUBMISSION_EXPIRED", "The submission has expired. Check your Sent folder.");
    }
    const userId = c.get("user").id;
    const account = await delivery.getMailAccount(c.env, userId, input.inboxId);
    if (!account) return apiError(c, 404, "INBOX_NOT_FOUND", "The sending inbox is unavailable.");
    const receipt = await lookupReceipt(c.env.DB, userId, input.submissionId);
    if (receipt) {
      if (receipt.inboxId !== account.id) return apiError(c, 409, "SUBMISSION_CONFLICT", "This submission belongs to a different inbox.");
      return c.json(await receiptStatus(c.env, delivery, account, receipt));
    }
    if (checkOnly) return apiError(c, 404, "SUBMISSION_NOT_FOUND", "No submission receipt was found.");
    if (!validDraft(input)) return apiError(c, 400, "INVALID_MESSAGE", "Check the recipients and message.");
    try {
      return await submit(c, delivery, input, account);
    } catch (error) {
      if (error instanceof InvalidMessage) return apiError(c, 400, "INVALID_MESSAGE", error.message);
      if (error instanceof MailRequestError) return apiError(c, error.status, error.code, error.message);
      throw error;
    }
  }
  return new Hono<AppEnv>().post("/send", c => handle(c, false)).post("/send/status", c => handle(c, true));
}

export const sendRoutes = createSendRoutes();

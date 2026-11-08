import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeAll, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/http";
import { prepareMessage, SmtpSubmissionError, type MailAccount, type OutgoingMail } from "../src/mail/transport";
import { getMailAccount, listInboxes, persistAccount } from "../src/modules/inboxes/store";
import { makeMessage } from "../src/modules/send/message";
import { createSendRoutes } from "../src/modules/send/routes";

const owner = { id: "send-owner", email: "me@example.net" };
const work = { id: "send-work", email: "work@example.com" };
const personal = { id: "send-personal", email: "personal@example.com" };
const parent = {
  from: { email: "ada@example.org" }, to: [{ email: work.email }, { email: "coauthor@example.org" }],
  cc: [{ email: personal.email }, { email: "reader@example.org" }, { email: "COAUTHOR@example.org" }],
  replyTo: [{ email: "ada-desk@example.org" }], subject: "Earlier topic",
  messageId: "<earlier@example.org>", references: ["<root@example.org>"], inReplyTo: "<root@example.org>",
  inboxIds: [work.id],
};

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare("INSERT INTO users(id,email,created_at) VALUES(?,?,?)").bind(owner.id, owner.email, Date.now()).run();
  for (const inbox of [work, personal]) {
    await persistAccount(env, owner.id, {
      ...inbox, imap: { host: "imap.example.org", port: 993, username: inbox.email },
      smtp: { host: "smtp.example.org", port: 465, username: inbox.email },
      separateSmtpCredentials: false, password: "test", smtpPassword: "test",
    });
  }
});

function fixture() {
  const deps = {
    getMailAccount, listInboxes,
    resolveReplyTarget: vi.fn(async () => parent),
    prepareMessage: vi.fn(prepareMessage),
    submitSmtp: vi.fn(async (_account: MailAccount, _message: OutgoingMail, _raw: Uint8Array) => {}),
    findSent: vi.fn(async () => false),
    ensureSent: vi.fn(async () => {}),
  };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", c.req.header("x-other-user") ? { id: "other", email: "other@example.com" } : owner);
    return next();
  });
  app.route("/api/mail", createSendRoutes(deps));
  const post = (path: string, data: unknown, other = false) =>
    app.request(`http://localhost/api/mail/${path}`, { method: "POST", headers: {
      "Content-Type": "application/json", ...(other ? { "x-other-user": "true" } : {}),
    }, body: JSON.stringify(data) }, env);
  const input = { submissionId: `${Date.now()}.${crypto.randomUUID()}`, inboxId: personal.id,
    body: "private reply", replyToId: "selected earlier message" };
  return { deps, post, input };
}

it("concurrent sends submit once, using the selected account and the selected parent's Reply-To, To, Cc and ancestry", async () => {
  const { deps, post, input } = fixture();
  const replies = await Promise.all([post("send", input), post("send", input)]);
  expect(replies.map(response => response.status)).toEqual([200, 200]);
  expect(deps.submitSmtp).toHaveBeenCalledTimes(1);
  expect(deps.ensureSent).toHaveBeenCalledTimes(1);
  expect(deps.submitSmtp).toHaveBeenCalledWith(expect.objectContaining(personal), expect.objectContaining({
    from: personal.email, to: ["ada-desk@example.org", "coauthor@example.org"], cc: ["reader@example.org"],
    subject: "Re: Earlier topic", inReplyTo: parent.messageId, references: [...parent.references, parent.messageId],
  }), expect.any(Uint8Array));
  const mime = new TextDecoder().decode(deps.submitSmtp.mock.calls[0][2]);
  expect(mime).toContain("From: personal@example.com\r\n");
  expect(mime).toContain("To: ada-desk@example.org, coauthor@example.org\r\n");
  expect(mime).toContain("Cc: reader@example.org\r\n");
  expect(mime).toContain("In-Reply-To: <earlier@example.org>\r\n");
  expect(mime).toContain("References: <root@example.org> <earlier@example.org>\r\n");
  expect(await (await post("send/status", input)).json()).toMatchObject({ status: "sent", sentCopy: true });
  const record = await env.DB.prepare("SELECT * FROM send_receipts WHERE submission_id=?").bind(input.submissionId).first();
  expect(JSON.stringify(record)).not.toMatch(/private reply|example\.org|Earlier topic|chatmail\.invalid/);
  expect((await post("send", { ...input, inboxId: work.id })).status).toBe(409);
});

it("checks the sending account's Sent folder after an interrupted submission and never submits the original operation again", async () => {
  const { deps, post, input } = fixture();
  deps.submitSmtp.mockRejectedValueOnce(new SmtpSubmissionError(true));
  expect(await (await post("send", input)).json()).toEqual({ status: "unconfirmed" });
  deps.findSent.mockRejectedValueOnce(new Error("unavailable"));
  expect(await (await post("send/status", input)).json()).toMatchObject({ status: "unconfirmed", checkedSent: false });
  expect(await (await post("send", input)).json()).toMatchObject({ status: "unconfirmed", checkedSent: true });
  deps.findSent.mockResolvedValue(true);
  expect(await (await post("send/status", input)).json()).toMatchObject({ status: "sent", sentCopy: true });
  const message = deps.prepareMessage.mock.calls[0][0];
  expect(deps.findSent).toHaveBeenCalledWith(expect.objectContaining(personal), message.messageId);
  expect(deps.submitSmtp).toHaveBeenCalledTimes(1);
  expect(deps.ensureSent).not.toHaveBeenCalled();
});

it("keeps accepted mail sent if the IMAP append fails and retains partial-recipient outcomes", async () => {
  const { deps, post, input } = fixture();
  deps.ensureSent.mockRejectedValueOnce(new Error("append unavailable"));
  expect(await (await post("send", input)).json()).toMatchObject({ status: "sent", sentCopy: false });
  deps.findSent.mockResolvedValue(true);
  expect(await (await post("send/status", input)).json()).toMatchObject({ status: "sent", sentCopy: true });
  const partial = { ...input, submissionId: `${Date.now()}.${crypto.randomUUID()}` };
  deps.submitSmtp.mockRejectedValueOnce(new SmtpSubmissionError(false, true));
  expect(await (await post("send", partial)).json()).toMatchObject({ status: "unconfirmed", partial: true });
  expect(await (await post("send", partial)).json()).toMatchObject({ status: "unconfirmed", partial: true });
  expect(deps.submitSmtp).toHaveBeenCalledTimes(2);
});

it("rejects another user's account, expired submission IDs, invalid recipients and subject injection before sending", async () => {
  const { deps, post, input } = fixture();
  expect((await post("send", input, true)).status).toBe(404);
  const expired = { ...input, submissionId: `${Date.now() - 25 * 3600_000}.${crypto.randomUUID()}` };
  expect((await post("send", expired)).status).toBe(410);
  expect((await post("send/status", input)).status).toBe(404);
  expect((await post("send", { ...input, replyToId: undefined, to: ["bad"], subject: "test" })).status).toBe(400);
  expect((await post("send", { ...input, replyToId: undefined, to: ["user@example.net"], subject: "Hi\r\nBcc: hidden@example.net" })).status).toBe(400);
  expect(deps.submitSmtp).not.toHaveBeenCalled();
});

it("replies to an outgoing email's external recipients, including when the source and sending inboxes differ", () => {
  const original = { ...parent, from: { email: work.email }, to: [{ email: "ada@example.org" }],
    replyTo: [{ email: "own-list@example.net" }], cc: [{ email: personal.email }, { email: "sam@example.net" }] };
  const outgoing = makeMessage(personal.email, "<new@example.org>", { body: "Another update" }, original, [personal.email, work.email]);
  expect(outgoing.to).toEqual(["ada@example.org"]);
  expect(outgoing.cc).toEqual(["sam@example.net"]);
});

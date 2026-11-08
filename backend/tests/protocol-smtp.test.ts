import { Readable } from "node:stream";
import SMTPConnection, { type SMTPConnectionSendInfo } from "nodemailer/lib/smtp-connection";
import { afterEach, expect, it, vi } from "vitest";
import type { MailAccount, OutgoingMail } from "../src/mail/protocol-types";
import { prepareMessage, submitSmtp, verifySmtp, type SmtpConnectionFactory } from "../src/mail/protocol-smtp";

const fixtureClient: SmtpConnectionFactory = options => new SMTPConnection(options);
const account: MailAccount = {
  id: "inbox", email: "me@example.com", password: "test-password", smtpPassword: "", separateSmtpCredentials: false,
  imap: { host: "mail.example.com", port: 993, username: "me" },
  smtp: { host: "smtp.example.com", port: 587, username: "me" },
};
const message: OutgoingMail = {
  from: account.email, to: ["one@example.com"], cc: ["two@example.com"], subject: "Re: café", text: ".body\r\nends",
  messageId: "<child@example.com>", inReplyTo: "<parent@example.com>", references: ["<root@example.com>", "<parent@example.com>"],
};
afterEach(() => vi.restoreAllMocks());

function handshake(secure = true) {
  vi.spyOn(SMTPConnection.prototype, "connect").mockImplementation(function (this: SMTPConnection, cb) {
    this.secure = secure;
    this.allowsAuth = true;
    cb?.();
  });
  return vi.spyOn(SMTPConnection.prototype, "login").mockImplementation((_auth, cb) => cb(null, true));
}

it("refuses authentication on an unencrypted connection, even when the server advertises AUTH", async () => {
  const login = handshake(false);
  await expect(verifySmtp(account, fixtureClient)).rejects.toMatchObject({ uncertain: false });
  expect(login).not.toHaveBeenCalled();
});

it("preserves the Message-ID and reply headers used to reconcile a submitted email", async () => {
  const mime = new TextDecoder().decode(await prepareMessage(message));
  expect(mime).toContain("Message-ID: <child@example.com>\r\n");
  expect(mime).toContain("In-Reply-To: <parent@example.com>\r\n");
  expect(mime).toContain("References: <root@example.com> <parent@example.com>\r\n");
});

it("distinguishes a pre-DATA error, a lost DATA acknowledgement, a rejection, and partial acceptance", async () => {
  handshake();
  const send = vi.spyOn(SMTPConnection.prototype, "send");
  const raw = await prepareMessage(message);
  const info: SMTPConnectionSendInfo = { accepted: [], rejected: [], response: "", messageSize: raw.length, envelopeTime: 0, messageTime: 0 };
  send.mockImplementationOnce((_env, _data, cb) => cb(new Error("lost"), info));
  await expect(submitSmtp(account, message, raw, fixtureClient)).rejects.toMatchObject({ uncertain: false, partial: false });

  for (const [afterDataError, uncertain] of [[new Error("lost"), true], [Object.assign(new Error("refused"), { responseCode: 550 }), false]] as const) {
    send.mockImplementationOnce((_env, data, cb) => {
      (data as Readable).on("end", () => cb(afterDataError, info)).resume();
    });
    await expect(submitSmtp(account, message, raw, fixtureClient)).rejects.toMatchObject({ uncertain, partial: false });
  }
  send.mockImplementationOnce((_env, _data, cb) => cb(null, { ...info, accepted: ["one@example.com"], rejected: ["two@example.com"] }));
  await expect(submitSmtp(account, message, raw, fixtureClient)).rejects.toMatchObject({ uncertain: false, partial: true });
});

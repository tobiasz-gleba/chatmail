import { Readable } from "node:stream";
import { createConnection } from "node:net";
import { connect as connectTls } from "node:tls";
import MailComposer from "nodemailer/lib/mail-composer";
import SMTPConnection, { type SMTPConnectionOptions } from "nodemailer/lib/smtp-connection";
import { assertPublicMailHost } from "./protocol-host";
import type { MailAccount, OutgoingMail } from "./protocol-types";

export class SmtpSubmissionError extends Error {
  constructor(readonly uncertain = false, readonly partial = false) {
    super(partial ? "Some recipients were rejected." : uncertain ? "SMTP acceptance is unknown." : "The SMTP server did not accept the operation.");
    this.name = "SmtpSubmissionError";
  }
}

type Submission = { input: OutgoingMail; raw: Uint8Array };
type DialOptions = SMTPConnectionOptions & { host: string; port: number };
export type SmtpConnectionFactory = (options: DialOptions) => SMTPConnection | Promise<SMTPConnection>;

// Workers validates TLS against the peer's dialed hostname. Let the runtime dial
// the original name, since Nodemailer's default DNS path can replace it with an IP.
export function connectSmtp(options: DialOptions): Promise<SMTPConnection> {
  return new Promise((resolve, reject) => {
    const endpoint = { host: options.host, port: options.port };
    const socket = options.secure
      ? connectTls({ ...options.tls, ...endpoint, servername: options.host, rejectUnauthorized: true })
      : createConnection(endpoint);
    const timeout = setTimeout(() => socket.destroy(new Error("SMTP connection timed out.")), 8000);
    socket.once("error", error => { clearTimeout(timeout); reject(error); });
    socket.once(options.secure ? "secureConnect" : "connect", () => {
      clearTimeout(timeout);
      resolve(new SMTPConnection({ ...options, connection: socket, secured: options.secure }));
    });
  });
}

const publicConnection: SmtpConnectionFactory = async options => {
  await assertPublicMailHost(options.host);
  return connectSmtp(options);
};

async function runSmtp(account: MailAccount, open: SmtpConnectionFactory, submission?: Submission): Promise<void> {
  const { host, port } = account.smtp;
  if (port !== 465 && port !== 587) throw new SmtpSubmissionError();
  const options: DialOptions = {
    host, port, secure: port === 465, requireTLS: port === 587,
    tls: { servername: host, rejectUnauthorized: true },
    name: "chatmail.local", logger: false, debug: false,
    dnsTimeout: 5000, connectionTimeout: 12000, greetingTimeout: 8000,
    socketTimeout: 12000, maxResponseSize: 32768,
  };
  let streaming = false;
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: SMTPConnection | undefined;
  async function exchange(cancel: (err: unknown) => void) {
    const client = await open(options);
    if (ended) { client.close(); return; }
    active = client;
    client.once("error", cancel);
    client.once("end", () => cancel(new Error("Connection ended.")));
    await new Promise<void>((resolve, reject) => client.connect(err => err ? reject(err) : resolve()));
    if (!client.secure || !client.allowsAuth) throw new SmtpSubmissionError();
    const user = account.separateSmtpCredentials ? account.smtp.username : account.imap.username;
    const pass = account.separateSmtpCredentials ? account.smtpPassword : account.password;
    await new Promise<void>((resolve, reject) => client.login({ user, pass }, err => err ? reject(err) : resolve()));
    if (!submission || ended) return;
    const { input, raw } = submission;
    // Nodemailer starts reading only after the server accepts DATA. A lost response
    // beyond this point must not trigger an automatic second submission.
    const stream = Readable.from((function* () { streaming = true; yield raw; })());
    await new Promise<void>((resolve, reject) => {
      client.send({ from: input.from, to: [...new Set([...input.to, ...input.cc])], size: raw.byteLength }, stream, (err, info) => {
        if (err) reject(err);
        else if (info.rejected.length) reject(new SmtpSubmissionError(false, true));
        else resolve();
      });
    });
  }
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("SMTP timeout.")), 30000);
      exchange(reject).then(resolve, reject);
    });
  } catch (error) {
    if (error instanceof SmtpSubmissionError) throw error;
    const code = error && typeof error === "object" && "responseCode" in error ? Number(error.responseCode) : 0;
    throw new SmtpSubmissionError(streaming && !(code >= 400 && code < 600));
  } finally {
    ended = true;
    if (timer !== undefined) clearTimeout(timer);
    active?.close();
  }
}

export function verifySmtp(account: MailAccount, open: SmtpConnectionFactory = publicConnection) {
  return runSmtp(account, open);
}

export async function prepareMessage(input: OutgoingMail): Promise<Uint8Array> {
  return new MailComposer({
    ...input, newline: "windows", disableFileAccess: true, disableUrlAccess: true,
  }).compile().build();
}

export function submitSmtp(account: MailAccount, input: OutgoingMail, raw: Uint8Array, open: SmtpConnectionFactory = publicConnection) {
  return runSmtp(account, open, { input, raw });
}

import type { Inbox } from "../../../../shared/contracts";
import type { MailAccount } from "./store";

export class SettingsError extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SettingsError("Enter your mailbox and server settings.");
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new SettingsError(`Enter a valid ${label}.`);
  }
  return value.trim();
}

function hostname(value: unknown, protocol: string) {
  const host = stringValue(value, `${protocol} server hostname`, 253).toLowerCase().replace(/\.$/, "");
  const labels = host.split(".");
  const last = labels.at(-1) ?? "";
  const validLabels = labels.length >= 2 && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  const reserved = /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|onion|invalid|test|arpa)$/.test(host);
  // Require a DNS name. This also excludes decimal, hex and shortened IPv4 forms.
  if (!validLabels || !/^[a-z][a-z0-9-]+$/.test(last) || /^0x/i.test(last) || reserved) {
    throw new SettingsError(`Use a public DNS hostname for the ${protocol} server.`);
  }
  return host;
}

function optionalPassword(value: unknown, label: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > 4096 || /[\u0000\r\n]/.test(value)) throw new SettingsError(`Enter a valid ${label}.`);
  return value;
}

function sameServer(left: Inbox["imap"], right: Inbox["imap"]) {
  return left.host === right.host && left.port === right.port && left.username === right.username;
}

export function parseAccount(input: unknown, id: string, prior?: MailAccount): MailAccount {
  const fields = record(input);
  const email = stringValue(fields.email, "mailbox email", 254).toLowerCase();
  if (!/^[^\s@<>,;:"()\\[\]]+@[^\s@<>,;:"()\\[\]]+\.[^\s@<>,;:"()\\[\]]+$/.test(email)) throw new SettingsError("Enter a valid mailbox email.");
  const incoming = record(fields.imap);
  const outgoing = record(fields.smtp);
  if (incoming.port !== 993 && incoming.port !== 143) throw new SettingsError("Use IMAP port 993 (TLS) or 143 (STARTTLS).");
  if (outgoing.port !== 465 && outgoing.port !== 587) throw new SettingsError("Use SMTP port 465 (TLS) or 587 (STARTTLS).");
  if (typeof fields.separateSmtpCredentials !== "boolean") throw new SettingsError("Choose whether SMTP uses separate credentials.");
  const separate = fields.separateSmtpCredentials;
  const imap = { host: hostname(incoming.host, "IMAP"), port: incoming.port, username: stringValue(incoming.username || email, "IMAP username", 320) };
  const smtp = { host: hostname(outgoing.host, "SMTP"), port: outgoing.port,
    username: separate ? stringValue(outgoing.username || email, "SMTP username", 320) : imap.username };

  const sameMailbox = prior && prior.email === email;
  const sameImap = sameMailbox && sameServer(prior.imap, imap);
  const sameSmtp = sameMailbox && sameServer(prior.smtp, smtp);
  let password = optionalPassword(fields.password, "mailbox password");
  if (!password && prior && sameImap && (separate || (!prior.separateSmtpCredentials && sameSmtp))) password = prior.password;
  if (!password) throw new SettingsError("Enter the mailbox password for these server settings.");
  let smtpPassword: string | undefined = password;
  if (separate) {
    smtpPassword = optionalPassword(fields.smtpPassword, "SMTP password");
    if (!smtpPassword && prior?.separateSmtpCredentials && sameSmtp) smtpPassword = prior.smtpPassword;
    if (!smtpPassword) throw new SettingsError("Enter the SMTP password for these server settings.");
  }
  return { id, email, imap, smtp, separateSmtpCredentials: separate, password, smtpPassword };
}

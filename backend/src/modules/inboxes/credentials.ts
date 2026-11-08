import type { Inbox } from "../../../../shared/contracts";

export interface Passwords {
  password: string;
  smtpPassword: string;
}

const utf8 = new TextEncoder();

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

async function importKey(secret: string) {
  const bytes = decode(secret);
  if (bytes.byteLength !== 32) throw new Error("Mailbox encryption key must contain 32 bytes.");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

// Bind a ciphertext to its owner and to the exact servers permitted to receive it.
function additionalData(userId: string, inbox: Inbox) {
  return utf8.encode(JSON.stringify([
    "chatmail-credentials-v1", userId, inbox.id, inbox.email,
    inbox.imap.host, inbox.imap.port, inbox.imap.username,
    inbox.smtp.host, inbox.smtp.port, inbox.smtp.username, inbox.separateSmtpCredentials,
  ]));
}

export async function encryptCredentials(secret: string, userId: string, inbox: Inbox, passwords: Passwords) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = utf8.encode(JSON.stringify({ password: passwords.password, smtpPassword: passwords.smtpPassword }));
  const result = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(userId, inbox) },
    await importKey(secret), payload,
  );
  return ["v1", encode(iv), encode(new Uint8Array(result))].join(".");
}

export async function decryptCredentials(secret: string, userId: string, inbox: Inbox, envelope: string): Promise<Passwords> {
  const [version, iv, ciphertext, extra] = envelope.split(".");
  if (version !== "v1" || !iv || !ciphertext || extra !== undefined) throw new Error("Invalid mailbox credential version.");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decode(iv), additionalData: additionalData(userId, inbox) },
    await importKey(secret), decode(ciphertext),
  );
  const data: unknown = JSON.parse(new TextDecoder().decode(plaintext));
  if (!data || typeof data !== "object" || !("password" in data) || !("smtpPassword" in data)
    || typeof data.password !== "string" || typeof data.smtpPassword !== "string") throw new Error("Invalid mailbox credentials.");
  return { password: data.password, smtpPassword: data.smtpPassword };
}

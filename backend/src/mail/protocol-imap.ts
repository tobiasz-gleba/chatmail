import { connect } from "cloudflare:sockets";
import { assertPublicMailHost } from "./protocol-host";
import { createSocketsTransport, ImapFlow, type FetchMessageObject, type FetchQueryObject, type MessageAddressObject } from "imapflow";
import type { Address, MailAccount, MailHeader, MailSource } from "./protocol-types";

export async function withImap<T>(account: MailAccount, operation: (client: ImapFlow) => Promise<T>, open: typeof connect = connect): Promise<T> {
  const { host, port, username } = account.imap;
  if (port !== 993 && port !== 143) throw new Error("Unsupported incoming mail port.");
  if (open === connect) await assertPublicMailHost(host);
  const client = new ImapFlow({
    host, port, secure: port === 993, doSTARTTLS: port === 143,
    auth: { user: username, pass: account.password },
    transport: createSocketsTransport((address, options) => open(address, { ...options, allowHalfOpen: false })),
    logger: false, disableAutoIdle: true, disableCompression: true,
    connectionTimeout: 12_000, greetingTimeout: 10_000, socketTimeout: 20_000,
    maxLiteralSize: 512 * 1024, maxLineLength: 1024 * 1024, maxResponseSize: 2 * 1024 * 1024,
    maxResponseTokens: 20_000,
  });
  // ImapFlow rejects pending operations on error. Never expose its protocol transcript.
  client.on("error", () => {});
  const deadline = setTimeout(() => client.close(), 45_000);
  try {
    await client.connect();
    return await operation(client);
  } catch {
    throw new Error("The incoming mail server could not complete this request.");
  } finally {
    clearTimeout(deadline);
    client.close();
  }
}

export async function verifyImap(account: MailAccount, open: typeof connect = connect): Promise<void> {
  await withImap(account, async client => { await client.mailboxOpen("INBOX", { readOnly: true }); }, open);
}

export async function sentFolder(client: ImapFlow): Promise<string | undefined> {
  const folders = await client.list();
  return folders.find(folder => folder.specialUse === "\\Sent" && !folder.flags.has("\\Noselect"))?.path
    ?? folders.find(folder => /^(?:sent|sent items|sent messages)$/i.test(folder.name) && !folder.flags.has("\\Noselect"))?.path;
}

export const headerQuery: FetchQueryObject = {
  uid: true, envelope: true, flags: true, internalDate: true, headers: ["References"],
};

function addresses(value?: MessageAddressObject[]): Address[] {
  return (value ?? []).flatMap(({ address, name }) => address ? [{ email: address, ...(name && { name }) }] : []);
}

export function asHeader(row: FetchMessageObject, folder: string, uidValidity: string): MailHeader {
  const envelope = row.envelope ?? {};
  const refs = row.headers?.toString("utf8").replace(/\r?\n[\t ]+/g, " ")
    .match(/^references:[ \t]*(.*)$/im)?.[1];
  return {
    source: { folder, uidValidity, uid: row.uid },
    messageId: envelope.messageId, inReplyTo: envelope.inReplyTo,
    references: refs?.match(/<[^<>\s]+>/g) ?? [], subject: envelope.subject ?? "",
    from: addresses(envelope.from), to: addresses(envelope.to), cc: addresses(envelope.cc),
    replyTo: addresses(envelope.replyTo), sentAt: new Date(row.internalDate ?? envelope.date ?? 0).toISOString(),
    unread: !row.flags?.has("\\Seen"),
  };
}

// Resolve every UID in the generation that originally produced it. UIDs may be reused
// after UIDVALIDITY changes, when addressing an old UID could mark the wrong mail read.
export async function withSources<T>(account: MailAccount, sources: MailSource[], readOnly: boolean,
  visit: (client: ImapFlow, folder: string, generation: string, uids: number[]) => Promise<T[]>): Promise<T[]> {
  if (!sources.length) return [];
  if (sources.length > 150) throw new Error("Too many messages in this request.");
  return withImap(account, async client => {
    const groups = new Map<string, MailSource[]>();
    for (const source of sources) {
      if (!Number.isSafeInteger(source.uid) || source.uid < 1) throw new Error("Invalid message.");
      const group = groups.get(source.folder) ?? [];
      group.push(source);
      groups.set(source.folder, group);
    }
    const output: T[] = [];
    for (const [folder, locators] of groups) {
      const selected = await client.mailboxOpen(folder, { readOnly });
      const generation = String(selected.uidValidity);
      if (locators.some(source => source.uidValidity !== generation)) throw new Error("Refresh the changed mailbox.");
      output.push(...await visit(client, folder, generation, [...new Set(locators.map(source => source.uid))]));
    }
    return output;
  });
}

export function fetchHeaders(account: MailAccount, sources: MailSource[]): Promise<MailHeader[]> {
  return withSources(account, sources, true, async (client, folder, generation, uids) =>
    (await client.fetchAll(uids, headerQuery, { uid: true })).map(row => asHeader(row, folder, generation)));
}

export async function markSeen(account: MailAccount, sources: MailSource[]): Promise<void> {
  await withSources(account, sources, false, async (client, _folder, _generation, uids) => {
    if (!await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true })) throw new Error("Could not mark messages read.");
    return [];
  });
}

async function lookupSent(client: ImapFlow, folder: string, messageId: string): Promise<boolean> {
  await client.mailboxOpen(folder, { readOnly: true });
  const uids = await client.search({ header: { "message-id": messageId } }, { uid: true });
  if (!Array.isArray(uids)) throw new Error("Could not check Sent.");
  if (!uids.length) return false;
  // IMAP HEADER searches match a substring. Verify the identifier before treating it as a receipt.
  return (await client.fetchAll(uids.slice(-50), { envelope: true }, { uid: true }))
    .some(row => row.envelope?.messageId === messageId);
}

export function findSent(account: MailAccount, messageId: string): Promise<boolean> {
  return withImap(account, async client => {
    const folder = await sentFolder(client);
    return folder ? lookupSent(client, folder, messageId) : false;
  });
}

export async function ensureSent(account: MailAccount, messageId: string, raw: Uint8Array): Promise<void> {
  await withImap(account, async client => {
    let folder = await sentFolder(client);
    if (folder && await lookupSent(client, folder, messageId)) return;
    if (!folder) {
      folder = "Sent";
      try { await client.mailboxCreate(folder); }
      catch {
        // Another submission may have created it concurrently.
        if (await sentFolder(client) !== folder) throw new Error("Could not create Sent.");
      }
    }
    if (!await client.append(folder, raw, ["\\Seen"], new Date())) throw new Error("Could not save the Sent copy.");
  });
}

import type { MailHeader, MailSource } from "../../mail/transport";

type Address = MailHeader["from"][number];

export interface HeaderEntry {
  inboxId: string;
  header: MailHeader;
}

export interface GroupedMessage {
  chatKey: string;
  participants: Address[];
  stableId: string;
  topicId: string;
  header: MailHeader;
  sources: Array<{ inboxId: string; source: MailSource }>;
  outgoing: boolean;
  unread: boolean;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function addressKey(email: string): string {
  return email.trim().toLowerCase();
}

function messageIdKey(id?: string): string | undefined {
  const bare = id?.trim().replace(/^<([^<>]+)>$/, "$1").trim();
  return bare ? "id:" + bare : undefined;
}

function sourceKey({ inboxId, header: { source } }: HeaderEntry): string {
  return "uid:" + JSON.stringify([inboxId, source.folder, source.uidValidity, source.uid]);
}

function externalParticipants(header: MailHeader, own: Set<string>): Address[] {
  const addresses = new Map<string, Address>();
  for (const address of [...header.from, ...header.to, ...header.cc]) {
    const email = addressKey(address.email);
    if (!email || own.has(email)) continue;
    const previous = addresses.get(email);
    if (!previous || (!previous.name && address.name)) {
      addresses.set(email, { ...address, email });
    }
  }
  return [...addresses.values()].sort((a, b) => compare(a.email, b.email));
}

// References are ordered from oldest ancestor to immediate parent. Recording
// the intermediate links also joins abbreviated reply chains on the same page.
export function ancestorKeys(header: MailHeader): string[] {
  const ancestors = header.references.map(messageIdKey).filter((key): key is string => !!key);
  const replyTo = messageIdKey(header.inReplyTo);
  if (replyTo && !ancestors.includes(replyTo)) ancestors.push(replyTo);
  return ancestors;
}

function linkAncestors(header: MailHeader, id: string, parents: Map<string, string>) {
  let previous: string | undefined;
  for (const key of [...ancestorKeys(header), id]) {
    if (previous && previous !== key && !parents.has(key)) parents.set(key, previous);
    previous = key;
  }
}

function rootId(id: string, parents: Map<string, string>, roots: Map<string, string>): string {
  const visited = new Set<string>();
  let current = id;
  while (parents.has(current) && !roots.has(current)) {
    if (visited.has(current)) {
      // A malformed cycle still gets one deterministic topic for all its members.
      const path = [...visited];
      current = path.slice(path.indexOf(current)).sort()[0];
      break;
    }
    visited.add(current);
    current = parents.get(current)!;
  }
  const root = roots.get(current) ?? current;
  for (const node of visited) roots.set(node, root);
  return root;
}

export function groupHeaders(entries: HeaderEntry[], ownEmails: string[]): GroupedMessage[] {
  const own = new Set(ownEmails.map(addressKey));
  const groups = new Map<string, GroupedMessage>();
  const seenSources = new Set<string>();
  const parents = new Map<string, string>();
  const newestFirst = [...entries].sort((a, b) =>
    compare(b.header.sentAt, a.header.sentAt) || compare(sourceKey(a), sourceKey(b)));

  for (const entry of newestFirst) {
    const { header, inboxId } = entry;
    const location = sourceKey(entry);
    if (seenSources.has(location)) continue;
    seenSources.add(location);
    const stableId = messageIdKey(header.messageId) ?? location;
    linkAncestors(header, stableId, parents);
    const copy = { inboxId, source: header.source };
    const existing = groups.get(stableId);
    if (existing) {
      existing.sources.push(copy);
      existing.unread ||= header.unread;
      continue;
    }
    const participants = externalParticipants(header, own);
    groups.set(stableId, {
      chatKey: JSON.stringify(participants.map(({ email }) => email)),
      participants,
      stableId,
      topicId: stableId,
      header,
      sources: [copy],
      outgoing: header.from.some(({ email }) => own.has(addressKey(email))),
      unread: header.unread,
    });
  }
  const roots = new Map<string, string>();
  for (const message of groups.values()) message.topicId = rootId(message.stableId, parents, roots);
  return [...groups.values()].sort((a, b) =>
    compare(b.header.sentAt, a.header.sentAt) || compare(a.stableId, b.stableId));
}

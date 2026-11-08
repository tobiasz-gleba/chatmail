import type { OutgoingMail } from "../../mail/transport";

interface Address { email: string }
export interface ReplyParent {
  from: Address;
  replyTo: Address[];
  to: Address[];
  cc: Address[];
  subject: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
}

export class InvalidMessage extends Error {}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 &&
    /^[^\s\x00-\x1f\x7f<>()\[\],;:"\\@]+@[^\s\x00-\x1f\x7f<>()\[\],;:"\\@]+\.[^\s\x00-\x1f\x7f<>()\[\],;:"\\@]+$/u.test(value);
}

function uniqueAddresses(addresses: string[], used: Set<string>): string[] {
  const result: string[] = [];
  for (const address of addresses) {
    const key = address.toLowerCase();
    if (used.has(key)) continue;
    if (!isAddress(address)) throw new InvalidMessage("One of the recipients has an invalid email address.");
    used.add(key);
    result.push(address);
  }
  return result;
}

function headerId(value: string | null): string | undefined {
  if (!value) return;
  const id = value.trim().replace(/^<([^<>]+)>$/, "$1");
  if (id.length > 998 || !/^[^<>\s\p{C}]+$/u.test(id)) return;
  return `<${id}>`;
}

export type Draft = { body: string; to?: string[]; subject?: string };

export function makeMessage(from: string, messageId: string, draft: Draft,
  parent: ReplyParent | null, ownAddresses: string[]): OutgoingMail {
  if (!isAddress(from)) throw new InvalidMessage("The sending inbox needs a valid address.");
  if (!draft.body.trim() || new TextEncoder().encode(draft.body).length > 256 * 1024) {
    throw new InvalidMessage("Enter a message of up to 256 KB.");
  }
  let subject: string;
  let to: string[];
  let cc: string[] = [];
  const used = new Set<string>();
  let inReplyTo: string | undefined;
  let references: string[] | undefined;
  if (parent) {
    for (const email of ownAddresses) used.add(email.toLowerCase());
    const isOutgoing = used.has(parent.from.email.toLowerCase());
    const authors = isOutgoing ? [] : parent.replyTo.length ? parent.replyTo : [parent.from];
    to = uniqueAddresses([...authors, ...parent.to].map(address => address.email), used);
    cc = uniqueAddresses(parent.cc.map(address => address.email), used);
    const original = parent.subject.replace(/[\r\n]+/g, " ").trim();
    subject = /^re\s*:/i.test(original) ? original : `Re: ${original}`.trimEnd();
    inReplyTo = headerId(parent.messageId);
    const ancestors = parent.references.length ? parent.references : [parent.inReplyTo];
    references = [...new Set([...ancestors, parent.messageId].map(headerId).filter((id): id is string => !!id))];
    // Keep the root as well as the recent ancestry on exceptionally long conversations.
    if (references.length > 50) references = [references[0], ...references.slice(-49)];
  } else {
    subject = (draft.subject ?? "").trim();
    if (!subject || subject.length > 998 || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(subject)) {
      throw new InvalidMessage("Enter a single-line subject of up to 998 characters.");
    }
    to = uniqueAddresses((draft.to ?? []).map(address => address.trim()), used);
  }
  if (!to.length && !cc.length) throw new InvalidMessage("Choose at least one recipient.");
  if (to.length + cc.length > 100) throw new InvalidMessage("Choose up to 100 recipients.");
  return { from, messageId, to, cc, subject, text: draft.body, inReplyTo, references };
}

import type { InboxFailure } from "../../../../shared/contracts";
import { scanMailbox, fetchHeaders, type MailHeader, type MailSource } from "../../mail/transport";
import type { MailAccount } from "../inboxes/store";
import { invalidRequest, type Tokens } from "./tokens";

type Folder = "INBOX" | "SENT";
type Pointer = { source: MailSource; sentAt: string };
interface Stream {
  inboxId: string;
  folder: Folder;
  position: string | null;
  ended: boolean;
  buffer: Pointer[];
}
interface Cursor {
  streams: Stream[];
  scope: string;
  expires: number;
}
export type HeaderEntry = { inboxId: string; header: MailHeader };
export type AccountLoader = (id: string) => Promise<MailAccount | null>;

export const sourceKey = (source: MailSource) => JSON.stringify([source.folder,source.uidValidity,source.uid]);
const entryKey = (inboxId: string, source: MailSource) => JSON.stringify([inboxId, sourceKey(source)]);
export const unavailable = (inboxId: string): InboxFailure => ({ inboxId, message: "Couldn't read this inbox. Try again." });

// Keep simultaneous remote sessions below the Worker's connection limit.
export async function inBatches<T>(items: T[], run: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += 2) await Promise.all(items.slice(i, i + 2).map(run));
}

function initialStreams(ids: string[]): Stream[] {
  const folders: Folder[] = ["INBOX", "SENT"];
  return ids.flatMap(inboxId => folders.map(folder => ({ inboxId, folder, position: null, buffer: [], ended: false })));
}

export interface ScanOptions {
  inboxIds: string[];
  tokens: Tokens;
  scope: string;
  cursor?: string;
  loadAccount: AccountLoader;
  participant?: string;
  limit: number;
}

// Merge the heads of independently sorted folder streams. The cursor buffers only
// unread scan positions (UID, UIDVALIDITY, date), never full headers or bodies.
export async function nextHeaders(options: ScanOptions) {
  const { inboxIds, tokens, scope, loadAccount, limit } = options;
  let streams: Stream[];
  if (options.cursor) {
    const saved = await tokens.open<Cursor>("scan", options.cursor);
    if (saved.scope !== scope || saved.expires < Date.now()) return invalidRequest();
    streams = saved.streams.filter(stream => inboxIds.includes(stream.inboxId));
  } else {
    streams = initialStreams(inboxIds);
  }
  const failures = new Map<string, InboxFailure>();
  const fresh = new Map<string, MailHeader>();
  const chosen: Array<{inboxId: string; source: MailSource}> = [];
  let scansLeft = 6;
  while (chosen.length < limit) {
    const missing = streams.filter(s => !s.ended && s.buffer.length === 0);
    if (missing.length) {
      if (!scansLeft) break;
      const batch = missing.slice(0, scansLeft);
      scansLeft -= batch.length;
      await inBatches(batch, async stream => {
        try {
          const account = await loadAccount(stream.inboxId);
          if (!account) { stream.ended = true; return; }
          const page = await scanMailbox(account, stream.folder, stream.position, 24, options.participant);
          stream.position = page.next;
          stream.ended = page.next === null;
          stream.buffer = page.headers.map(header => {
            fresh.set(entryKey(stream.inboxId, header.source), header);
            return {source: header.source, sentAt: header.sentAt};
          });
        } catch {
          failures.set(stream.inboxId, unavailable(stream.inboxId));
          stream.ended = true;
        }
      });
      continue;
    }
    let winner: Stream | undefined;
    for (const stream of streams) {
      if (stream.buffer.length && (!winner || stream.buffer[0].sentAt > winner.buffer[0].sentAt)) winner = stream;
    }
    if (!winner) break;
    const { source } = winner.buffer.shift()!;
    chosen.push({inboxId: winner.inboxId, source});
  }
  const needHeaders = new Map<string, MailSource[]>();
  for (const {inboxId, source} of chosen) {
    if (fresh.has(entryKey(inboxId, source))) continue;
    const bucket = needHeaders.get(inboxId) ?? [];
    bucket.push(source);
    needHeaders.set(inboxId, bucket);
  }
  await inBatches([...needHeaders], async ([inboxId, items]) => {
    try {
      const account = await loadAccount(inboxId);
      if (!account) return;
      const headers = await fetchHeaders(account, items);
      for (const header of headers) fresh.set(entryKey(inboxId, header.source), header);
    } catch {
      failures.set(inboxId, unavailable(inboxId));
    }
  });
  const entries: HeaderEntry[] = chosen.flatMap(({inboxId, source}) => {
    const header = fresh.get(entryKey(inboxId, source));
    return header ? [{inboxId, header}] : [];
  });
  const remaining = streams.filter(s => !s.ended || s.buffer.length);
  const cursor = remaining.length ? await tokens.issue("scan", { streams: remaining, scope, expires: Date.now() + 3600000 } satisfies Cursor) : null;
  return { entries, cursor, failures: [...failures.values()] };
}

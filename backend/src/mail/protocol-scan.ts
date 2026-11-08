import { type ESearchResult, type ImapFlow, type MailboxObject, type SearchObject } from "imapflow";
import { asHeader, headerQuery, sentFolder, withImap } from "./protocol-imap";
import type { MailAccount, MailHeader } from "./protocol-types";

const day = 86_400_000;
const uidBatch = 384;
type Hit = [time: number, uid: number];
type Page = { headers: MailHeader[]; next: string | null };

interface ScanPosition {
  folder: string;
  generation: string;
  snapshotUid: number;
  // Only include messages before this (time, UID) pair. The first window has no ceiling.
  ceiling: Hit | null;
  floor: number | null;
  days: number;
  afterUid: number;
  best: Hit[];
}

function newest(a: Hit, b: Hit): number {
  return b[0] - a[0] || b[1] - a[1];
}

function firstPosition(box: MailboxObject): ScanPosition {
  // A small folder already fits one metadata fetch, including sparsely dated mail.
  const floor = box.exists <= uidBatch ? null : Math.floor(Date.now() / day) * day - 6 * day;
  return {
    folder: box.path, generation: String(box.uidValidity), snapshotUid: box.uidNext - 1,
    ceiling: null, floor, days: 7, afterUid: 0, best: [],
  };
}

function queryWindow(position: ScanPosition, participant?: string): SearchObject {
  const query: SearchObject = { uid: `${position.afterUid + 1}:${position.snapshotUid}` };
  // SINCE/BEFORE ignore the timezone in INTERNALDATE. Pad the local calendar date
  // on both ends, then compare actual timestamps once the server returns them.
  if (position.floor !== null) query.since = new Date(position.floor - day);
  if (position.ceiling) query.before = new Date(position.ceiling[0] + 2 * day);
  if (participant) query.or = [{ from: participant }, { to: participant }, { cc: participant }];
  return query;
}

// ESEARCH returns compressed UID ranges. Expand only this request's slice, even if the
// server says the whole mailbox matched. Older IMAP servers return a SEARCH UID array.
function firstUids(matches: ESearchResult | number[] | false | undefined, count: number): number[] {
  if (matches === false || matches === undefined) throw new Error("Mailbox search unavailable.");
  if (Array.isArray(matches)) return matches.sort((a, b) => a - b).slice(0, count);
  if (!matches.all) return [];
  const ranges = matches.all.split(",").map(range => {
    const [a, b = a] = range.split(":").map(Number);
    return [Math.min(a, b), Math.max(a, b)];
  }).sort((a, b) => a[0] - b[0]);
  const found: number[] = [];
  for (const [low, high] of ranges) {
    for (let uid = low; uid <= high && found.length < count; uid++) found.push(uid);
    if (found.length === count) break;
  }
  return found;
}

function olderWindow(position: ScanPosition): ScanPosition | null {
  if (position.floor === null) return null;
  const days = position.days * 4;
  return {
    ...position, days, ceiling: [position.floor, 0], floor: days > 36_500 ? null : position.floor - days * day,
    afterUid: 0, best: [],
  };
}

const maxSearchMatches = 16_384;

function canCount(client: ImapFlow) {
  return client.capabilities.has("ESEARCH") || client.enabled.has("IMAP4REV2");
}

// Limit a legacy SEARCH response by the number of existing messages, even when
// UIDNEXT is huge because most old messages have been deleted. Sequence numbers
// only locate a split point within this request; saved positions always use UIDs.
async function boundedUpperUid(client: ImapFlow, box: MailboxObject, position: ScanPosition) {
  if (box.exists <= maxSearchMatches) return position.snapshotUid;
  let seq = 0;
  if (position.afterUid) {
    const previous = await client.fetchOne(position.afterUid, { uid: true }, { uid: true });
    if (previous) seq = previous.seq;
    else {
      let high = box.exists + 1;
      while (high - seq > 1) {
        const mid = Math.floor((high + seq) / 2);
        const row = await client.fetchOne(mid, { uid: true });
        if (row && row.uid <= position.afterUid) seq = mid;
        else high = mid;
      }
    }
  }
  if (seq + maxSearchMatches >= box.exists) return position.snapshotUid;
  const end = await client.fetchOne(seq + maxSearchMatches, { uid: true });
  if (!end) throw new Error("Mailbox changed during the search.");
  return Math.min(end.uid, position.snapshotUid);
}

async function countMatches(client: ImapFlow, query: SearchObject): Promise<number> {
  const answer = await client.search(query, { uid: true, returnOptions: ["COUNT"] });
  if (!answer || Array.isArray(answer) || answer.count == null) throw new Error("Mailbox count unavailable.");
  return answer.count;
}

async function possibleOlder(client: ImapFlow, position: ScanPosition, participant?: string) {
  if (!position.ceiling) return true;
  const query = queryWindow({ ...position, floor: null }, participant);
  // Legacy servers spell out every match. Let bounded scans run to exhaustion there.
  return !canCount(client) || await countMatches(client, query) > 0;
}

export async function scanMailbox(account: MailAccount, folder: "INBOX" | "SENT", cursor: string | null,
  limit: number, participant?: string): Promise<Page> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid mail page size.");
  return withImap(account, async client => {
    const saved: ScanPosition | null = cursor ? JSON.parse(cursor) : null;
    const path = saved?.folder ?? (folder === "INBOX" ? "INBOX" : await sentFolder(client));
    if (!path) return { headers: [], next: null };
    const box = await client.mailboxOpen(path, { readOnly: true });
    if (!box.exists) return { headers: [], next: null };
    const position = saved ?? firstPosition(box);
    if (String(box.uidValidity) !== position.generation) throw new Error("Refresh the changed mailbox.");
    if (!position.snapshotUid) return { headers: [], next: null };

    const query = queryWindow(position, participant);
    let upperUid = position.snapshotUid;
    if (box.exists > maxSearchMatches && (!canCount(client) || await countMatches(client, query) > maxSearchMatches)) {
      upperUid = await boundedUpperUid(client, box, position);
      query.uid = `${position.afterUid + 1}:${upperUid}`;
    }
    const matches = await client.search(query, { uid: true, returnOptions: ["ALL"] });
    const uids = firstUids(matches, uidBatch + 1);
    const batch = uids.slice(0, uidBatch);
    if (batch.length) {
      const rows = await client.fetchAll(batch, { internalDate: true }, { uid: true });
      for (const row of rows) {
        if (!row.internalDate) continue;
        const hit: Hit = [new Date(row.internalDate).getTime(), row.uid];
        if ((position.floor === null || hit[0] >= position.floor) && (!position.ceiling || newest(hit, position.ceiling) > 0)) {
          position.best.push(hit);
        }
      }
      position.best.sort(newest).splice(limit + 1);
    }
    if (uids.length > uidBatch || upperUid < position.snapshotUid) {
      position.afterUid = uids.length > uidBatch ? batch[batch.length - 1] : upperUid;
      return { headers: [], next: JSON.stringify(position) };
    }

    const chosen = position.best.slice(0, limit);
    const rows = chosen.length ? await client.fetchAll(chosen.map(hit => hit[1]), headerQuery, { uid: true }) : [];
    const byUid = new Map(rows.map(row => [row.uid, asHeader(row, box.path, position.generation)]));
    const headers = chosen.flatMap(([, uid]) => byUid.get(uid) ?? []);
    let following: ScanPosition | null;
    if (position.best.length > limit) {
      following = { ...position, ceiling: chosen[chosen.length - 1], afterUid: 0, best: [] };
    } else {
      following = olderWindow(position);
      if (following && !await possibleOlder(client, following, participant)) following = null;
    }
    return { headers, next: following && JSON.stringify(following) };
  });
}

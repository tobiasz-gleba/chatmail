import { afterEach, expect, it, vi } from "vitest";
import type { ImapFlow, SearchObject } from "imapflow";
import { withImap } from "../src/mail/protocol-imap";
import { scanMailbox } from "../src/mail/protocol-scan";
import type { MailAccount } from "../src/mail/protocol-types";

vi.mock("../src/mail/protocol-imap", async importOriginal => ({
  ...await importOriginal<typeof import("../src/mail/protocol-imap")>(),
  withImap: vi.fn(),
}));

const day = 86_400_000;
const now = Date.UTC(2026, 10, 8, 10);
const account: MailAccount = {
  id: "work", email: "me@example.test", separateSmtpCredentials: false, password: "", smtpPassword: "",
  imap: { host: "imap.example.test", port: 993, username: "me" },
  smtp: { host: "smtp.example.test", port: 465, username: "me" },
};
type Row = { uid: number; internalDate: Date; localDate: string };

function row(uid: number, timestamp: number, offset = 0): Row {
  return { uid, internalDate: new Date(timestamp), localDate: new Date(timestamp + offset * 3_600_000).toISOString().slice(0, 10) };
}

function mailbox(rows: Row[], supportsEsearch: boolean) {
  const selected = { exists: rows.length, path: "INBOX", uidValidity: 1234n, uidNext: rows.at(-1)!.uid + 1 };
  const searchSizes: number[] = [];
  const client = {
    capabilities: new Map(supportsEsearch ? [["ESEARCH", true]] : []),
    enabled: new Set(),
    mailboxOpen: async () => selected,
    search: async (query: SearchObject, options: { returnOptions: string[] }) => {
      const [low, high] = String(query.uid).split(":").map(Number);
      const since = query.since && new Date(query.since).toISOString().slice(0, 10);
      const before = query.before && new Date(query.before).toISOString().slice(0, 10);
      const matches = rows.filter(r => r.uid >= low && r.uid <= high && (!since || r.localDate >= since) && (!before || r.localDate < before));
      searchSizes.push(matches.length);
      if (supportsEsearch && options.returnOptions.includes("COUNT")) return { count: matches.length };
      const uids = matches.map(r => r.uid);
      return supportsEsearch ? { all: uids.join(",") } : uids;
    },
    fetchOne: async (value: number, _fields: unknown, options?: { uid?: boolean }) => {
      const index = options?.uid ? rows.findIndex(r => r.uid === value) : value - 1;
      return rows[index] ? { uid: rows[index].uid, seq: index + 1 } : false;
    },
    fetchAll: async (uids: number[]) => {
      const requested = new Set(uids);
      return rows.filter(r => requested.has(r.uid));
    },
  };
  vi.mocked(withImap).mockImplementation(async (_account, operation) => operation(client as unknown as ImapFlow));
  vi.spyOn(Date, "now").mockReturnValue(now);
  return { selected, searchSizes };
}

afterEach(() => vi.restoreAllMocks());

it("returns a whole small legacy folder with recent and historical arrivals in one page", async () => {
  mailbox([row(8, now - 3 * day), row(50, now), row(140, now - 900 * day)], false);
  const result = await scanMailbox(account, "INBOX", null, 24);
  expect(result.headers.map(h => h.source.uid)).toEqual([50, 8, 140]);
  expect(result.next).toBeNull();
});

it.each([true, false])("pages by actual arrival across windows and timestamp ties (ESEARCH=%s)", async esearch => {
  const rows = Array.from({ length: 720 }, (_, i) => {
    const age = i < 630 ? ((i * 73) % 121) * 3_600_000 : (i < 660 ? (i * 97) % 39 : 400) * day;
    return row(1 + i * 17, now - age, (i % 27) - 12);
  });
  mailbox(rows, esearch);
  const expected = [...rows].sort((a, b) => +b.internalDate - +a.internalDate || b.uid - a.uid).map(r => r.uid);
  const found: number[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const result = await scanMailbox(account, "INBOX", cursor, 24);
    found.push(...result.headers.map(h => h.source.uid));
    cursor = result.next;
    expect(++pages).toBeLessThan(100);
  } while (cursor);
  expect(found).toEqual(expected);
});

it("bounds a legacy search across sparse UIDs and rejects a stale folder generation", async () => {
  // The most recent arrival has the first UID; sorting or paging by UID would hide it.
  const rows = Array.from({ length: 17_000 }, (_, i) => row(10 + i * 8_000, now - i * 1000));
  const { selected, searchSizes } = mailbox(rows, false);
  let cursor: string | null = null;
  let pages = 0;
  let found: number[] = [];
  do {
    const result = await scanMailbox(account, "INBOX", cursor, 24);
    cursor = result.next;
    found = result.headers.map(h => h.source.uid);
    if (++pages === 1) {
      // A just-scanned UID may disappear before the next request.
      rows.splice(383, 1);
      selected.exists--;
    }
    expect(pages).toBeLessThan(70);
  } while (!found.length && cursor);
  expect(found).toEqual(rows.slice(0, 24).map(r => r.uid));
  expect(Math.max(...searchSizes)).toBeLessThan(rows.length);
  expect(cursor).toBeTruthy();
  selected.uidValidity++;
  await expect(scanMailbox(account, "INBOX", cursor, 24)).rejects.toThrow(/changed mailbox/);
});

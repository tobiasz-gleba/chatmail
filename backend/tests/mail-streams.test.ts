import { afterEach, expect, it, vi } from "vitest";
import { fetchHeaders, scanMailbox, type MailHeader } from "../src/mail/transport";
import type { MailAccount } from "../src/modules/inboxes/store";
import { groupHeaders } from "../src/modules/mail/grouping";
import { nextHeaders, type HeaderEntry } from "../src/modules/mail/streams";
import { mailTokens } from "../src/modules/mail/tokens";

vi.mock("../src/mail/transport", () => ({ fetchHeaders: vi.fn(), scanMailbox: vi.fn() }));

const ownEmails = ["home@example.test", "work@example.test"];
const secret = "test-only-cursor-signing-key";
const accounts = ["home", "work", "unavailable"].map(id => ({
  id, email: id + "@example.test",
  imap: { host: "imap.example.test", port: 993, username: id },
  smtp: { host: "smtp.example.test", port: 465, username: id },
  password: "test", smtpPassword: "test", separateSmtpCredentials: false,
} satisfies MailAccount));

function headersInServers() {
  const entries: HeaderEntry[] = [];
  for (let index = 0; index < 209; index++) {
    const repeatedSender = index < 110;
    const from = repeatedSender ? "ada@example.test" : `person${index}@example.test`;
    const account = accounts[index % 2];
    // Leave home's Sent folder empty and intermingle sent mail from work.
    const sent = index % 4 === 3;
    const header: MailHeader = {
      source: { folder: sent ? "Sent" : "INBOX", uidValidity: "42", uid: index + 1 },
      messageId: `<${index}@example.test>`, subject: "Trip", references: [],
      from: [{ email: sent ? account.email : from }],
      to: [{ email: sent ? from : account.email }], cc: [], replyTo: [],
      sentAt: new Date(Date.UTC(2025, 3, 2, 0, 0, 209 - index)).toISOString(), unread: !sent,
    };
    entries.push({ inboxId: account.id, header });
  }
  return entries;
}

function setUpServers() {
  const entries = headersInServers();
  vi.mocked(scanMailbox).mockImplementation(async (account, folder, cursor, limit) => {
    if (account.id === "unavailable") throw new Error("Connection timed out");
    const headers = entries.filter(entry =>
      entry.inboxId === account.id && entry.header.source.folder === (folder === "SENT" ? "Sent" : "INBOX"));
    const start = Number(cursor ?? 0);
    const end = Math.min(start + limit, headers.length);
    return { headers: headers.slice(start, end).map(entry => entry.header), next: end < headers.length ? String(end) : null };
  });
  vi.mocked(fetchHeaders).mockImplementation(async (account, sources) =>
    entries.filter(entry => entry.inboxId === account.id && sources.some(source =>
      source.folder === entry.header.source.folder && source.uidValidity === entry.header.source.uidValidity &&
      source.uid === entry.header.source.uid)).map(entry => entry.header));
  const options = {
    inboxIds: accounts.map(account => account.id),
    tokens: mailTokens(secret, "alice"),
    scope: "all", loadAccount: async (id: string) => accounts.find(account => account.id === id) ?? null,
    limit: 13,
  };
  return { options, entries };
}

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

it("continues past 100 repeated emails until it finds 100 distinct chats across available inboxes", async () => {
  const { options, entries } = setUpServers();
  let cursor: string | undefined;
  const seen = new Set<string>();
  const failures = new Set<string>();
  const chats = new Set<string>();
  const returnedDates: string[] = [];
  let pages = 0;
  do {
    const page = await nextHeaders({ ...options, cursor });
    for (const { inboxId } of page.failures) failures.add(inboxId);
    for (const message of groupHeaders(page.entries, ownEmails)) {
      expect(seen.has(message.stableId)).toBe(false);
      seen.add(message.stableId);
      chats.add(message.chatKey);
      returnedDates.push(message.header.sentAt);
    }
    if (seen.size >= 100 && seen.size <= 110) expect(chats.size).toBe(1);
    cursor = page.cursor ?? undefined;
    expect(++pages).toBeLessThan(30);
  } while (cursor && chats.size < 100);
  expect(chats.size).toBe(100);
  expect(seen.size).toBe(209);
  expect(returnedDates).toEqual(entries.map(entry => entry.header.sentAt));
  expect(failures).toEqual(new Set(["unavailable"]));
  expect(cursor).toBeUndefined();
  const homeSentScans = vi.mocked(scanMailbox).mock.calls.filter(([account, folder]) => account.id === "home" && folder === "SENT");
  expect(homeSentScans).toHaveLength(1);
});

it("rejects another owner's cursor, a changed filter, a changed signature, and an expired cursor", async () => {
  const { options } = setUpServers();
  const { cursor } = await nextHeaders(options);
  expect(cursor).toBeTruthy();
  if (!cursor) return;
  const invalid = { status: 400, code: "INVALID_MAIL_REQUEST" };
  const request = { ...options, cursor };
  await expect(nextHeaders({ ...request, tokens: mailTokens(secret, "bob") })).rejects.toMatchObject(invalid);
  await expect(nextHeaders({ ...request, scope: "one-inbox" })).rejects.toMatchObject(invalid);
  const [payload, signature] = cursor.split(".");
  const forged = payload + "." + (signature[0] === "A" ? "B" : "A") + signature.slice(1);
  await expect(nextHeaders({ ...request, cursor: forged })).rejects.toMatchObject(invalid);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60 * 60 * 1000 + 1);
  await expect(nextHeaders(request)).rejects.toMatchObject(invalid);
});

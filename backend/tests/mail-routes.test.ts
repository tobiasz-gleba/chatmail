import { Hono } from "hono";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import type { ChatPage, MessagePage } from "@shared/contracts";
import type { AppEnv } from "../src/http";
import { fetchBodies, fetchHeaders, markSeen, scanMailbox, type MailHeader } from "../src/mail/transport";
import { getMailAccount, listInboxes, type MailAccount } from "../src/modules/inboxes/store";
import { resolveReplyTarget } from "../src/modules/mail/reply";
import { mailRoutes } from "../src/modules/mail/routes";

vi.mock("../src/mail/transport", () => ({
  fetchBodies: vi.fn(), fetchHeaders: vi.fn(), markSeen: vi.fn(), scanMailbox: vi.fn(),
}));
vi.mock("../src/modules/inboxes/store", () => ({ getMailAccount: vi.fn(), listInboxes: vi.fn() }));

const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  c.set("user", { id: c.req.header("Test-User") ?? "owner", email: "owner@example.test" });
  c.set("requestId", "test-request");
  await next();
});
app.route("/mail", mailRoutes);
const bindings = { ...env, AUTH_SECRET: "only-a-synthetic-test-secret" };
const accounts: MailAccount[] = ["home", "work"].map(id => ({
  id, email: id + "@example.test", password: "", smtpPassword: "", separateSmtpCredentials: false,
  imap: {host: "example.test", port: 993, username: id},
  smtp: {host: "example.test", port: 465, username: id},
}));
const people = { ada: {email: "ada@example.test"}, sam: {email: "sam@example.test"} };
const messages = new Map<string, MailHeader[]>();
function post(route: string, input: unknown, user = "owner") {
  return app.request("/mail/" + route, {
    method: "POST", body: JSON.stringify(input),
    headers: { "Content-Type": "application/json", "Test-User": user },
  }, bindings);
}
beforeEach(() => {
  vi.clearAllMocks();
  messages.clear();
  for (const account of accounts) {
    const count = account.id === "home" ? 22 : 1;
    const headers = Array.from({ length: count }, (_, i): MailHeader => ({
      source: {folder:"INBOX", uid: i + 1, uidValidity:"7"},
      messageId: i === 0 ? "<shared@example.test>" : "<m" + i + "@example.test>",
      inReplyTo: i === 1 ? "<m21@example.test>" : i === 21 ? "<old-root@example.test>" : undefined,
      references: [], subject: "Visit", from: [people.ada], to: [{email:account.email}],
      cc: i === 2 ? [people.sam] : [], replyTo: [], sentAt: new Date(Date.UTC(2026,0,31,0,0,40-i)).toISOString(),
      unread: true,
    }));
    messages.set(account.id, headers);
  }
  vi.mocked(listInboxes).mockResolvedValue(accounts);
  vi.mocked(getMailAccount).mockImplementation(async (_, user, id) => user === "owner" ? accounts.find(a => a.id === id) ?? null : null);
  vi.mocked(scanMailbox).mockImplementation(async (account, folder, _, limit) => {
    const result = folder === "INBOX" ? messages.get(account.id)! : [];
    return {headers:result.slice(0,limit),next:null};
  });
  vi.mocked(fetchHeaders).mockImplementation(async (account, sources) =>
    messages.get(account.id)!.filter(message => sources.some(source => source.uid === message.source.uid)));
  vi.mocked(fetchBodies).mockImplementation(async (_, sources) =>
    sources.map(source => ({source,body:"Plain text " + source.uid})));
  vi.mocked(markSeen).mockResolvedValue();
});

it("returns combined chat history with live reply locators, source-limited read flags and cross-page ancestry", async () => {
  const chats = await (await post("chats", {})).json() as ChatPage;
  expect(chats.chats).toHaveLength(2);
  expect(fetchBodies).not.toHaveBeenCalled();
  expect(markSeen).not.toHaveBeenCalled();
  const ada = chats.chats.find(chat => chat.participants.length === 1)!;
  expect(ada.inboxIds.sort()).toEqual(["home", "work"]);
  const first = await (await post("messages", {chatId:ada.id})).json() as MessagePage;
  const second = await (await post("messages", {chatId:ada.id,cursor:first.cursor})).json() as MessagePage;
  expect(second.cursor).toBeNull();
  expect(first.messages.find(m => m.key === "id:m1@example.test")?.ancestorKeys).toEqual(["id:m21@example.test"]);
  expect(second.messages.find(m => m.key === "id:m21@example.test")?.ancestorKeys).toEqual(["id:old-root@example.test"]);
  const duplicate = first.messages.find(m => m.key === "id:shared@example.test")!;
  expect(duplicate.inboxIds.sort()).toEqual(["home", "work"]);
  expect(first.messages.every(m => m.cc.length === 0)).toBe(true);
  expect(markSeen).not.toHaveBeenCalled();

  const target = await resolveReplyTarget(bindings, "owner", duplicate.id);
  expect(target.messageId).toBe("<shared@example.test>");
  expect(target.from).toEqual(people.ada);
  expect((await post("read", {messageIds:[duplicate.id]})).status).toBe(200);
  expect(vi.mocked(markSeen).mock.calls.map(([account]) => account.id).sort()).toEqual(["home","work"]);
  expect((await post("read", {messageIds:[duplicate.id]}, "another-user")).status).toBe(400);
  expect((await post("messages", {chatId:ada.id}, "another-user")).status).toBe(400);
  expect(markSeen).toHaveBeenCalledTimes(2);

  const filtered = await (await post("messages", {chatId:ada.id,inboxId:"work"})).json() as MessagePage;
  expect(filtered.messages.map(m => m.inboxIds)).toEqual([["work"]]);
  expect(filtered.messages[0].key).toBe(duplicate.key);
  messages.get("home")!.shift();
  messages.set("work", []);
  await expect(resolveReplyTarget(bindings, "owner", duplicate.id)).rejects.toMatchObject({status:404});
});

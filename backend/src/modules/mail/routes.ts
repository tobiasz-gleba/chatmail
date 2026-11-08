import { Hono, type Context } from "hono";
import type { Chat, ChatMessage } from "@shared/contracts";
import { apiError, type AppEnv } from "../../http";
import { fetchBodies, fetchHeaders, markSeen, type MailSource } from "../../mail/transport";
import { getMailAccount, listInboxes } from "../inboxes/store";
import { ancestorKeys, groupHeaders, type GroupedMessage } from "./grouping";
import { messageLocator, type MessageLocator } from "./reply";
import { inBatches, nextHeaders, sourceKey, unavailable, type AccountLoader } from "./streams";
import { invalidRequest, MailRequestError, mailTokens } from "./tokens";

export const mailRoutes = new Hono<AppEnv>();
type Ctx = Context<AppEnv>;

async function input(c: Ctx): Promise<Record<string, unknown>> {
  const data: unknown = await c.req.json().catch(() => null);
  if (!data || typeof data !== "object" || Array.isArray(data)) return invalidRequest();
  return data as Record<string, unknown>;
}

function accounts(env: Env, userId: string): AccountLoader {
  const requests = new Map<string, ReturnType<typeof getMailAccount>>();
  return id => {
    const existing = requests.get(id);
    if (existing) return existing;
    const request = getMailAccount(env, userId, id);
    requests.set(id, request);
    return request;
  };
}

async function page(c: Ctx, mode: "chats" | "messages") {
  const query = await input(c);
  if (query.inboxId != null && typeof query.inboxId !== "string") return invalidRequest();
  if (query.cursor != null && typeof query.cursor !== "string") return invalidRequest();
  const userId = c.get("user").id;
  const tokens = mailTokens(c.env.AUTH_SECRET, userId);
  const inboxes = await listInboxes(c.env, userId);
  const ids = inboxes.map(inbox => inbox.id);
  if (typeof query.inboxId === "string" && !ids.includes(query.inboxId)) {
    throw new MailRequestError(404, "INBOX_NOT_FOUND", "This inbox is no longer connected.");
  }
  const inboxIds = typeof query.inboxId === "string" ? [query.inboxId] : ids;
  const ownEmails = inboxes.map(inbox => inbox.email);
  const loadAccount = accounts(c.env, userId);
  let chatKey: string | undefined;
  if (mode === "messages") {
    if (typeof query.chatId !== "string") return invalidRequest();
    chatKey = await tokens.open<string>("chat", query.chatId);
  }
  // A visible group member narrows the server search; exact membership is checked below.
  const participant = chatKey === undefined ? undefined : (JSON.parse(chatKey) as string[])[0];
  const scan = await nextHeaders({
    tokens, loadAccount, inboxIds, participant, cursor: query.cursor ?? undefined,
    scope: JSON.stringify([mode, chatKey, query.inboxId ?? null, [...ids].sort()]),
    limit: mode === "chats" ? 50 : 20,
  });
  const grouped = groupHeaders(scan.entries, ownEmails);
  if (mode === "chats") {
    const rows = new Map<string, Chat>();
    for (const message of grouped) {
      const inboxIds = [...new Set(message.sources.map(s => s.inboxId))];
      const row = rows.get(message.chatKey);
      if (row) {
        row.unread ||= message.unread;
        row.inboxIds = [...new Set([...row.inboxIds, ...inboxIds])];
      } else {
        rows.set(message.chatKey, {
          id: await tokens.issue("chat", message.chatKey), participants: message.participants,
          latestAt: message.header.sentAt, subject: message.header.subject, unread: message.unread, inboxIds,
        });
      }
    }
    return c.json({ chats: [...rows.values()], cursor: scan.cursor, failures: scan.failures });
  }

  const target = grouped.filter(message => message.chatKey === chatKey);
  const { bodies, failures } = await loadBodies(target, loadAccount);
  const messages: ChatMessage[] = [];
  for (const message of target) {
    const body = bodies.get(message.stableId);
    if (body === undefined) continue; // It may have been deleted between header and body requests.
    const {header} = message;
    messages.push({
      id: await tokens.issue("message", messageLocator(message)), key: message.stableId, topicId: message.topicId,
      ancestorKeys: ancestorKeys(header),
      from: header.from[0] ?? {email: "", name: "Unknown sender"}, to: header.to, cc: header.cc,
      replyTo: header.replyTo, subject: header.subject, body, sentAt: header.sentAt, outgoing: message.outgoing,
      unread: message.unread, inboxIds: [...new Set(message.sources.map(s => s.inboxId))],
    });
  }
  const combined = new Map([...scan.failures, ...failures].map(failure => [failure.inboxId, failure]));
  return c.json({ messages, cursor: scan.cursor, failures: [...combined.values()] });
}

async function loadBodies(messages: GroupedMessage[], loadAccount: AccountLoader) {
  const bodies = new Map<string, string>();
  const failed = new Set<string>();
  // Batch primary copies by inbox. Only try another copy if the first could not be read.
  const maxCopies = Math.max(0, ...messages.map(message => message.sources.length));
  for (let index = 0; index < maxCopies; index++) {
    const batches = new Map<string, Array<{key: string; source: MailSource}>>();
    for (const message of messages) {
      if (bodies.has(message.stableId)) continue;
      const copy = message.sources[index];
      if (!copy || failed.has(copy.inboxId)) continue;
      const items = batches.get(copy.inboxId) ?? [];
      items.push({key: message.stableId, source: copy.source});
      batches.set(copy.inboxId, items);
    }
    await inBatches([...batches], async ([id, items]) => {
      try {
        const account = await loadAccount(id);
        if (!account) return;
        const response = await fetchBodies(account, items.map(item => item.source));
        const bySource = new Map(items.map(item => [sourceKey(item.source), item.key]));
        for (const {source, body} of response) {
          const key = bySource.get(sourceKey(source));
          if (key) bodies.set(key, body);
        }
      } catch {
        failed.add(id);
      }
    });
    if (bodies.size === messages.length) break;
  }
  return { bodies, failures: [...failed].map(unavailable) };
}

mailRoutes.post("/chats", c => page(c, "chats"));
mailRoutes.post("/messages", c => page(c, "messages"));
mailRoutes.post("/read", async c => {
  const { messageIds } = await input(c);
  if (!Array.isArray(messageIds) || messageIds.length > 50 || messageIds.some(id => typeof id !== "string")) return invalidRequest();
  const userId = c.get("user").id;
  const tokens = mailTokens(c.env.AUTH_SECRET, userId);
  const byInbox = new Map<string, Map<string, {source: MailSource; key: string}>>();
  for (const token of new Set<string>(messageIds)) {
    const locator = await tokens.open<MessageLocator>("message", token);
    for (const {inboxId,source} of locator.sources) {
      const bucket = byInbox.get(inboxId) ?? new Map();
      bucket.set(sourceKey(source), {source, key: locator.key});
      byInbox.set(inboxId, bucket);
    }
  }
  await inBatches([...byInbox], async ([id, items]) => {
    const account = await getMailAccount(c.env, userId, id);
    if (!account) return;
    const sources = [...items.values()].map(item => item.source);
    try {
      for (let i = 0; i < sources.length; i += 40) {
        const headers = await fetchHeaders(account, sources.slice(i, i + 40));
        const matching = groupHeaders(headers.map(header => ({ inboxId: id, header })), [])
          .flatMap(msg => msg.sources.filter(({source}) => items.get(sourceKey(source))?.key === msg.stableId))
          .map(item => item.source);
        if (matching.length) await markSeen(account, matching);
      }
    } catch {
      throw new MailRequestError(503, "MAILBOX_UNAVAILABLE", "Couldn't update the read status. Try again.");
    }
  });
  return c.json({ ok: true });
});

mailRoutes.onError((error, c) => {
  if (error instanceof MailRequestError) return apiError(c, error.status, error.code, error.message);
  return apiError(c, 500, "INTERNAL_ERROR", "Could not open this mailbox.");
});

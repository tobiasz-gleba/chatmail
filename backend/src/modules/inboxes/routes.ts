import { Hono, type Context } from "hono";
import { apiError, type AppEnv } from "../../http";
import { verifyImap } from "../../mail/protocol-imap";
import { verifySmtp } from "../../mail/protocol-smtp";
import { disconnectInbox, getInbox, listInboxes, loadAccountVersion, persistAccount } from "./store";
import { parseAccount, SettingsError } from "./settings";

export function createInboxRoutes(verify = { imap: verifyImap, smtp: verifySmtp }) {
  const routes = new Hono<AppEnv>();
  routes.get("/", async c => c.json({ inboxes: await listInboxes(c.env, c.get("user").id) }));
  routes.get("/:id", async c => {
    const inbox = await getInbox(c.env, c.get("user").id, c.req.param("id"));
    return inbox ? c.json({ inbox }) : apiError(c, 404, "INBOX_NOT_FOUND", "Inbox not found.");
  });

  async function save(c: Context<AppEnv>, inboxId?: string) {
    const userId = c.get("user").id;
    const prior = inboxId ? await loadAccountVersion(c.env, userId, inboxId) : null;
    if (inboxId && !prior) return apiError(c, 404, "INBOX_NOT_FOUND", "Inbox not found.");
    let input: unknown;
    try { input = await c.req.json(); }
    catch { return apiError(c, 400, "INVALID_SETTINGS", "Enter your mailbox and server settings."); }
    let account;
    try {
      account = parseAccount(input, inboxId ?? crypto.randomUUID(), prior?.account);
    } catch (error) {
      if (error instanceof SettingsError) return apiError(c, 400, "INVALID_SETTINGS", error.message);
      throw error;
    }
    try { await verify.imap(account); }
    catch { return apiError(c, 422, "IMAP_CONNECTION_FAILED", "Couldn’t connect to the incoming IMAP server. Check its settings and password."); }
    try { await verify.smtp(account); }
    catch { return apiError(c, 422, "SMTP_CONNECTION_FAILED", "Couldn’t connect to the outgoing SMTP server. Check its settings and password."); }

    const inbox = await persistAccount(c.env, userId, account, prior?.version);
    if (!inbox) return apiError(c, 409, "INBOX_CONFLICT", "The mailbox address is already connected or its settings changed. Refresh your inboxes.");
    return c.json({ inbox }, inboxId ? 200 : 201);
  }

  routes.post("/", c => save(c));
  routes.put("/:id", c => save(c, c.req.param("id")));
  routes.delete("/:id", async c => {
    const removed = await disconnectInbox(c.env, c.get("user").id, c.req.param("id"));
    return removed ? c.json({ ok: true }) : apiError(c, 404, "INBOX_NOT_FOUND", "Inbox not found.");
  });
  return routes;
}

export const inboxRoutes = createInboxRoutes();

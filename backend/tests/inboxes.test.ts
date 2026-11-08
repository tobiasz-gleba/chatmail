import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import type { Inbox, InboxInput } from "../../shared/contracts";
import type { AppEnv } from "../src/http";
import { createInboxRoutes } from "../src/modules/inboxes/routes";
import { getMailAccount } from "../src/modules/inboxes/store";

async function fixture() {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const owner = { id: crypto.randomUUID(), email: "owner-" + crypto.randomUUID() + "@example.org" };
  const other = { id: crypto.randomUUID(), email: "other-" + crypto.randomUUID() + "@example.org" };
  for (const user of [owner, other]) {
    await env.DB.prepare("INSERT INTO users(id,email,created_at) VALUES(?,?,?)").bind(user.id, user.email, Date.now()).run();
  }
  const bindings = { ...env, DB: env.DB, MAIL_KEY: btoa("k".repeat(32)) };
  const verify = { imap: vi.fn(async () => {}), smtp: vi.fn(async () => {}) };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", "inbox-test");
    c.set("user", c.req.header("x-test-user") === "other" ? other : owner);
    await next();
  });
  app.route("/api/inboxes", createInboxRoutes(verify));
  function request(method: string, path = "", body?: unknown, who = "owner") {
    return app.request("/api/inboxes" + path, {
      method, headers: { "x-test-user": who, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, bindings);
  }
  const input: InboxInput = {
    email: "work@example.org",
    imap: { host: "imap.example.org", port: 993, username: "" },
    smtp: { host: "smtp.example.org", port: 587, username: "" },
    separateSmtpCredentials: false, password: "received password",
  };
  return { owner, other, request, input, bindings, verify };
}

it("verifies, encrypts, lists and disconnects mailboxes only for their owner", async () => {
  const { owner, other, request, input, bindings, verify } = await fixture();
  const response = await request("POST", "", input);
  expect(response.status).toBe(201);
  const { inbox } = await response.json() as { inbox: Inbox };
  expect(inbox.imap.username).toBe(input.email);
  expect(inbox.smtp.username).toBe(input.email);
  expect(Object.keys(inbox).sort()).toEqual(["email", "id", "imap", "separateSmtpCredentials", "smtp"]);
  expect(verify.imap).toHaveBeenCalledTimes(1);
  expect(verify.smtp).toHaveBeenCalledTimes(1);

  const row = await env.DB.prepare("SELECT * FROM inboxes WHERE id = ?").bind(inbox.id).first();
  expect(JSON.stringify(row)).not.toContain(input.password);
  expect(row?.encrypted_credentials).toMatch(/^v1\./);
  expect(await getMailAccount(bindings, owner.id, inbox.id)).toEqual({ ...inbox, password: input.password, smtpPassword: input.password });
  expect(await getMailAccount(bindings, other.id, inbox.id)).toBeNull();

  const second = await request("POST", "", { ...input, email: "home@example.org" });
  expect(second.status).toBe(201);
  expect((await request("POST", "", input)).status).toBe(409);
  expect((await request("PUT", "/" + inbox.id, { ...input, email: "home@example.org" })).status).toBe(409);
  const list = await (await request("GET")).json() as { inboxes: Inbox[] };
  expect(list.inboxes).toHaveLength(2);
  expect(JSON.stringify(list)).not.toContain("password");
  expect(await (await request("GET", "", undefined, "other")).json()).toEqual({ inboxes: [] });
  expect((await request("PUT", "/" + inbox.id, input, "other")).status).toBe(404);
  expect((await request("DELETE", "/" + inbox.id, undefined, "other")).status).toBe(404);
  expect((await request("DELETE", "/" + inbox.id)).status).toBe(200);
  expect(await getMailAccount(bindings, owner.id, inbox.id)).toBeNull();
});

it("validates public endpoints before connection and preserves existing credentials on failed edits", async () => {
  const { request, input, verify, owner, bindings } = await fixture();
  for (const host of ["127.0.0.1", "[::1]", "localhost", "mail.internal", "https://mail.example.org/path"]) {
    expect((await request("POST", "", { ...input, imap: { ...input.imap, host } })).status).toBe(400);
  }
  expect((await request("POST", "", { ...input, smtp: { ...input.smtp, port: 25 } })).status).toBe(400);
  expect(verify.imap).not.toHaveBeenCalled();
  verify.imap.mockRejectedValueOnce(new Error("secret IMAP response"));
  const failed = await request("POST", "", input);
  expect(failed.status).toBe(422);
  expect(await failed.json()).toMatchObject({ error: { code: "IMAP_CONNECTION_FAILED" } });
  expect(verify.smtp).not.toHaveBeenCalled();
  expect(await (await request("GET")).json()).toEqual({ inboxes: [] });

  const { inbox } = await (await request("POST", "", input)).json() as { inbox: Inbox };
  const path = "/" + inbox.id;
  const changedServer = { ...input, password: "", smtp: { ...input.smtp, host: "other.example.org" } };
  expect((await request("PUT", path, changedServer)).status).toBe(400);
  expect(verify.smtp).toHaveBeenCalledTimes(1);

  verify.smtp.mockRejectedValueOnce(new Error("secret SMTP response"));
  const smtpError = await request("PUT", path, { ...changedServer, password: "replacement secret" });
  expect(smtpError.status).toBe(422);
  expect(await smtpError.json()).toMatchObject({ error: { code: "SMTP_CONNECTION_FAILED" } });
  expect((await getMailAccount(bindings, owner.id, inbox.id))?.password).toBe(input.password);
  expect((await request("PUT", path, { ...input, password: "" })).status).toBe(200);

  const separated = { ...input, password: "", separateSmtpCredentials: true, smtp: { ...input.smtp, username: "smtp-login" } };
  expect((await request("PUT", path, separated)).status).toBe(400);
  expect((await request("PUT", path, { ...separated, smtpPassword: "outgoing secret" })).status).toBe(200);
  expect((await getMailAccount(bindings, owner.id, inbox.id))?.smtpPassword).toBe("outgoing secret");
  // A storage-level server substitution cannot redirect the encrypted credentials.
  await env.DB.prepare("UPDATE inboxes SET imap_host = ? WHERE id = ?").bind("another.example.org", inbox.id).run();
  await expect(getMailAccount(bindings, owner.id, inbox.id)).rejects.toThrow();
});

it("does not restore credentials disconnected while an edit is verifying", async () => {
  const { request, input, verify, owner, bindings } = await fixture();
  const { inbox } = await (await request("POST", "", input)).json() as { inbox: Inbox };
  const path = "/" + inbox.id;
  let start!: () => void;
  let resume!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  verify.smtp.mockImplementationOnce(async () => {
    start();
    await gate;
  });
  const verifying = request("PUT", path, { ...input, password: "new password" });
  await started;
  expect((await request("DELETE", path)).status).toBe(200);
  resume();
  expect((await verifying).status).toBe(409);
  expect(await getMailAccount(bindings, owner.id, inbox.id)).toBeNull();
});

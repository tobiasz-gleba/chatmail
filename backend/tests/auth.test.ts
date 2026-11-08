import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { authRoutes } from "../src/modules/auth/routes";

const origin = "https://chatmail.example";

function client() {
  const deliveries: string[] = [];
  const emailBinding: SendEmail = {
    async send(message: EmailMessage | EmailMessageBuilder) {
      if (!("text" in message) || !message.text) throw new Error("Expected a text email");
      deliveries.push(message.text);
      return { messageId: crypto.randomUUID() };
    },
  };
  const bindings = {
    ...env,
    DB: env.DB,
    AUTH_SECRET: "local-only-auth-test-secret-32-bytes-long",
    OTP_FROM: "codes@chatmail.example",
    EMAIL: emailBinding,
  };
  function post(path: string, body: unknown, cookie = "") {
    return authRoutes.request(origin + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie },
      body: JSON.stringify(body),
    }, bindings);
  }
  return {
    deliveries,
    requestCode: (email: string) => post("/auth/code", { email }),
    verify: (email: string, code: string) => post("/auth/verify", { email, code }),
    session: (cookie: string) => authRoutes.request(origin + "/session", { headers: { Cookie: cookie } }, bindings),
    logout: (cookie: string) => post("/logout", {}, cookie),
    getCode() {
      const code = deliveries.at(-1)?.match(/\b\d{6}\b/)?.[0];
      if (!code) throw new Error("No six-digit code was delivered");
      return code;
    },
  };
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

it("creates an account only after verification, uses a secure revocable session, and rejects code replay", async () => {
  const api = client();
  const email = "first@example.org";
  const requested = await api.requestCode(email);
  expect(requested.ok).toBe(true);
  expect(await requested.json()).toEqual({ ok: true });
  const userQuery = env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email);
  expect(await userQuery.first()).toBeNull();
  const code = api.getCode();
  const digest = await env.DB.prepare("SELECT code_digest FROM auth_challenges WHERE email = ?")
    .bind(email).first<string>("code_digest");
  expect(digest).toBeTruthy();
  expect(digest).not.toBe(code);

  const verified = await api.verify(email, code);
  expect(verified.ok).toBe(true);
  const identity = await verified.json<{ user: { id: string; email: string } }>();
  expect(identity).toEqual({ user: { email, id: expect.any(String) } });
  const setCookie = verified.headers.get("Set-Cookie") ?? "";
  expect(setCookie).toMatch(/;\s*Secure/i);
  expect(setCookie).toMatch(/;\s*HttpOnly/i);
  expect(setCookie).toMatch(/;\s*SameSite=(Lax|Strict)/i);
  const cookie = setCookie.split(";")[0];
  expect(await (await api.session(cookie)).json()).toEqual(identity);
  expect((await api.verify(email, code)).status).toBe(400);
  expect((await api.logout(cookie)).ok).toBe(true);
  expect(await (await api.session(cookie)).json()).toEqual({ user: null });
});

it("returns the existing identity to a returning user", async () => {
  const api = client();
  const email = "returning@example.org";
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .bind(id, email, Date.now()).run();
  expect((await api.requestCode(email)).ok).toBe(true);
  expect(await (await api.verify(email, api.getCode())).json()).toEqual({ user: { id, email } });
});

it("rejects an expired code and prevents a burst of resend requests", async () => {
  const api = client();
  const email = "expired@example.org";
  const requests = await Promise.all([api.requestCode(email), api.requestCode(email)]);
  expect(requests.map(response => response.status).sort()).toEqual([200, 429]);
  expect(api.deliveries).toHaveLength(1);
  const ttl = await env.DB.prepare("SELECT expires_at - created_at AS ttl FROM auth_challenges WHERE email = ?")
    .bind(email).first<number>("ttl");
  expect(ttl).toBe(10 * 60 * 1000);
  await env.DB.prepare("UPDATE auth_challenges SET expires_at = ? WHERE email = ?")
    .bind(Date.now() - 1000, email).run();
  expect((await api.verify(email, api.getCode())).status).toBe(400);
  expect(await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first()).toBeNull();
});

it("locks a code after five incorrect attempts", async () => {
  const api = client();
  const email = "attempts@example.org";
  await api.requestCode(email);
  const correct = api.getCode();
  const incorrect = correct === "000000" ? "111111" : "000000";
  for (let attempt = 0; attempt < 5; attempt++) {
    expect((await api.verify(email, incorrect)).status).toBe(400);
  }
  expect((await api.verify(email, correct)).status).toBe(400);
});

it("grants only one concurrent verification of a code", async () => {
  const api = client();
  const email = "race@example.org";
  await api.requestCode(email);
  const code = api.getCode();
  const responses = await Promise.all([api.verify(email, code), api.verify(email, code)]);
  expect(responses.map(response => response.status).sort()).toEqual([200, 400]);
  const count = await env.DB.prepare(`SELECT count(*) AS count FROM sessions
    JOIN users ON sessions.user_id = users.id WHERE users.email = ?`)
    .bind(email).first<number>("count");
  expect(count).toBe(1);
});

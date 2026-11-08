import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { User } from "@shared/contracts";
import { type AppEnv, apiError } from "../../http";

const minute = 60_000;
const hour = 60 * minute;
const challengeLifetime = 10 * minute;
const attemptLimit = 5;
const sessionLifetime = 30 * 24 * hour;
const cookieName = "__Host-chatmail_session";
const cookieOptions = { path: "/", httpOnly: true, secure: true, sameSite: "Lax" } as const;
const encoder = new TextEncoder();

type AuthContext = Context<AppEnv>;

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 254) return null;
  const email = value.trim().toLowerCase();
  const [local, domain, extra] = email.split("@");
  if (!local || local.length > 64 || !domain || extra !== undefined) return null;
  if (!local.split(".").every((part) => /^[a-z0-9!#$%&'*+\/=?^_`{|}~-]+$/.test(part))) return null;
  const labels = domain.split(".");
  return labels.length >= 2 && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    ? email : null;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function keyedDigest(secret: string, parts: string[]): Promise<string> {
  if (!secret || secret.length < 32) throw new Error("Authentication secret is missing or too short.");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify(parts)));
  return hex(new Uint8Array(signature));
}

async function tokenDigest(token: string) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token))));
}

function generateCode() {
  // Rejection sampling makes every six-digit value equally likely.
  const values = new Uint32Array(1);
  do { crypto.getRandomValues(values); } while (values[0] >= 4_294_000_000);
  return (values[0] % 1_000_000).toString().padStart(6, "0");
}

async function readInput(c: AuthContext): Promise<Record<string, unknown>> {
  const value: unknown = await c.req.json().catch(() => null);
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

async function consumeRateLimit(c: AuthContext, kind: string, identity: string, limit: number, now: number) {
  const key = await keyedDigest(c.env.AUTH_SECRET, ["rate", kind, identity]);
  const windowStart = Math.floor(now / hour) * hour;
  const result = await c.env.DB.prepare(
    `INSERT INTO auth_rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
       window_start = excluded.window_start
     WHERE window_start < excluded.window_start OR count < ?`,
  ).bind(key, windowStart, limit).run();
  return result.meta.changes === 1;
}

function rateLimited(c: AuthContext, retryAfter: number) {
  c.header("Retry-After", String(retryAfter));
  return apiError(c, 429, "RATE_LIMITED", "Too many requests. Please try again later.");
}

async function sessionDigest(c: AuthContext) {
  const token = getCookie(c, cookieName);
  return token && /^[a-f0-9]{64}$/.test(token) ? tokenDigest(token) : null;
}

async function getUser(c: AuthContext): Promise<User | null> {
  const digest = await sessionDigest(c);
  if (!digest) return null;
  return c.env.DB.prepare(
    `SELECT users.id, users.email FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_digest = ? AND sessions.expires_at > ?`,
  ).bind(digest, Date.now()).first<User>();
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await getUser(c);
  if (!user) return apiError(c, 401, "UNAUTHENTICATED", "Sign in to continue.");
  c.set("user", user);
  await next();
};

export const authRoutes = new Hono<AppEnv>();

authRoutes.post("/auth/code", async (c) => {
  const input = await readInput(c);
  const email = normalizeEmail(input.email);
  if (!email) return apiError(c, 400, "INVALID_EMAIL", "Enter a valid email address.");

  const now = Date.now();
  const ip = c.req.header("CF-Connecting-IP") ?? "local";
  const windowSeconds = Math.ceil((hour - (now % hour)) / 1000);
  if (!await consumeRateLimit(c, "request-ip", ip, 30, now)) return rateLimited(c, windowSeconds);
  const db = c.env.DB;
  const previous = await db.prepare("SELECT created_at FROM auth_challenges WHERE email = ?")
    .bind(email).first<number>("created_at");
  if (previous !== null && previous + minute > now) {
    return rateLimited(c, Math.ceil((previous + minute - now) / 1000));
  }
  if (!await consumeRateLimit(c, "request-email", email, 6, now)) return rateLimited(c, windowSeconds);
  const code = generateCode();
  const digest = await keyedDigest(c.env.AUTH_SECRET, ["code", email, code]);
  // Claim the resend window before calling the provider, including concurrent requests.
  const [result] = await db.batch([
    db.prepare(`INSERT INTO auth_challenges (email, code_digest, created_at, expires_at, attempts)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(email) DO UPDATE SET code_digest = excluded.code_digest,
         created_at = excluded.created_at, expires_at = excluded.expires_at, attempts = 0
       WHERE auth_challenges.created_at <= ?`).bind(email, digest, now, now + challengeLifetime, now - minute),
    db.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").bind(now),
    db.prepare("DELETE FROM auth_rate_limits WHERE window_start < ?").bind(now - hour),
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
  ]);
  if (result.meta.changes !== 1) return rateLimited(c, 60);

  try {
    await c.env.EMAIL.send({
      from: { email: c.env.OTP_FROM, name: "Chatmail" },
      to: email,
      subject: "Your Chatmail sign-in code",
      text: `Your Chatmail sign-in code is ${code}. It expires in 10 minutes.`,
    });
  } catch {
    await db.prepare("DELETE FROM auth_challenges WHERE email = ? AND code_digest = ? AND created_at = ?")
      .bind(email, digest, now).run();
    return apiError(c, 503, "CODE_DELIVERY_FAILED", "We couldn’t send the sign-in code. Please try again.");
  }
  return c.json({ ok: true });
});

authRoutes.post("/auth/verify", async (c) => {
  const input = await readInput(c);
  const email = normalizeEmail(input.email);
  const code = input.code;
  if (!email || typeof code !== "string" || !/^\d{6}$/.test(code)) {
    return apiError(c, 400, "INVALID_CODE", "Enter the six-digit code from your email.");
  }

  const now = Date.now();
  const ip = c.req.header("CF-Connecting-IP") ?? "local";
  if (!await consumeRateLimit(c, "verify-ip", ip, 100, now)) {
    return rateLimited(c, Math.ceil((hour - (now % hour)) / 1000));
  }
  const digest = await keyedDigest(c.env.AUTH_SECRET, ["code", email, code]);
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const session = await tokenDigest(token);
  const db = c.env.DB;
  const valid = "email = ? AND code_digest = ? AND expires_at > ? AND attempts < ?";
  const challenge = [email, digest, now, attemptLimit];

  // D1 executes the batch as one transaction. A competing verification sees
  // the deleted challenge and cannot mint a second session, even on a retry.
  const results = await db.batch([
    db.prepare(`INSERT INTO users (id, email, created_at)
      SELECT ?, email, ? FROM auth_challenges WHERE ${valid}
      ON CONFLICT(email) DO NOTHING`).bind(crypto.randomUUID(), now, ...challenge),
    db.prepare(`INSERT INTO sessions (token_digest, user_id, created_at, expires_at)
      SELECT ?, users.id, ?, ? FROM users WHERE email IN
      (SELECT email FROM auth_challenges WHERE ${valid})`).bind(session, now, now + sessionLifetime, ...challenge),
    db.prepare(`DELETE FROM auth_challenges WHERE ${valid}`).bind(...challenge),
    db.prepare(`UPDATE auth_challenges SET attempts = attempts + 1
      WHERE email = ? AND code_digest <> ? AND expires_at > ? AND attempts < ?`).bind(...challenge),
    db.prepare(`SELECT users.id, users.email FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE token_digest = ?`).bind(session),
  ]);
  const user = results[4].results[0] as User | undefined;
  if (!user) return apiError(c, 400, "INVALID_CODE", "This code is incorrect or has expired.");
  setCookie(c, cookieName, token, { ...cookieOptions, maxAge: sessionLifetime / 1000 });
  return c.json({ user });
});

authRoutes.get("/session", async (c) => c.json({ user: await getUser(c) }));

authRoutes.post("/logout", async (c) => {
  const digest = await sessionDigest(c);
  if (digest) await c.env.DB.prepare("DELETE FROM sessions WHERE token_digest = ?").bind(digest).run();
  deleteCookie(c, cookieName, cookieOptions);
  return c.json({ ok: true });
});

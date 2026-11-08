import { verifyImap } from "../src/mail/protocol-imap";
import { verifySmtp } from "../src/mail/protocol-smtp";

interface ProbeEnv {
  EXPIRY: number;
  TOKEN_HASH: string;
  TARGETS: Record<string, string>;
}

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (Date.now() >= env.EXPIRY) return new Response(null, { status: 410 });
    if (request.method === "GET" && path === "/ready") return new Response(env.TOKEN_HASH);
    const host = Object.hasOwn(env.TARGETS, path) && env.TARGETS[path];
    if (!host || request.method !== "POST") return new Response(null, { status: 404 });
    const bearer = /^Bearer ([\da-f]{64})$/.exec(request.headers.get("authorization") ?? "");
    if (!bearer) return new Response(null, { status: 403 });
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer[1]));
    if (new Uint8Array(hash).toHex() !== env.TOKEN_HASH) return new Response(null, { status: 403 });
    try {
      const { user, pass } = await request.json<{ user: string; pass: string }>();
      if (!user || !pass || typeof user !== "string" || typeof pass !== "string") return new Response(null, { status: 400 });
      const [, protocol, port] = path.split("/");
      const endpoint = { host, port: Number(port), username: user };
      const account = {
        id: "hosted-smoke", email: "fixture@example.invalid", password: pass, smtpPassword: pass,
        imap: endpoint, smtp: endpoint, separateSmtpCredentials: false,
      };
      if (protocol === "imap") await verifyImap(account);
      else await verifySmtp(account);
      return new Response(null, { status: 204 });
    } catch {
      return new Response(null, { status: 422 });
    }
  },
};

import type { ContentfulStatusCode } from "hono/utils/http-status";

export class MailRequestError extends Error {
  constructor(readonly status: ContentfulStatusCode, readonly code: string, message: string) {
    super(message);
  }
}

export function invalidRequest(): never {
  throw new MailRequestError(400, "INVALID_MAIL_REQUEST", "Refresh the mailbox and try again.");
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(base64url: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64url.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
}

// Tokens are MACed for a single user and operation. They travel in POST bodies only.
export function mailTokens(secret: string, userId: string) {
  const key = crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const signatureInput = (kind: string, payload: string) => encoder.encode(JSON.stringify(["chatmail.live.v1", userId, kind, payload]));
  return {
    async issue(kind: string, value: unknown) {
      const payload = encode(encoder.encode(JSON.stringify(value)));
      const signature = await crypto.subtle.sign("HMAC", await key, signatureInput(kind, payload));
      return payload + "." + encode(new Uint8Array(signature));
    },
    async open<T>(kind: string, token: string): Promise<T> {
      if (typeof token !== "string" || token.length > 2 * 1024 * 1024) return invalidRequest();
      const [payload, signature, extra] = token.split(".");
      if (!payload || !signature || extra !== undefined) return invalidRequest();
      try {
        if (!await crypto.subtle.verify("HMAC", await key, decode(signature), signatureInput(kind, payload))) return invalidRequest();
        return JSON.parse(decoder.decode(decode(payload))) as T;
      } catch {
        return invalidRequest();
      }
    },
  };
}

export type Tokens = ReturnType<typeof mailTokens>;

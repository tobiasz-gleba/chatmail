import type { Context } from "hono";
import type { RequestIdVariables } from "hono/request-id";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { User } from "@shared/contracts";

export type AppEnv = {
  Bindings: Env;
  Variables: RequestIdVariables & { user: User };
};

const errors = {
  NOT_FOUND: { status: 404, message: "Route not found." },
  DATABASE_UNAVAILABLE: { status: 503, message: "Database is not ready." },
  INTERNAL_ERROR: { status: 500, message: "Internal server error." },
} as const;

export function errorResponse(c: Context<AppEnv>, code: keyof typeof errors) {
  const { message, status } = errors[code];
  return apiError(c, status, code, message);
}

export function apiError(c: Context<AppEnv>, status: ContentfulStatusCode, code: string, message: string) {
  return c.json({ error: { code, message }, requestId: c.get("requestId") }, status);
}

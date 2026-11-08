import { Hono } from "hono";
import { requestId } from "hono/request-id";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, apiError, errorResponse } from "./http";
import { healthRoutes } from "./modules/health/routes";
import { authRoutes, requireUser } from "./modules/auth/routes";
import { inboxRoutes } from "./modules/inboxes/routes";
import { mailRoutes } from "./modules/mail/routes";
import { sendRoutes } from "./modules/send/routes";

export const app = new Hono<AppEnv>();

app.use("*", requestId());
app.use("*", async (c, next) => {
  const startedAt = Date.now();
  await next();
  console.info({
    event: "http_request",
    requestId: c.get("requestId"),
    method: c.req.method,
    route: c.req.routePath,
    status: c.res.status,
    durationMs: Date.now() - startedAt,
  });
});

app.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  if (!["GET", "HEAD"].includes(c.req.method)) {
    const origin = c.req.header("Origin");
    if ((origin && origin !== new URL(c.req.url).origin) || c.req.header("Sec-Fetch-Site") === "cross-site") {
      return apiError(c, 403, "ORIGIN_DENIED", "Open Chatmail to complete this request.");
    }
    if (c.req.method !== "DELETE" && c.req.header("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      return apiError(c, 415, "JSON_REQUIRED", "Send the request as JSON.");
    }
  }
  await next();
});
app.use("/api/*", bodyLimit({ maxSize: 1024 * 1024, onError: (c) =>
  apiError(c, 413, "REQUEST_TOO_LARGE", "This request exceeds the size limit.") }));
app.route("/api", authRoutes);
app.use("/api/inboxes/*", requireUser);
app.use("/api/mail/*", requireUser);
app.route("/api/inboxes", inboxRoutes);
app.route("/api/mail", mailRoutes);
app.route("/api/mail", sendRoutes);
app.route("/", healthRoutes);
app.notFound((c) => errorResponse(c, "NOT_FOUND"));
app.onError((_error, c) => {
  console.error({
    event: "unhandled_error",
    requestId: c.get("requestId"),
  });
  return errorResponse(c, "INTERNAL_ERROR");
});

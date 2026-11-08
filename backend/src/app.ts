import { Hono } from "hono";
import { requestId } from "hono/request-id";
import { type AppEnv, errorResponse } from "./http";
import { healthRoutes } from "./modules/health/routes";

export const app = new Hono<AppEnv>();

app.use("*", requestId());
app.use("*", async (c, next) => {
  const startedAt = Date.now();
  await next();
  console.info({
    event: "http_request",
    requestId: c.get("requestId"),
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs: Date.now() - startedAt,
  });
});

app.route("/", healthRoutes);
app.notFound((c) => errorResponse(c, "NOT_FOUND"));
app.onError((error, c) => {
  console.error({
    event: "unhandled_error",
    requestId: c.get("requestId"),
    message: error.message,
  });
  return errorResponse(c, "INTERNAL_ERROR");
});

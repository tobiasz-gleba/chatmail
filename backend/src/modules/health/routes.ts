import { Hono } from "hono";
import { createDatabase } from "../../db/client";
import { appMetadata } from "../../db/schema";
import { type AppEnv, errorResponse } from "../../http";

export const healthRoutes = new Hono<AppEnv>();

healthRoutes.get("/health", (c) => c.json({ status: "ok" }));

healthRoutes.get("/ready", async (c) => {
  try {
    const db = createDatabase(c.env.DB);
    await db.select({ key: appMetadata.key }).from(appMetadata).limit(1);
  } catch (error) {
    console.warn({
      event: "database_unavailable",
      requestId: c.get("requestId"),
      message: error instanceof Error ? error.message : "Database query failed",
    });
    return errorResponse(c, "DATABASE_UNAVAILABLE");
  }
  return c.json({ status: "ready" });
});

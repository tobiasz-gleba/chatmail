import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

it("stays live on an empty database and becomes ready after applying the migrations", async () => {
  const health = await exports.default.fetch("http://localhost/health");
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ status: "ok" });

  const unavailable = await exports.default.fetch("http://localhost/ready");
  const requestId = unavailable.headers.get("x-request-id");
  expect(requestId).toBeTruthy();
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({
    error: { code: "DATABASE_UNAVAILABLE", message: "Database is not ready." },
    requestId,
  });

  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

  const ready = await exports.default.fetch("http://localhost/ready");
  expect(ready.status).toBe(200);
  expect(await ready.json()).toEqual({ status: "ready" });
});

it("returns a JSON error and the same request ID in the body and header for unknown routes", async () => {
  const response = await exports.default.fetch("http://localhost/missing");
  const requestId = response.headers.get("x-request-id");
  expect(requestId).toBeTruthy();
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual({
    error: { code: "NOT_FOUND", message: "Route not found." },
    requestId,
  });
});

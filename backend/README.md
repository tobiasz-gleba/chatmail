# Chatmail backend

This Hono API runs on Cloudflare Workers. Wrangler runs the Worker and its SQLite-backed D1 database locally. The quick start works without a Cloudflare account.

## Run locally

Use Node.js 24 (see `.nvmrc`) and npm. From the repository root, run:

```sh
cd backend
npm ci
npm run db:migrate:local
npm run dev
```

Open [http://localhost:8787/health](http://localhost:8787/health) to check the Worker, or [http://localhost:8787/ready](http://localhost:8787/ready) to check the database. Wrangler stores local D1 data under `.wrangler/state/` and reuses it across restarts.

| Endpoint | Expected response |
| --- | --- |
| `GET /health` | `200 {"status":"ok"}` while the Worker is running, including before migrations. |
| `GET /ready` | `200 {"status":"ready"}` when the Worker can query `app_metadata`. An unavailable database or missing table returns `503` with the code `DATABASE_UNAVAILABLE`. |

Responses include an `X-Request-Id` header. JSON errors also include the same `requestId` alongside `error.code` and `error.message`. Use the ID to find the matching structured request log.

## Add a database change

1. Edit the Drizzle SQLite schema in `src/db/schema.ts`.
2. Run `npm run db:generate -- --name=describe_the_change`. Review the generated SQL and commit it together with the changes to `migrations/meta/`.
3. Run `npm run db:migrations:list` to see pending migrations, then `npm run db:migrate:local` to apply them. Wrangler records applied migrations so this command can be repeated.

## Extend and check the API

The Worker entrypoint exports the Hono app from `src/app.ts`, which mounts feature routes and shared middleware. Add features under `src/modules/` and mount them in the app. The health module shows how to use the current request’s D1 binding with the Drizzle client in `src/db/client.ts`.

| Command | Purpose |
| --- | --- |
| `npm run types` | Regenerate `worker-configuration.d.ts` after editing Wrangler bindings or the compatibility date. |
| `npm run typecheck` | Check the app, tests, and tool configuration. |
| `npm test` | Exercise the Worker against a separate, temporary D1 database using the committed migrations. |
| `npm run build` | Bundle the Worker into `dist/` using Wrangler’s deployment dry run. |

# Chatmail backend

Chatmail serves its React interface and Hono API from one Cloudflare Worker. D1 holds users, OTP challenges, sessions, encrypted mailbox credentials, and short-lived send receipts. Chat lists and message bodies are read directly from the connected IMAP servers. Replies and new messages use the selected account's SMTP server.

## Run locally

Use Bun for the frontend and Node.js 24 (see `.nvmrc`) for the Worker. From the repository root:

```sh
(cd frontend && bun install --frozen-lockfile && bun run build)
cd backend
npm ci
node scripts/setup-local.mjs
npm run db:migrate:local
npm run dev
```

Open [Chatmail](http://localhost:8787) and request a sign-in code. Wrangler's local email simulator captures the message and prints its file path in the terminal. Use that code to connect a public IMAP/SMTP mailbox. For frontend hot reload, run `bun run dev` in `frontend` alongside the Worker. Vite proxies `/api` to port 8787.

Local settings are generated once in the ignored `.dev.vars` file. Keep its `MAIL_KEY` to decrypt settings after restarting. Wrangler reuses local D1 data under `.wrangler/state/`.

The app displays up to 128 KiB of decoded text per message and labels truncated bodies. The send endpoint recognizes a submission for 24 hours. A daily maintenance job removes expired receipts, sessions, sign-in challenges, and rate-limit records.

## Configure a hosted instance

Build the frontend first so Wrangler can serve `frontend/dist`. Configure the D1 binding for the intended environment, replacing the local database identifier, and apply the committed migrations to that database. Configure Cloudflare Email Sending for an app-owned sender domain and Workers Paid. Set these three bindings using Wrangler secrets:

| Binding | Value |
| --- | --- |
| `OTP_FROM` | Verified sender address for sign-in codes. |
| `AUTH_SECRET` | High-entropy secret (at least 32 characters) for auth and user-scoped cursor signing. |
| `MAIL_KEY` | Base64-encoded 32 random bytes for version 1 of the credential envelope. Retain this key when updating the Worker. |

Local email uses the simulator. Hosted mail connections require public DNS names and trusted TLS. An inbox password or app password must work with IMAP and SMTP. [Email Sending setup](https://developers.cloudflare.com/email-service/get-started/send-emails/) · [Worker TCP restrictions](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/#considerations)

## Health checks

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

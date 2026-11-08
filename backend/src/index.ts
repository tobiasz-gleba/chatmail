import { app } from "./app";

export default {
  fetch: app.fetch,
  // Bound retention even if a user never signs in or sends another message.
  async scheduled(event, env) {
    const now = event.scheduledTime;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM send_receipts WHERE expires_at <= ?").bind(now),
      env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").bind(now),
      env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
      env.DB.prepare("DELETE FROM auth_rate_limits WHERE window_start < ?").bind(now - 3_600_000),
    ]);
  },
} satisfies ExportedHandler<Env>;

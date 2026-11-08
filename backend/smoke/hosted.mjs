import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

async function modesFromFile(path) {
  if (!path) throw new Error("Usage: node smoke/hosted.mjs /path/to/private-fixture.json");
  const metadata = await stat(path);
  if (!metadata.isFile() || (process.platform !== "win32" && metadata.mode & 0o077)) {
    throw new Error("Use an owner-only credential file (chmod 600).");
  }
  let fixture;
  try { fixture = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error("Cannot read fixture JSON."); }
  const modes = [];
  for (const [protocol, allowed] of [["imap", [143, 993]], ["smtp", [465, 587]]]) {
    const options = fixture?.[protocol];
    if (!options) continue;
    const host = options.host;
    const ports = options.ports ?? [options.port];
    const user = options.user ?? fixture.user, pass = options.pass ?? fixture.pass;
    if (typeof host !== "string" || host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(host)
      || !Array.isArray(ports) || !ports.length || ports.some(port => !allowed.includes(port))
      || typeof user !== "string" || !user.length || typeof pass !== "string" || !pass.length) {
      throw new Error(`Invalid ${protocol.toUpperCase()} fixture hostname, credentials or ports.`);
    }
    for (const port of new Set(ports)) modes.push({ protocol, port, host, user, pass });
  }
  if (!modes.length) throw new Error("Specify an IMAP or SMTP fixture.");
  return modes;
}

async function availablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function run() {
  const modes = await modesFromFile(process.argv[2]);
  const temp = await mkdtemp(join(tmpdir(), "chatmail-hosted-smoke-"));
  const token = randomBytes(32).toString("hex");
  const digest = createHash("sha256").update(token).digest("hex");
  const cancelled = new AbortController();
  const cancel = () => cancelled.abort(new Error("Preview stopped."));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  let child;
  let stopped;
  try {
    const config = join(temp, "wrangler.json");
    await writeFile(config, JSON.stringify({
      name: `chatmail-mail-smoke-${randomBytes(6).toString("hex")}`,
      main: fileURLToPath(new URL("./hosted-worker.ts", import.meta.url)),
      compatibility_date: "2026-11-04", compatibility_flags: ["nodejs_compat"],
      workers_dev: false, observability: { enabled: false },
      vars: { TOKEN_HASH: digest, EXPIRY: Date.now() + 600_000,
        TARGETS: Object.fromEntries(modes.map(mode => [`/${mode.protocol}/${mode.port}`, mode.host])) },
    }), { mode: 0o600 });
    const port = await availablePort();
    const base = `http://127.0.0.1:${port}`;
    const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
    child = spawn(process.execPath, [wrangler, "dev", "--remote", "--config", config, "--ip", "127.0.0.1",
      "--port", String(port), "--inspector-port", "0", "--log-level", "error", "--show-interactive-dev-session=false"], {
      cwd: temp, detached: process.platform !== "win32", stdio: "ignore",
      env: { ...process.env, CI: "1", WRANGLER_LOG_PATH: join(temp, "wrangler.log") },
    });
    stopped = once(child, "exit").catch(() => {});
    const deadline = Date.now() + 90_000;
    for (;;) {
      cancelled.signal.throwIfAborted();
      if (child.exitCode !== null || child.signalCode || Date.now() > deadline) {
        throw new Error("Remote preview did not start. Check Wrangler authentication and account access.");
      }
      const ready = await fetch(base + "/ready", {
        redirect: "error", signal: AbortSignal.any([cancelled.signal, AbortSignal.timeout(2000)]),
      }).catch(() => null);
      if (ready?.ok && await ready.text() === digest) break;
      await delay(400, undefined, { signal: cancelled.signal });
    }
    for (const { protocol, port: targetPort, user, pass } of modes) {
      cancelled.signal.throwIfAborted();
      const response = await fetch(`${base}/${protocol}/${targetPort}`, {
        method: "POST", redirect: "error", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ user, pass }), signal: AbortSignal.any([cancelled.signal, AbortSignal.timeout(55_000)]),
      }).catch(() => null);
      const ok = response?.status === 204;
      console.log(`${protocol.toUpperCase()} ${targetPort} ${ok ? "PASS" : "FAIL"}`);
      if (!ok) process.exitCode = 1;
    }
  } finally {
    if (child?.pid && child.exitCode === null && !child.signalCode) {
      // Wrangler's launcher starts a child process. Stop its whole process group.
      const kill = signal => {
        try { process.kill(process.platform === "win32" ? child.pid : -child.pid, signal); } catch {}
      };
      kill("SIGTERM");
      await Promise.race([stopped, delay(2500, undefined, { ref: false })]);
      kill("SIGKILL");
    }
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    await rm(temp, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error.message); process.exitCode = 1; });

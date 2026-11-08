import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFixture } from "./fixture.mjs";

const temp = await mkdtemp(join(tmpdir(), "chatmail-sockets-"));
const fixtures = [];
let harness;
try {
  const keyPath = join(temp, "fixture.key"), certPath = join(temp, "fixture.pem");
  const caPath = join(temp, "ca.pem"), caKey = join(temp, "ca.key"), csr = join(temp, "server.csr");
  const openssl = (...args) => execFileSync("openssl", args, { stdio: "ignore" });
  openssl("req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-keyout", caKey,
    "-out", caPath, "-days", "1", "-subj", "/CN=Chatmail Test CA", "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign");
  openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", csr, "-subj", "/CN=localhost");
  const extensionFile = join(temp, "server.ext");
  async function certificate(names) {
    await writeFile(extensionFile, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${names}\n`);
    openssl("x509", "-req", "-in", csr, "-CA", caPath, "-CAkey", caKey, "-CAcreateserial", "-days", "1",
      "-sha256", "-extfile", extensionFile, "-out", certPath);
    return { key: await readFile(keyPath), cert: await readFile(certPath) };
  }
  const credentials = await certificate("DNS:localhost");
  const mismatched = await certificate("DNS:wrong.example.invalid");
  // Miniflare reads this at module import and gives this CA to local workerd.
  process.env.NODE_EXTRA_CA_CERTS = caPath;
  const { createTestHarness } = await import("wrangler");
  const configPath = join(temp, "wrangler.json");
  await writeFile(configPath, JSON.stringify({
    name: "chatmail-mail-socket-fixture", main: fileURLToPath(new URL("./worker.ts", import.meta.url)),
    compatibility_date: "2026-11-04", compatibility_flags: ["nodejs_compat"],
  }));
  harness = createTestHarness({ workers: [{ configPath }] });
  await harness.listen();
  for (const [protocol, port] of [["imap", 143], ["imap", 993], ["smtp", 465], ["smtp", 587]]) {
    const implicit = port === 993 || port === 465;
    const cases = ["authenticated over TLS", "refused wrong certificate"];
    if (!implicit) cases.push("refused missing STARTTLS");
    for (const scenario of cases) {
      const valid = scenario === "authenticated over TLS";
      const advertiseTls = scenario !== "refused missing STARTTLS";
      const peer = scenario === "refused wrong certificate" ? mismatched : credentials;
      const fixture = await startFixture(protocol, implicit, peer, advertiseTls);
      fixtures.push(fixture);
      harness.clearLogs();
      const response = await harness.fetch(`/?protocolPort=${port}&fixturePort=${fixture.port}`);
      const trace = fixture.events.map(({ cmd, encrypted }) => `${encrypted ? "TLS" : "plain"}:${cmd}`).join(" ");
      if (response.status !== (valid ? 200 : 422)) console.error(harness.getLogs().slice(-3));
      assert.equal(response.status, valid ? 200 : 422, `${protocol} ${port}: ${await response.text()} ${trace}`);
      const auth = fixture.events.filter(({ cmd }) => ["AUTH", "AUTHENTICATE", "LOGIN"].includes(cmd));
      assert.equal(auth.length, valid ? 1 : 0, trace);
      assert.ok(auth.every(({ encrypted }) => encrypted), trace);
      if (advertiseTls) assert.equal(fixture.events.some(({ cmd }) => cmd === "STARTTLS"), !implicit, trace);
      console.log(`${protocol.toUpperCase()} ${port} ${scenario}`);
      if (valid && protocol === "smtp") {
        const delivery = await harness.fetch(`/?protocolPort=${port}&fixturePort=${fixture.port}&operation=send`);
        assert.equal(delivery.status, 200, await delivery.text());
        assert.equal(fixture.submissions.length, 1);
        const [message] = fixture.submissions;
        assert.equal(message.sender, "FROM:<fixture@example.invalid>");
        assert.deepEqual(message.recipients, ["TO:<to@example.invalid>", "TO:<cc@example.invalid>"]);
        const [rawHeaders, wireBody] = message.raw.split("\r\n\r\n");
        const headers = new Map(rawHeaders.replace(/\r\n[ \t]+/g, " ").split("\r\n").map(line => {
          const colon = line.indexOf(":");
          return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
        }));
        assert.equal(headers.get("from"), "fixture@example.invalid");
        assert.equal(headers.get("subject"), "Re: Socket fixture");
        assert.equal(headers.get("message-id"), "<reply@example.invalid>");
        assert.equal(headers.get("in-reply-to"), "<previous@example.invalid>");
        assert.equal(headers.get("references"), "<first@example.invalid> <previous@example.invalid>");
        const body = headers.get("content-transfer-encoding") === "base64"
          ? Buffer.from(wireBody, "base64").toString("utf8") : wireBody;
        assert.equal(body.trimEnd().replaceAll("\r\n", "\n"), "Hello from workerd.\n.A second line.");
        console.log(`SMTP ${port} accepted one local MIME reply`);
      }
    }
  }
} finally {
  await harness?.close();
  await Promise.all(fixtures.map(fixture => fixture.close()));
  await rm(temp, { recursive: true, force: true });
}

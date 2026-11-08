import net from "node:net";
import tls from "node:tls";
import { once } from "node:events";

// A loopback-only peer that implements the commands used during account verification.
// Reject any authentication before TLS and compare the actual test credentials.
export async function startFixture(protocol, implicit, credentials, advertiseTls = true) {
  const events = [];
  const submissions = [];
  const sockets = new Set();
  const context = tls.createSecureContext(credentials);
  const imap = protocol === "imap";
  const auth = Buffer.from("\x00fixture-user\x00fixture-password").toString("base64");
  const serve = (stream, encrypted, greet) => {
    let buffered = "";
    let authTag = "";
    let messageLines = null;
    let sender;
    const recipients = [];
    stream.on("error", () => {});
    const send = text => stream.write(text + "\r\n");
    if (greet) send(imap ? "* OK fixture ready" : "220 localhost fixture");
    const receive = chunk => {
      buffered += chunk.toString("ascii");
      let end;
      while ((end = buffered.indexOf("\r\n")) >= 0) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        if (messageLines) {
          if (line === ".") {
            submissions.push({ sender, recipients, raw: messageLines.join("\r\n") + "\r\n" });
            messageLines = null;
            send("250 message accepted by local fixture");
          } else messageLines.push(line.startsWith("..") ? line.slice(1) : line);
          continue;
        }
        if (authTag) {
          send(`${authTag} ${encrypted && line === auth ? "OK authenticated" : "NO authentication refused"}`);
          authTag = "";
          continue;
        }
        const words = line.split(" ");
        const tag = imap ? words.shift() : "";
        const cmd = words.shift()?.toUpperCase();
        events.push({ cmd, encrypted });
        if (cmd === "STARTTLS" && !encrypted && advertiseTls) {
          stream.off("data", receive);
          send(imap ? `${tag} OK begin TLS` : "220 begin TLS");
          serve(new tls.TLSSocket(stream, { isServer: true, secureContext: context }), true, false);
          return;
        }
        if (imap) {
          const ok = () => send(`${tag} OK done`);
          if (cmd === "CAPABILITY") {
            send("* CAPABILITY IMAP4rev1 NAMESPACE SASL-IR AUTH=PLAIN" + (!encrypted && advertiseTls ? " STARTTLS" : ""));
            ok();
          } else if (cmd === "AUTHENTICATE") {
            if (encrypted && words[0] === "PLAIN" && words.length === 1) {
              authTag = tag;
              send("+");
            } else if (encrypted && words[0] === "PLAIN" && words[1] === auth) ok();
            else send(`${tag} NO authentication refused`);
          } else if (cmd === "NAMESPACE") {
            send('* NAMESPACE (("" "/")) NIL NIL');
            ok();
          } else if (cmd === "LIST") {
            send('* LIST () "/" "INBOX"');
            ok();
          } else if (cmd === "EXAMINE") {
            send("* FLAGS (\\Seen)\r\n* 0 EXISTS\r\n* OK [UIDVALIDITY 1] stable");
            send(`${tag} OK [READ-ONLY] examined`);
          } else if (cmd === "LOGOUT") {
            send("* BYE closing");
            ok();
          } else send(`${tag} BAD unknown fixture command`);
        } else if (cmd === "EHLO") {
          send("250-localhost" + (!encrypted && advertiseTls ? "\r\n250-STARTTLS" : "") + "\r\n250 AUTH PLAIN");
        } else if (cmd === "AUTH") {
          send(encrypted && words[0] === "PLAIN" && words[1] === auth ? "235 authenticated" : "535 authentication refused");
        } else if (encrypted && cmd === "MAIL") {
          sender = words[0];
          send("250 sender accepted");
        } else if (encrypted && cmd === "RCPT") {
          recipients.push(words[0]);
          send("250 recipient accepted");
        } else if (encrypted && cmd === "DATA") {
          messageLines = [];
          send("354 send message");
        } else send("502 command unavailable");
      }
    };
    stream.on("data", receive);
  };
  const server = implicit
    ? tls.createServer(credentials, stream => serve(stream, true, true))
    : net.createServer(stream => serve(stream, false, true));
  server.on("connection", socket => {
    events.push({cmd: "connection", encrypted: false});
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("tlsClientError", error => events.push({cmd: error.code || error.message, encrypted: false}));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port, events, submissions,
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise(resolve => server.close(resolve));
    },
  };
}

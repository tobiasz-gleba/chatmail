import { connect } from "cloudflare:sockets";
import { verifyImap } from "../src/mail/protocol-imap";
import { connectSmtp, prepareMessage, submitSmtp, verifySmtp } from "../src/mail/protocol-smtp";

// Local test entrypoint. The production verifier chooses the logical port's TLS
// mode. Only the destination port is forwarded, to an unprivileged local peer.
export default {
  async fetch(request: Request): Promise<Response> {
    const args = new URL(request.url).searchParams;
    const protocolPort = Number(args.get("protocolPort"));
    const fixturePort = Number(args.get("fixturePort"));
    const endpoint = { host: "localhost", port: protocolPort, username: "fixture-user" };
    const account = {
      id: "socket-fixture", email: "fixture@example.invalid", imap: endpoint, smtp: endpoint,
      separateSmtpCredentials: false, password: "fixture-password", smtpPassword: "",
    };
    const localSocket: typeof connect = (_address, options) =>
      connect({ hostname: endpoint.host, port: fixturePort }, options);
    try {
      if ([993, 143].includes(protocolPort)) await verifyImap(account, localSocket);
      else if ([465, 587].includes(protocolPort)) {
        const client = (options: Parameters<typeof connectSmtp>[0]) =>
          connectSmtp({ ...options, port: fixturePort });
        if (args.get("operation") === "send") {
          const mail = {
            from: account.email, to: ["to@example.invalid"], cc: ["cc@example.invalid"],
            subject: "Re: Socket fixture", text: "Hello from workerd.\n.A second line.",
            messageId: "<reply@example.invalid>", inReplyTo: "<previous@example.invalid>",
            references: ["<first@example.invalid>", "<previous@example.invalid>"],
          };
          await submitSmtp(account, mail, await prepareMessage(mail), client);
        } else await verifySmtp(account, client);
      } else return new Response(null, { status: 400 });
      return new Response("verified");
    } catch (error) {
      return new Response(error instanceof Error ? error.message : "verification failed", { status: 422 });
    }
  },
};

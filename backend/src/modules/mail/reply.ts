import { fetchHeaders, type MailSource } from "../../mail/transport";
import { getMailAccount } from "../inboxes/store";
import { groupHeaders, type GroupedMessage } from "./grouping";
import { MailRequestError, mailTokens } from "./tokens";

export interface MessageLocator {
  key: string;
  sources: Array<{ inboxId: string; source: MailSource }>;
}

export function messageLocator(message: GroupedMessage): MessageLocator {
  return { key: message.stableId, sources: message.sources };
}

export async function resolveReplyTarget(env: Env, userId: string, messageId: string) {
  const locator = await mailTokens(env.AUTH_SECRET, userId).open<MessageLocator>("message", messageId);
  let connectionFailed = false;
  for (const {inboxId, source} of locator.sources) {
    const account = await getMailAccount(env, userId, inboxId);
    if (!account) continue;
    try {
      const headers = await fetchHeaders(account, [source]);
      const target = groupHeaders(headers.map(header => ({ inboxId, header })), []).find(message => message.stableId === locator.key);
      if (!target) continue;
      const header = target.header;
      return {
        from: header.from[0] ?? { email: "" }, to: header.to, cc: header.cc,
        replyTo: header.replyTo, messageId: header.messageId ?? null,
        references: header.references, inReplyTo: header.inReplyTo ?? null,
        subject: header.subject, inboxIds: [...new Set(locator.sources.map(s => s.inboxId))],
      };
    } catch {
      connectionFailed = true;
    }
  }
  if (connectionFailed) throw new MailRequestError(503, "MAILBOX_UNAVAILABLE", "Couldn't read the original email. Try again.");
  throw new MailRequestError(404, "MESSAGE_UNAVAILABLE", "This message has moved or is no longer available.");
}

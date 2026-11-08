import { describe, expect, it } from "vitest";
import { groupHeaders, type HeaderEntry } from "../src/modules/mail/grouping";
import type { MailHeader } from "../src/mail/transport";

const personal = { email: "me@personal.test" };
const work = { email: "me@work.test" };
const ada = { email: "Ada@Example.test", name: "Ada" };
const sam = { email: "sam@example.test", name: "Sam" };
const own = [personal.email, work.email];

function entry(inboxId: string, uid: number, changes: Partial<MailHeader> = {}): HeaderEntry {
  return {
    inboxId,
    header: {
      source: { folder: "INBOX", uidValidity: "987", uid },
      messageId: `<message${uid}@example.test>`,
      from: [ada], to: [personal], cc: [], replyTo: [],
      subject: "Travel", references: [],
      sentAt: new Date(Date.UTC(2025, 0, 1, 12, 0, uid)).toISOString(),
      unread: false,
      ...changes,
    },
  };
}

describe("contact and group chats", () => {
  it("groups across owned addresses using the whole external participant set", () => {
    const result = groupHeaders([
      entry("home", 1),
      entry("work", 2, { from: [work], to: [{ email: "ada@example.test" }] }),
      entry("work", 3, { to: [sam, work], cc: [personal, sam] }),
      entry("home", 4, { from: [sam], to: [ada], cc: [personal] }),
    ], own);
    expect(result.map(({ header }) => header.source.uid)).toEqual([4, 3, 2, 1]);
    expect(result[3].chatKey).toBe(result[2].chatKey);
    expect(result[0].chatKey).toBe(result[1].chatKey);
    expect(result[0].chatKey).not.toBe(result[2].chatKey);
    expect(result[0].participants.map(({ email }) => email)).toEqual(["ada@example.test", "sam@example.test"]);
    expect(result.map(message => message.outgoing)).toEqual([false, false, true, false]);
  });

  it("retains all source copies and treats unread on either as unread", () => {
    const received = entry("home", 7, { unread: true });
    const copy = entry("work", 8, { messageId: "message7@example.test" });
    const result = groupHeaders([received, copy, received], own);
    expect(result).toHaveLength(1);
    expect(result[0].sources.map(({ inboxId }) => inboxId)).toEqual(["work", "home"]);
    expect(result[0].unread).toBe(true);
    expect(result[0].stableId).toBe(groupHeaders([received], own)[0].stableId);
  });

  it("resolves references and short parent chains without joining unrelated subjects", () => {
    const messages = [
      entry("home", 1),
      entry("work", 2, { references: ["<message1@example.test>"] }),
      entry("work", 3, { inReplyTo: "<message2@example.test>", subject: "Updated title" }),
      entry("work", 4),
    ];
    const [unrelated, grandchild, child, original] = groupHeaders(messages, own);
    expect(grandchild.topicId).toBe(original.topicId);
    expect(child.topicId).toBe(original.topicId);
    expect(unrelated.topicId).not.toBe(original.topicId);
  });

  it("scopes missing Message-IDs to physical mail copies and keeps self mail accessible", () => {
    const change = { messageId: undefined, from: [personal], to: [work] };
    const result = groupHeaders([entry("home", 5, change), entry("work", 5, change)], own);
    expect(result).toHaveLength(2);
    expect(result[0].chatKey).toBe("[]");
    expect(result[0].topicId).not.toBe(result[1].topicId);
  });
});

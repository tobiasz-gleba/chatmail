import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import type { ImapFlow, MessageStructureObject } from "imapflow";
import { fetchBodies } from "../src/mail/protocol-body";
import { withSources } from "../src/mail/protocol-imap";
import type { MailAccount } from "../src/mail/protocol-types";

vi.mock("../src/mail/protocol-imap", () => ({ withSources: vi.fn() }));

it("loads visible MIME text parts, picking one alternative and discarding tracking markup and attachments", async () => {
  const structure: MessageStructureObject = {
    type: "multipart/mixed", childNodes: [
      { type: "multipart/alternative", childNodes: [
        { type: "text/plain", part: "1.1" },
        { type: "text/html", part: "1.2" },
      ] },
      { type: "text/plain", part: "2", disposition: "attachment" },
      { type: "text/html", part: "3" },
    ],
  };
  const download = vi.fn(async (_uid: number, part: string) => ({
    content: Readable.from([part === "1.1" ? "Plain version" : '<p>Signature &amp; name</p><img src="https://example.test/pixel"><script>privateToken()</script>']),
  }));
  const client = { fetchAll: async () => [{ uid: 7, bodyStructure: structure }], download } as unknown as ImapFlow;
  vi.mocked(withSources).mockImplementation(async (_account, _sources, readonly, visit) => {
    expect(readonly).toBe(true);
    return visit(client, "INBOX", "1", [7]);
  });
  const source = { folder: "INBOX", uidValidity: "1", uid: 7 };
  expect(await fetchBodies({} as MailAccount, [source])).toEqual([{ source, body: "Plain version\n\nSignature & name" }]);
  expect(download.mock.calls.map(call => call[1])).toEqual(["1.1", "3"]);
});

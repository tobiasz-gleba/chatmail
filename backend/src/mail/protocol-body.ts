import { convert } from "html-to-text";
import type { ImapFlow, MessageStructureObject } from "imapflow";
import { Buffer } from "node:buffer";
import { withSources } from "./protocol-imap";
import type { MailAccount, MailSource } from "./protocol-types";

const maxTextBytes = 128 * 1024;

function textParts(node: MessageStructureObject): MessageStructureObject[] {
  if (node.disposition?.toLowerCase() === "attachment" || node.parameters?.name || node.dispositionParameters?.filename) return [];
  const type = node.type.toLowerCase();
  if (type === "message/rfc822") return [];
  if (type === "text/plain" || type === "text/html") return [node];
  const children = node.childNodes ?? [];
  if (type === "multipart/alternative") {
    // Alternatives repeat the same content. Prefer plain text when available.
    const versions = children.map(textParts);
    return versions.find(parts => parts.some(part => part.type.toLowerCase() === "text/plain"))
      ?? versions.find(parts => parts.length) ?? [];
  }
  if (type === "multipart/related") {
    const root = children.find(part => node.parameters?.start && part.id === node.parameters.start) ?? children[0];
    return root ? textParts(root) : [];
  }
  return children.flatMap(textParts);
}

async function readText(client: ImapFlow, uid: number, structure?: MessageStructureObject): Promise<string | null> {
  const parts = structure ? textParts(structure) : [];
  if (!parts.length) return "This message has no readable text.";
  const sections: string[] = [];
  let remaining = maxTextBytes;
  for (const part of parts.slice(0, 12)) {
    const { content } = await client.download(uid, part.part || "1", { uid: true, maxBytes: remaining + 1 });
    if (!content) return null; // The message was removed between FETCH and download.
    const chunks: Buffer[] = [];
    for await (const chunk of content) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    const text = raw.subarray(0, remaining).toString("utf8");
    sections.push(part.type.toLowerCase() === "text/html"
      ? convert(text, { wordwrap: false, selectors: [{ selector: "img", format: "skip" }], limits: { maxDepth: 64 } })
      : text);
    remaining -= raw.byteLength;
    if (remaining < 0) break;
  }
  if (remaining < 0 || parts.length > 12) sections.push("[Message text truncated]");
  return sections.join("\n\n");
}

export function fetchBodies(account: MailAccount, sources: MailSource[]) {
  return withSources(account, sources, true, async (client, folder, uidValidity, uids) => {
    const rows = await client.fetchAll(uids, { bodyStructure: true }, { uid: true });
    const messages: Array<{ source: MailSource; body: string }> = [];
    for (const row of rows) {
      const body = await readText(client, row.uid, row.bodyStructure);
      if (body !== null) messages.push({ source: { folder, uidValidity, uid: row.uid }, body });
    }
    return messages;
  });
}

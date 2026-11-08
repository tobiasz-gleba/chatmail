import type { Address } from "../../../shared/contracts";

export type { Address } from "../../../shared/contracts";
export type { MailAccount } from "../modules/inboxes/store";

export interface MailSource {
  folder: string;
  uid: number;
  uidValidity: string;
}

export interface MailHeader {
  source: MailSource;
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  subject: string;
  from: Address[];
  to: Address[];
  cc: Address[];
  replyTo: Address[];
  sentAt: string;
  unread: boolean;
}

export interface OutgoingMail {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
}

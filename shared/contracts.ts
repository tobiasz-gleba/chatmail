export interface User {
  id: string;
  email: string;
}

export interface MailServer {
  host: string;
  port: number;
  username: string;
}

export interface Inbox {
  id: string;
  email: string;
  imap: MailServer;
  smtp: MailServer;
  separateSmtpCredentials: boolean;
}

export type InboxInput = Omit<Inbox, "id"> & { password?: string; smtpPassword?: string };

export interface Address {
  email: string;
  name?: string;
}

export interface Chat {
  id: string;
  participants: Address[];
  latestAt: string;
  subject: string;
  unread: boolean;
  inboxIds: string[];
}

export interface ChatMessage {
  id: string;
  key: string;
  topicId: string;
  ancestorKeys?: string[];
  subject: string;
  from: Address;
  to: Address[];
  cc: Address[];
  replyTo: Address[];
  body: string;
  sentAt: string;
  outgoing: boolean;
  inboxIds: string[];
  unread: boolean;
}

export interface InboxFailure {
  inboxId: string;
  message: string;
}

export interface ChatPage {
  chats: Chat[];
  cursor: string | null;
  failures: InboxFailure[];
}

export interface MessagePage {
  messages: ChatMessage[];
  cursor: string | null;
  failures: InboxFailure[];
}

export interface SendInput {
  submissionId: string;
  inboxId: string;
  body: string;
  replyToId?: string;
  to?: string[];
  subject?: string;
}

export interface SendResult {
  status: "sent" | "unconfirmed" | "failed" | "pending";
  sentCopy?: boolean;
  checkedSent?: boolean;
  partial?: boolean;
}

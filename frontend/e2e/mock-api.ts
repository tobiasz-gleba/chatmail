import type { Page, Request, Route } from '@playwright/test'
import type { Chat, ChatMessage, Inbox, InboxInput, SendInput, SendResult, User } from '../../shared/contracts'

export const owner: User = { id: 'user-1', email: 'alex@example.com' }

export function mailbox(id = 'inbox-personal', email = 'alex@personal.example'): Inbox {
  return {
    id,
    email,
    imap: { host: 'imap.personal.example', port: 993, username: email },
    smtp: { host: 'smtp.personal.example', port: 465, username: email },
    separateSmtpCredentials: false,
  }
}

export const personal = mailbox()
export const work = mailbox('inbox-work', 'alex@work.example')

export const earlierMessage: ChatMessage = {
  id: 'opaque-earlier', key: 'message-earlier', topicId: 'topic-budget', subject: 'Budget review',
  from: { email: 'sam@example.com', name: 'Sam Lee' },
  to: [{ email: personal.email }], cc: [], replyTo: [],
  body: 'Can you review the budget before Friday?', sentAt: '2026-11-06T09:00:00.000Z',
  outgoing: false, inboxIds: [personal.id], unread: true,
}

export const latestMessage: ChatMessage = {
  id: 'opaque-latest', key: 'message-latest', topicId: 'topic-weekend', subject: 'Weekend plans',
  from: { email: 'sam@example.com', name: 'Sam Lee' },
  to: [{ email: personal.email }], cc: [], replyTo: [],
  body: 'Would you like to meet on Sunday?', sentAt: '2026-11-08T10:00:00.000Z',
  outgoing: false, inboxIds: [personal.id], unread: true,
}

export const samChat: Chat = {
  id: 'chat-sam', participants: [{ email: 'sam@example.com', name: 'Sam Lee' }],
  latestAt: latestMessage.sentAt, subject: latestMessage.subject, unread: true,
  inboxIds: [personal.id, work.id],
}

type CapturedRequest = { method: string; path: string; body: Record<string, unknown> }
type Deferred = { promise: Promise<void>; resolve: () => void }

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>(complete => { resolve = complete })
  return { promise, resolve }
}

export class MockApi {
  user: User | null = owner
  inboxes: Inbox[] = [personal, work]
  chats: Chat[] = [samChat]
  messages: ChatMessage[] = [latestMessage, earlierMessage]
  requests: CapturedRequest[] = []
  failures: { inboxId: string; message: string }[] = []
  nextInboxFailure: 'IMAP_CONNECTION_FAILED' | 'SMTP_CONNECTION_FAILED' | null = null
  sendResult: SendResult = { status: 'sent', sentCopy: true }
  statusResult: SendResult = { status: 'sent', sentCopy: true, checkedSent: true }
  sendGate: Deferred | null = null
  private chatsGate: Deferred | null = null
  unexpected: string[] = []

  holdSend() {
    this.sendGate = deferred()
    return this.sendGate.resolve
  }

  holdChats() {
    this.chatsGate = deferred()
    return this.chatsGate.resolve
  }

  get sends() {
    return this.requests.filter(request => request.path === '/api/mail/send').map(request => request.body as unknown as SendInput)
  }

  async install(page: Page) {
    await page.route('**/api/**', route => this.handle(route))
  }

  private async handle(route: Route) {
    const request = route.request()
    const { pathname } = new URL(request.url())
    const method = request.method()
    const body = this.body(request)
    this.requests.push({ method, path: pathname, body })
    const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', json: data })
    const error = (code: string, message: string, status: number) => json({ error: { code, message }, requestId: 'test-request' }, status)

    if (pathname === '/api/session') return json({ user: this.user })
    if (pathname === '/api/auth/code') return json({ ok: true })
    if (pathname === '/api/auth/verify') {
      if (body.code !== '123456') return error('INVALID_CODE', 'This code is incorrect or has expired.', 400)
      this.user = { ...owner, email: String(body.email) }
      return json({ user: this.user })
    }
    if (pathname === '/api/logout') {
      this.user = null
      return json({ ok: true })
    }
    if (!this.user) return error('UNAUTHENTICATED', 'Sign in to continue.', 401)

    if (pathname === '/api/inboxes' && method === 'GET') return json({ inboxes: this.inboxes })
    if ((pathname === '/api/inboxes' && method === 'POST') || (pathname.startsWith('/api/inboxes/') && method === 'PUT')) {
      if (this.nextInboxFailure) {
        const code = this.nextInboxFailure
        this.nextInboxFailure = null
        return error(code, code === 'IMAP_CONNECTION_FAILED' ? 'The incoming server could not be reached.' : 'The outgoing server rejected these credentials.', 422)
      }
      const input = body as unknown as InboxInput
      const id = method === 'POST' ? `inbox-added-${this.inboxes.length + 1}` : pathname.split('/').at(-1)!
      const inbox: Inbox = { id, email: input.email, imap: input.imap, smtp: input.smtp, separateSmtpCredentials: input.separateSmtpCredentials }
      this.inboxes = [...this.inboxes.filter(item => item.id !== id), inbox]
      return json({ inbox }, method === 'POST' ? 201 : 200)
    }
    if (pathname.startsWith('/api/inboxes/') && method === 'DELETE') {
      this.inboxes = this.inboxes.filter(item => item.id !== pathname.split('/').at(-1))
      return json({ ok: true })
    }
    if (pathname.startsWith('/api/inboxes/') && method === 'GET') {
      return json({ inbox: this.inboxes.find(item => item.id === pathname.split('/').at(-1)) })
    }
    if (pathname === '/api/mail/chats') {
      if (this.chatsGate) await this.chatsGate.promise
      const scoped = typeof body.inboxId === 'string' ? body.inboxId : null
      return json({
        chats: scoped ? this.chats.filter(chat => chat.inboxIds.includes(scoped)) : this.chats,
        cursor: null,
        failures: this.failures.filter(failure => !scoped || failure.inboxId === scoped),
      })
    }
    if (pathname === '/api/mail/messages') {
      return json({ messages: this.messages, cursor: null, failures: this.failures })
    }
    if (pathname === '/api/mail/read') {
      const ids = Array.isArray(body.messageIds) ? body.messageIds : []
      this.messages = this.messages.map(message => ids.includes(message.id) ? { ...message, unread: false } : message)
      this.chats = this.chats.map(chat => ({ ...chat, unread: false }))
      return json({ ok: true })
    }
    if (pathname === '/api/mail/send') {
      if (this.sendGate) await this.sendGate.promise
      return json(this.sendResult)
    }
    if (pathname === '/api/mail/send/status') return json(this.statusResult)
    this.unexpected.push(`${method} ${pathname}`)
    return error('UNMOCKED_ROUTE', `No acceptance-test fixture for ${method} ${pathname}`, 500)
  }

  private body(request: Request): Record<string, unknown> {
    try { return request.postDataJSON() as Record<string, unknown> ?? {} } catch { return {} }
  }
}

import { useSyncExternalStore } from 'react'
import type { ChatMessage, Inbox } from '@shared/contracts'

export type OperationPhase = 'sending' | 'checking' | 'pending' | 'unconfirmed' | 'failed' | 'missing' | 'expired'

export interface SendOperation {
  id: string
  inboxId: string
  phase: OperationPhase
  checkedSent?: boolean
  partial?: boolean
  details?: string
}

export interface Draft {
  text: string
  recipients: string
  subject: string
  inboxId?: string
  pinned?: ChatMessage
  quoted?: boolean
  operation?: SendOperation
}

export const emptyDraft: Draft = { text: '', recipients: '', subject: '' }

// Drafts and unresolved send receipts live only for the current signed-in session.
export function createComposerDrafts() {
  const drafts = new Map<string, Draft>()
  const listeners = new Set<() => void>()
  return {
    get: (key: string) => drafts.get(key) ?? emptyDraft,
    set(key: string, draft: Draft) {
      if (draft === emptyDraft) drafts.delete(key)
      else drafts.set(key, draft)
      for (const notify of listeners) notify()
    },
    subscribe(notify: () => void) {
      listeners.add(notify)
      return () => { listeners.delete(notify) }
    },
  }
}

export type ComposerDrafts = ReturnType<typeof createComposerDrafts>

export function useDraft(drafts: ComposerDrafts, key: string) {
  return useSyncExternalStore(drafts.subscribe, () => drafts.get(key))
}

export function sourceInbox(message: ChatMessage | undefined, inboxes: Inbox[], preferred?: string) {
  if (preferred && message?.inboxIds.includes(preferred)) return preferred
  return message?.inboxIds.find(id => inboxes.some(inbox => inbox.id === id)) ?? preferred ?? inboxes[0]?.id ?? ''
}

export function replyRecipients(message: ChatMessage, inboxes: Inbox[]): string[] {
  const owners = new Set(inboxes.map(inbox => inbox.email.toLowerCase()))
  const sender = message.replyTo.length ? message.replyTo : [message.from]
  const addresses = [...(message.outgoing ? [] : sender), ...message.to, ...message.cc]
  return addresses.flatMap(({ email }) => {
    const key = email.toLowerCase()
    if (owners.has(key)) return []
    owners.add(key)
    return [email]
  })
}

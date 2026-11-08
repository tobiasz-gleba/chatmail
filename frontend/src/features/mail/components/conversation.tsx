import { Fragment, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import type { Chat, ChatMessage, Inbox } from '@shared/contracts'
import { Button } from '@animate-ui/react/primitives/buttons/button'
import { IconButton } from '@animate-ui/react/primitives/buttons/icon'
import { ArrowLeft } from '@/components/animate-ui/icons/arrow-left'
import { Reply } from '@/components/animate-ui/icons/reply'
import { Mail } from '@/components/animate-ui/icons/mail'
import { Composer } from './composer'
import { sourceInbox, useDraft, type ComposerDrafts } from '../composer-drafts'
import { initials, messageTime, timelineDate } from '../mail-format'
import { useTopicAccents } from '../topic-accents'

interface ConversationProps {
  chat: Chat
  messages: ChatMessage[]
  inboxes: Inbox[]
  inboxId?: string
  loading: boolean
  hasOlder: boolean
  onOlder: () => void
  onBack: () => void
  onSent: (notice?: string) => void
  notice?: ReactNode
  drafts: ComposerDrafts
  onVisible?: (messageIds: string[]) => void
}

export function Conversation({ chat, messages, inboxes, inboxId, loading, hasOlder, onOlder,
  onBack, onSent, notice, drafts, onVisible }: ConversationProps) {
  const draftKey = 'reply:' + chat.id
  const draft = useDraft(drafts, draftKey)
  const latest = messages.at(-1)
  const pinned = draft.pinned
  // Resolve the saved reply again when older history reveals the thread's parent.
  const target = pinned ? messages.find(message => message.key === pinned.key) ?? pinned : latest
  const accents = useTopicAccents(messages, target?.topicId)
  const locked = Boolean(draft.operation && draft.operation.phase !== 'failed')
  const scrollArea = useRef<HTMLDivElement>(null)
  const anchor = useRef<{ key: string; offset: number } | null>(null)
  const pinnedToBottom = useRef(true)
  const historyRef = useRef({ chat: '', first: '', last: '' })
  const first = messages[0]?.key ?? ''
  const last = messages.at(-1)?.key ?? ''
  const visibleCallback = useRef(onVisible)
  visibleCallback.current = onVisible

  useLayoutEffect(() => {
    const area = scrollArea.current
    if (!area) return
    const previous = historyRef.current
    if (chat.id !== previous.chat || !previous.first) {
      area.scrollTop = area.scrollHeight
      pinnedToBottom.current = true
      anchor.current = null
    } else if (anchor.current) {
      const item = Array.from(area.querySelectorAll<HTMLElement>('[data-message-key]'))
        .find(item => item.dataset.messageKey === anchor.current?.key)
      if (item) {
        const offset = item.getBoundingClientRect().top - area.getBoundingClientRect().top
        area.scrollTop += offset - anchor.current.offset
      }
      // One history request can prepend multiple server pages before its loading control disappears.
      if (!loading) anchor.current = null
    } else if (last !== previous.last && pinnedToBottom.current) {
      area.scrollTop = area.scrollHeight
    }
    historyRef.current = { chat: chat.id, first, last }
  }, [chat.id, first, last, loading, hasOlder])

  useEffect(() => {
    const area = scrollArea.current
    if (!area) return
    const observer = new IntersectionObserver(entries => {
      const ids = entries.flatMap(entry => {
        const id = (entry.target as HTMLElement).dataset.unreadId
        return entry.isIntersecting && id ? [id] : []
      })
      if (ids.length) visibleCallback.current?.(ids)
    }, { root: area })
    for (const item of area.querySelectorAll('[data-unread-id]')) observer.observe(item)
    return () => observer.disconnect()
  }, [messages, chat.id])

  function loadOlder() {
    if (loading || !hasOlder) return
    const area = scrollArea.current
    if (area) {
      const top = area.getBoundingClientRect().top
      const item = Array.from(area.querySelectorAll<HTMLElement>('[data-message-key]'))
        .find(node => node.getBoundingClientRect().bottom >= top)
      if (item?.dataset.messageKey) {
        anchor.current = { key: item.dataset.messageKey, offset: item.getBoundingClientRect().top - top }
      }
    }
    onOlder()
  }

  function reply(message: ChatMessage) {
    if (locked) return
    drafts.set(draftKey, { ...draft, operation: undefined, pinned: message, quoted: true,
      inboxId: sourceInbox(message, inboxes, inboxId) })
    requestAnimationFrame(() => document.getElementById('chat-reply')?.focus())
  }
  const name = chat.participants.map(person => person.name?.trim() || person.email).join(', ') || 'You'
  const addresses = chat.participants.some(person => person.name?.trim() && person.name !== person.email)
    ? chat.participants.map(person => person.email).join(', ') : ''

  return (
    <section className="conversation-pane" aria-labelledby="conversation-title">
      <header className="conversation-header">
        <div className="conversation-width conversation-heading">
          <IconButton aria-label="Back to chats" title="Back to chats" className="conversation-mobile-back" onClick={onBack}>
            <ArrowLeft aria-hidden="true" />
          </IconButton>
          <span aria-hidden="true" className="participant-avatar">{initials(name)}</span>
          <div className="participant-details">
            <h2 id="conversation-title" tabIndex={-1} title={name}>{name}</h2>
            {addresses && <p title={addresses}>{addresses}</p>}
          </div>
        </div>
      </header>
      {notice && <div className="conversation-notices"><div className="conversation-width">{notice}</div></div>}
      <div className="timeline-scroll" ref={scrollArea} role="region" aria-label="Conversation history" tabIndex={0}
        onScroll={event => {
          const area = event.currentTarget
          pinnedToBottom.current = area.scrollHeight - area.scrollTop - area.clientHeight < 48
          if (area.scrollTop < 48 && !pinnedToBottom.current) loadOlder()
        }}>
        {hasOlder && <div className="history-control"><Button data-variant="ghost" onClick={loadOlder} disabled={loading}>Load older messages</Button></div>}
        {loading && <p role="status" className="timeline-feedback">Loading messages…</p>}
        {!loading && !messages.length && !notice && <p className="timeline-feedback">No messages in this view.</p>}
        <ol className="conversation-width message-list" aria-label="Messages">
          {messages.map((message, index) => {
            const sent = new Date(message.sentAt)
            const previous = messages[index - 1]
            const newDay = !previous || new Date(previous.sentAt).toDateString() !== sent.toDateString()
            const author = message.outgoing ? 'You' : (message.from.name?.trim() || message.from.email)
            return (
              <Fragment key={message.key}>
                {newDay && <li className="message-day"><time dateTime={message.sentAt}>{timelineDate(sent)}</time></li>}
                {previous?.topicId !== message.topicId && <li className="message-topic" data-topic-accent={accents.get(message.topicId)}>
                  <Mail aria-hidden="true" size={14} /><span>{message.subject || '(No subject)'}</span>
                </li>}
                <li className="timeline-message" data-direction={message.outgoing ? 'outgoing' : 'incoming'}
                  data-message-key={message.key} data-unread-id={message.unread ? message.id : undefined}>
                  <div className="message-bubble">
                    <p>{message.body || '(No message text)'}</p>
                  </div>
                  <div className="message-meta">
                    <span className="message-author">{author}</span>
                    <time dateTime={message.sentAt}>{messageTime(message.sentAt)}</time>
                    <IconButton aria-label="Reply" title="Reply" className="message-reply" disabled={locked} onClick={() => reply(message)}>
                      <Reply aria-hidden="true" size={15} />
                    </IconButton>
                  </div>
                </li>
              </Fragment>
            )
          })}
        </ol>
      </div>
      <Composer key={draftKey} drafts={drafts} draftKey={draftKey} inboxes={inboxes}
        inboxId={inboxId} reply={{ latest, target, accent: target && accents.get(target.topicId) }} onSent={onSent} />
    </section>
  )
}

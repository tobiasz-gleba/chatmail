import { useCallback, useEffect, useRef, useState } from 'react'
import type { Chat, Inbox as Mailbox, User } from '@shared/contracts'
import type { ComposerDrafts } from './composer-drafts'
import { useChatList } from './data/use-chat-list'
import { WorkspaceLayout } from './components/workspace-layout'

interface WorkspaceProps {
  user: User
  drafts: ComposerDrafts
  inboxes: Mailbox[]
  logoutError?: string
  onManageInboxes: () => void
  onLogout: () => void
}

const mobileQuery = '(max-width: 767px)'
const paneState = 'chatmailOpenPane'

type ActiveView = { kind: 'chat'; chat: Chat } | { kind: 'compose' } | null

export function MailWorkspace({ user, inboxes, drafts, logoutError, onManageInboxes, onLogout }: WorkspaceProps) {
  const [inboxId, setInboxId] = useState<string>()
  const [view, setView] = useState<ActiveView>(null)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [version, setVersion] = useState(0)
  const [connectionVersion, setConnectionVersion] = useState(0)
  const [announcement, setAnnouncement] = useState('')
  const previousControl = useRef<string>('inbox-title')
  const { chats, failures, retrying, loading, error, retryInbox, markChatRead, checkVersion } = useChatList(inboxId, version)
  const selected = view?.kind === 'chat' ? chats.find(chat => chat.id === view.chat.id) ?? view.chat : null
  const restoreFocus = useCallback(() => {
    requestAnimationFrame(() => (document.getElementById(previousControl.current) ?? document.getElementById('inbox-title'))?.focus())
  }, [])

  useEffect(() => {
    // Only the pane flag goes into browser history. All message data stays in React memory.
    if (history.state?.[paneState]) history.replaceState({ ...history.state, [paneState]: false }, '')
    function navigate(event: PopStateEvent) {
      const open = Boolean(event.state?.[paneState])
      setMobileOpen(open)
      if (!open) restoreFocus()
    }
    window.addEventListener('popstate', navigate)
    return () => window.removeEventListener('popstate', navigate)
  }, [restoreFocus])

  function openPane(next: NonNullable<ActiveView>) {
    previousControl.current = next.kind === 'chat' ? `chat-${next.chat.id}` : 'compose-button'
    setAnnouncement('')
    setView(next)
    setMobileOpen(true)
    if (window.matchMedia(mobileQuery).matches && !history.state?.[paneState]) {
      history.pushState({ ...history.state, [paneState]: true }, '')
    }
    requestAnimationFrame(() => document.getElementById(next.kind === 'chat' ? 'conversation-title' : 'new-message-title')?.focus())
  }

  function back() {
    if (window.matchMedia(mobileQuery).matches && history.state?.[paneState]) {
      history.back()
      return
    }
    setMobileOpen(false)
    if (!window.matchMedia(mobileQuery).matches) setView(null)
    restoreFocus()
  }

  function filter(id?: string) {
    setInboxId(id)
    if (selected && id && !selected.inboxIds.includes(id)) {
      setView(null)
      setMobileOpen(false)
    }
    setAnnouncement('')
  }
  function refresh() { setVersion(value => value + 1) }
  async function retrySource(id: string) {
    if (await retryInbox(id)) setConnectionVersion(value => value + 1)
  }
  function sent(message = 'Message sent.') {
    refresh()
    if (view?.kind === 'compose') {
      setAnnouncement(message)
      back()
      setView(null)
    }
  }
  return <WorkspaceLayout
    sidebar={{
      user, chats, inboxes, inboxId, selectedId: selected?.id, loading, failures, retrying, error, logoutError,
      onRetry: retrySource, onRetryList: refresh, onFilter: filter, onManageInboxes, onLogout,
      onCompose: () => openPane({ kind: 'compose' }), onOpen: chat => openPane({ kind: 'chat', chat }),
    }}
    chat={selected} composing={view?.kind === 'compose'} mobileDetailOpen={mobileOpen && !!view}
    announcement={announcement} version={version + connectionVersion} checkVersion={checkVersion} drafts={drafts}
    onBack={back} onSent={sent} onRead={markChatRead} />
}

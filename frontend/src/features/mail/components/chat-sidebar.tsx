import { Button } from '@animate-ui/react/primitives/buttons/button'
import { Button as SidebarButton } from '@animate-ui/react/primitives/react-aria'
import { Highlight as SidebarHighlight } from '@animate-ui/react/primitives/sidebar'
import type { Chat, Inbox, InboxFailure, User } from '@shared/contracts'
import { Brand } from '@/components/brand'
import { SelectField } from '@/components/labeled-fields'
import { MailOpen } from '@/components/animate-ui/icons/mail-open'
import { PencilLine } from '@/components/animate-ui/icons/pencil-line'
import { chatName } from '../data/live'
import { inboxDate, initials } from '../mail-format'
import { AccountMenu } from './account-menu'
import { MailNotice } from './mail-notice'

export interface ChatSidebarProps {
  user: User
  chats: Chat[]
  inboxes: Inbox[]
  inboxId?: string
  selectedId?: string
  failures: InboxFailure[]
  retrying: string[]
  loading: boolean
  error: string
  logoutError?: string
  onFilter: (id?: string) => void
  onOpen: (chat: Chat) => void
  onCompose: () => void
  onRetryList: () => void
  onRetry: (id: string) => void
  onManageInboxes: () => void
  onLogout: () => void
}

export function ChatSidebar({
  user, chats, inboxes, inboxId, selectedId, failures, retrying, loading, error, logoutError,
  onFilter, onOpen, onCompose, onRetryList, onRetry, onManageInboxes, onLogout,
}: ChatSidebarProps) {
  const addresses = new Map(inboxes.map(inbox => [inbox.id, inbox.email]))
  return (
    <aside className="chat-sidebar" aria-labelledby="inbox-title">
      <header className="chat-sidebar-header">
        <Brand />
        <div className="chat-sidebar-title">
          <h1 id="inbox-title" tabIndex={-1}>Chats</h1>
          <Button data-variant="primary" id="compose-button" onClick={onCompose}>
            <PencilLine size={15} aria-hidden="true" /> New message
          </Button>
        </div>
        <SelectField className="chat-sidebar-filter" label="Inbox" value={inboxId ?? 'all'}
          onChange={value => onFilter(value === 'all' ? undefined : value)}
          options={[{ value: 'all', label: 'All inboxes' }, ...inboxes.map(inbox => ({ value: inbox.id, label: inbox.email }))]} />
      </header>

      <SidebarHighlight className="chat-sidebar-scroll">
        {failures.map(({ inboxId: id, message }) => (
          <MailNotice key={id} title={addresses.get(id)} message={message} action="Retry"
            actionLabel={`Retry ${addresses.get(id)}`} disabled={loading || retrying.includes(id)} onAction={() => onRetry(id)} />
        ))}
        {error && <MailNotice message={error} action="Try again" onAction={onRetryList} />}
        <ol className="chat-list" aria-label="Chats">
          {chats.map(chat => {
            const title = chatName(chat)
            const sources = chat.inboxIds.map(id => addresses.get(id)).filter(Boolean).join(' · ')
            return (
              <li key={chat.id}>
                <SidebarButton className="chat-list-row" id={`chat-${chat.id}`} data-sidebar="menu-button"
                  data-unread={chat.unread || undefined} aria-current={selectedId === chat.id || undefined} onPress={() => onOpen(chat)}>
                  <span className="chat-avatar" aria-hidden="true">{initials(title)}</span>
                  <span className="chat-summary">
                    <span className="chat-summary-title">
                      <span className="chat-participant" title={title}>{title}</span>
                      {chat.unread && <span className="chat-unread" role="img" aria-label="Unread" />}
                      <time dateTime={chat.latestAt}>{inboxDate(chat.latestAt)}</time>
                    </span>
                    <span className="chat-subject" title={chat.subject}>{chat.subject || '(No subject)'}</span>
                    {sources && <span className="chat-source" title={sources}>{sources}</span>}
                  </span>
                </SidebarButton>
              </li>
            )
          })}
        </ol>
        {loading && <p className="chat-list-status" role="status">{chats.length ? 'Loading more chats…' : 'Opening your inboxes…'}</p>}
        {!loading && !error && !failures.length && !chats.length && (
          <div className="chat-list-empty" role="status">
            <MailOpen size={22} aria-hidden="true" /><p>No chats in this inbox yet.</p>
          </div>
        )}
      </SidebarHighlight>

      <footer className="chat-sidebar-footer">
        {logoutError && <MailNotice message={logoutError} action="Retry" onAction={onLogout} />}
        <AccountMenu email={user.email} onManageInboxes={onManageInboxes} onLogout={onLogout} />
      </footer>
    </aside>
  )
}

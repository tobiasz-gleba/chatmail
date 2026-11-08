import { useEffect, useState } from 'react'
import type { Chat, Inbox } from '@shared/contracts'
import type { ComposerDrafts } from '../composer-drafts'
import { Conversation } from './conversation'
import { useMessages } from '../data/use-messages'
import { MailNotice } from './mail-notice'

interface ChatViewProps {
  chat: Chat
  inboxes: Inbox[]
  inboxId?: string
  version: number
  checkVersion: number
  drafts: ComposerDrafts
  onBack: () => void
  onSent: (message?: string) => void
  onRead: (id: string) => void
}

export function ChatView({ chat, inboxes, inboxId, version, checkVersion, drafts, onBack, onSent, onRead }: ChatViewProps) {
  const [refresh, setRefresh] = useState(0)
  const activity = JSON.stringify([chat.latestAt, chat.subject])
  const mail = useMessages(chat.id, inboxId, version + refresh, activity, checkVersion)
  const fullyRead = !mail.loading && !mail.hasOlder && !mail.failures.length && !mail.error &&
    mail.messages.length > 0 && mail.messages.every(message => !message.unread)
  useEffect(() => {
    if (fullyRead) onRead(chat.id)
  }, [chat.id, fullyRead, onRead])

  const hasNotice = Boolean(mail.error || mail.failures.length || mail.readError)
  const notice = hasNotice && (
    <>
      {mail.error && <MailNotice message={mail.error} action="Try again" onAction={mail.retryPage} />}
      {mail.failures.map(failure => {
        const label = inboxes.find(inbox => inbox.id === failure.inboxId)?.email
        return <MailNotice key={failure.inboxId} title={label} message={failure.message} action="Retry"
          actionLabel={`Retry messages from ${label}`} onAction={() => setRefresh(value => value + 1)} />
      })}
      {mail.readError && <MailNotice message="Couldn’t update the read status." action="Retry" onAction={mail.retryRead} />}
    </>
  )
  return <Conversation chat={chat} messages={mail.messages} inboxes={inboxes} inboxId={inboxId} drafts={drafts}
    loading={mail.loading} hasOlder={mail.hasOlder} onOlder={mail.loadOlder} onBack={onBack} onSent={onSent}
    notice={notice} onVisible={mail.visible} />
}

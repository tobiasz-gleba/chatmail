import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import { AccountFrame, SessionFeedback } from './components/account-frame'
import { MailWorkspace } from '@/features/mail/mail-workspace'
import { createComposerDrafts, type ComposerDrafts } from '@/features/mail/composer-drafts'
import type { Inbox, User } from '@shared/contracts'
import { Accounts } from './components/accounts'
import { InboxEditor } from './components/inbox-editor'
import { SignIn } from './components/sign-in'
import { errorMessage } from './status'
import './account.css'

type Account = { user: User; inboxes: Inbox[] }
type Session = { status: 'loading' | 'signed-out' } | { status: 'error'; message: string } | { status: 'ready'; account: Account; drafts: ComposerDrafts }
type View = { name: 'chats' | 'manage' } | { name: 'editor'; inbox?: Inbox }

export function App() {
  const [session, setSession] = useState<Session>({ status: 'loading' })
  const [view, setView] = useState<View>({ name: 'chats' })
  const [logoutError, setLogoutError] = useState('')
  const request = useRef<AbortController | undefined>(undefined)
  const signingOut = useRef(false)

  const reset = useCallback(() => {
    request.current?.abort()
    setSession({ status: 'signed-out' })
    setView({ name: 'chats' })
    setLogoutError('')
  }, [])

  const load = useCallback(async (verifiedUser?: User) => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setSession({ status: 'loading' })
    try {
      const user = verifiedUser ?? (await api<{ user: User | null }>('/session', undefined, 'GET', controller.signal)).user
      if (controller.signal.aborted) return
      if (!user) {
        reset()
        return
      }
      const { inboxes } = await api<{ inboxes: Inbox[] }>('/inboxes', undefined, 'GET', controller.signal)
      if (controller.signal.aborted) return
      setSession({ status: 'ready', account: { user, inboxes }, drafts: createComposerDrafts() })
      setView(inboxes.length ? { name: 'chats' } : { name: 'editor' })
    } catch (err) {
      if (!controller.signal.aborted) setSession({ status: 'error', message: errorMessage(err, 'Couldn’t open Chatmail. Check your connection and try again.') })
    }
  }, [reset])

  useEffect(() => {
    window.addEventListener('chatmail:session-expired', reset)
    void load()
    return () => {
      request.current?.abort()
      window.removeEventListener('chatmail:session-expired', reset)
    }
  }, [load, reset])

  async function logout() {
    if (signingOut.current) return
    signingOut.current = true
    setLogoutError('')
    try {
      await api('/logout', {})
      reset()
    } catch (err) {
      setLogoutError(errorMessage(err, 'Couldn’t sign out. Try again.'))
    } finally {
      signingOut.current = false
    }
  }

  if (session.status === 'signed-out') return <AccountFrame><SignIn onVerified={load} /></AccountFrame>
  if (session.status !== 'ready') return (
    <AccountFrame>
      <SessionFeedback error={session.status === 'error' ? session.message : undefined} onRetry={() => load()} />
    </AccountFrame>
  )

  const { user, inboxes } = session.account

  function saved(inbox: Inbox) {
    setSession(current => {
      if (current.status !== 'ready' || current.account.user.id !== user.id) return current
      const previous = current.account.inboxes
      const next = previous.some(item => item.id === inbox.id)
        ? previous.map(item => item.id === inbox.id ? inbox : item) : [...previous, inbox]
      return { ...current, account: { user, inboxes: next } }
    })
    setView({ name: inboxes.length ? 'manage' : 'chats' })
  }

  function removed(id: string) {
    setSession(current => current.status === 'ready' && current.account.user.id === user.id
      ? { ...current, account: { user, inboxes: current.account.inboxes.filter(item => item.id !== id) } }
      : current)
    if (inboxes.length === 1) setView({ name: 'editor' })
  }

  if (view.name === 'chats' && inboxes.length) return (
    <MailWorkspace user={user} inboxes={inboxes} drafts={session.drafts} onManageInboxes={() => setView({ name: 'manage' })}
      onLogout={logout} logoutError={logoutError} />
  )
  return (
    <AccountFrame user={user} onLogout={logout} logoutError={logoutError}>
      {view.name === 'manage' && inboxes.length > 0
        ? <Accounts inboxes={inboxes} onBack={() => setView({ name: 'chats' })}
            onEdit={inbox => setView({ name: 'editor', inbox })} onRemove={removed} />
        : <InboxEditor key={view.name === 'editor' ? view.inbox?.id ?? 'add' : 'add'} loginEmail={user.email}
            inbox={view.name === 'editor' ? view.inbox : undefined}
            onSave={saved} onCancel={inboxes.length ? () => setView({ name: 'manage' }) : undefined} />}
    </AccountFrame>
  )
}

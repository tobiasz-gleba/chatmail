import type { ReactNode } from 'react'
import type { User } from '@shared/contracts'
import { Brand } from '@/components/brand'
import { Button } from '@animate-ui/react/primitives/buttons/button'

export function AccountFrame({ children, user, onLogout, logoutError }: {
  children: ReactNode
  user?: User
  onLogout?: () => void
  logoutError?: string
}) {
  return (
    <div className={user ? 'account-shell' : 'account-shell account-auth'}>
      <div className="account-page">
        <header className="account-header">
          <Brand />
          {user && <div className="account-identity">
            <span title={user.email}>{user.email}</span>
            <Button data-variant="ghost" onClick={onLogout}>Sign out</Button>
          </div>}
        </header>
        {logoutError && <p className="account-error" role="alert">{logoutError}</p>}
        <main>{children}</main>
      </div>
    </div>
  )
}

export function SessionFeedback({ error, onRetry }: { error?: string; onRetry: () => void }) {
  return error ? (
    <section className="account-panel account-feedback">
      <p className="account-error" role="alert">{error}</p>
      <Button onClick={onRetry}>Try again</Button>
    </section>
  ) : <p className="account-panel account-note" role="status">Opening Chatmail…</p>
}

import { useEffect, useState, type FormEvent } from 'react'
import { api } from '@/api'
import { Button } from '@animate-ui/react/primitives/buttons/button'
import { Field } from '@/components/labeled-fields'
import { VerificationCode } from './verification-code'
import type { User } from '@shared/contracts'
import { errorMessage } from '../status'

const resendDelay = 60

export function SignIn({ onVerified }: { onVerified: (user: User) => void }) {
  const [email, setEmail] = useState('')
  const [sentTo, setSentTo] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [codeError, setCodeError] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState<'send' | 'verify' | null>(null)
  const [resendAt, setResendAt] = useState(0)
  const [remaining, setRemaining] = useState(0)

  useEffect(() => {
    if (!sentTo || !resendAt) return
    const update = () => setRemaining(Math.max(0, Math.ceil((resendAt - Date.now()) / 1000)))
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [sentTo, resendAt])

  async function sendCode() {
    if (busy) return
    setBusy('send')
    setError('')
    setCodeError('')
    setStatus('')
    const destination = sentTo || email.trim()
    try {
      await api('/auth/code', { email: destination })
      setResendAt(Date.now() + resendDelay * 1000)
      setRemaining(resendDelay)
      if (sentTo) setStatus('A new code is on its way.')
      setCode('')
      setSentTo(destination)
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[autocomplete="one-time-code"]')?.focus())
    } catch (err) {
      setError(errorMessage(err, 'Couldn’t send the code. Try again.'))
    } finally {
      setBusy(null)
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!sentTo) return sendCode()
    if (busy || code.length !== 6) return
    setBusy('verify')
    setError('')
    setCodeError('')
    setStatus('')
    try {
      const { user } = await api<{ user: User }>('/auth/verify', { email: sentTo, code })
      onVerified(user)
    } catch (err) {
      setCodeError(errorMessage(err, 'Couldn’t verify this code. Try again.'))
      requestAnimationFrame(() => {
        const input = document.querySelector<HTMLInputElement>('[autocomplete="one-time-code"]')
        input?.focus()
        input?.select()
      })
    } finally {
      setBusy(null)
    }
  }

  function changeEmail() {
    setSentTo('')
    setCode('')
    setError('')
    setCodeError('')
    setStatus('')
    setResendAt(0)
  }

  return (
    <section className="account-panel" aria-labelledby="sign-in-title">
      <h1 id="sign-in-title">{sentTo ? 'Check your email' : 'Sign in to Chatmail'}</h1>
      <p className="account-description">{sentTo
        ? <>Enter the six-digit code sent to <strong>{sentTo}</strong>.</>
        : 'We’ll email you a one-time code to sign in or create your account.'}</p>
      <form className="account-form" onSubmit={submit}>
        {sentTo
          ? <VerificationCode value={code} error={codeError} onChange={value => {
              setCode(value)
              setCodeError('')
            }} disabled={!!busy} />
          : <Field label="Email address" name="email" type="email" value={email} onChange={e => {
              setEmail(e.target.value)
              setError('')
            }}
              required autoComplete="email" autoCapitalize="none" spellCheck={false} autoFocus disabled={!!busy} />}
        {!sentTo && error && <p className="account-error" role="alert">{error}</p>}
        {status && <p className="account-note" role="status">{status}</p>}
        <Button data-variant="primary" type="submit" disabled={!!busy || (!!sentTo && code.length !== 6)}>
          {sentTo ? (busy === 'verify' ? 'Verifying…' : 'Verify code') : (busy ? 'Sending…' : 'Send code')}
        </Button>
      </form>
      {sentTo && (
        <footer className="auth-secondary">
          <div className="auth-links">
            <Button data-variant="ghost" onClick={changeEmail} disabled={!!busy}>Change email</Button>
            <Button data-variant="ghost" onClick={sendCode} disabled={!!busy || remaining > 0}>
              {remaining > 0 ? `Resend in ${remaining}s` : busy === 'send' ? 'Sending…' : 'Resend code'}
            </Button>
          </div>
          {error && <p className="account-error" role="alert">{error}</p>}
        </footer>
      )}
    </section>
  )
}

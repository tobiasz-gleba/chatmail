import { useState, type FormEvent } from 'react'
import { api, ApiError } from '@/api'
import { Button } from '@animate-ui/react/primitives/buttons/button'
import { Button as DisclosureTrigger, Disclosure, DisclosurePanel, Heading } from '@animate-ui/react/primitives/react-aria'
import { ChevronDown } from '@/components/animate-ui/icons/chevron-down'
import { Field, SelectField } from '@/components/labeled-fields'
import type { Inbox, InboxInput, MailServer } from '@shared/contracts'
import { errorMessage } from '../status'

const imapPorts = [
  { value: '993', label: '993 · TLS' },
  { value: '143', label: '143 · STARTTLS' },
]
const smtpPorts = [
  { value: '465', label: '465 · TLS' },
  { value: '587', label: '587 · STARTTLS' },
]

function sameServer(a: MailServer, b: MailServer) {
  return a.host.toLowerCase() === b.host.toLowerCase() && a.port === b.port && a.username === b.username
}

interface InboxEditorProps {
  loginEmail: string
  inbox?: Inbox
  onSave: (inbox: Inbox) => void
  onCancel?: () => void
}

export function InboxEditor({ loginEmail, inbox, onSave, onCancel }: InboxEditorProps) {
  const [email, setEmail] = useState(inbox?.email ?? loginEmail)
  const [imapUser, setImapUser] = useState(inbox?.imap.username ?? loginEmail)
  const [imapHost, setImapHost] = useState(inbox?.imap.host ?? '')
  const [smtpHost, setSmtpHost] = useState(inbox?.smtp.host ?? '')
  const [imapPort, setImapPort] = useState(String(inbox?.imap.port ?? 993))
  const [smtpPort, setSmtpPort] = useState(String(inbox?.smtp.port ?? 465))
  const [password, setPassword] = useState('')
  const [separate, setSeparate] = useState(inbox?.separateSmtpCredentials ?? false)
  const [smtpUser, setSmtpUser] = useState(inbox?.smtp.username ?? '')
  const [smtpPassword, setSmtpPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [failedServer, setFailedServer] = useState('')

  const address = email.trim()
  const username = imapUser.trim() || address
  const imap = { host: imapHost.trim(), port: Number(imapPort), username }
  const smtp = { host: smtpHost.trim(), port: Number(smtpPort), username: separate ? smtpUser.trim() : username }
  const differentAddress = !inbox || address.toLowerCase() !== inbox.email.toLowerCase()
  const needsImapPassword = differentAddress || !sameServer(imap, inbox.imap) ||
    (!separate && (inbox.separateSmtpCredentials || !sameServer(smtp, inbox.smtp)))
  const needsSmtpPassword = differentAddress || !inbox.separateSmtpCredentials || !sameServer(smtp, inbox.smtp)

  function changeEmail(next: string) {
    if (!imapUser || imapUser === email) setImapUser(next)
    setEmail(next)
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (saving) return
    setSaving(true)
    setError('')
    setFailedServer('')
    const input: InboxInput = { email: address, imap, smtp, separateSmtpCredentials: separate }
    if (password) input.password = password
    if (separate && smtpPassword) input.smtpPassword = smtpPassword
    try {
      const path = inbox ? `/inboxes/${encodeURIComponent(inbox.id)}` : '/inboxes'
      const result = await api<{ inbox: Inbox }>(path, input, inbox ? 'PUT' : 'POST')
      onSave(result.inbox)
    } catch (err) {
      const protocol = err instanceof ApiError && /^(IMAP|SMTP)_CONNECTION_FAILED$/.test(err.code)
        ? err.code.slice(0, 4) : ''
      setFailedServer(protocol)
      setError(errorMessage(err, 'Couldn’t connect this inbox. Check your settings and try again.'))
      requestAnimationFrame(() => document.getElementById(protocol ? `${protocol}-heading` : 'inbox-form-error')?.focus())
    } finally {
      setSaving(false)
    }
  }

  const passwordHint = 'Leave blank to keep your saved password.'
  return (
    <section className="account-panel" aria-labelledby="inbox-editor-title">
      <h1 id="inbox-editor-title">{inbox ? 'Edit inbox' : 'Connect your inbox'}</h1>
      <p className="account-description">Use the incoming and outgoing server settings from your mail provider.</p>
      <form className="account-form" onSubmit={save}>
        <fieldset className="account-credentials" disabled={saving}>
          <Field label="Mailbox email" type="email" name="mailbox-email" value={email} onChange={e => changeEmail(e.target.value)}
            autoComplete="off" autoCapitalize="none" spellCheck={false} required autoFocus />
          <Field label="Username" name="imap-username" value={imapUser} onChange={e => setImapUser(e.target.value)}
            placeholder={address} autoComplete="off" autoCapitalize="none" spellCheck={false} />
          <Field label="Password or app password" type="password" name="imap-password" value={password}
            onChange={e => setPassword(e.target.value)} required={needsImapPassword} autoComplete="new-password"
            hint={!needsImapPassword ? passwordHint : undefined} />
        </fieldset>
        <section aria-labelledby="IMAP-heading" className="account-form-section">
          <h2 id="IMAP-heading" tabIndex={-1} aria-describedby={failedServer === 'IMAP' ? 'imap-error' : undefined}>Incoming mail <span>IMAP</span></h2>
          <div className="account-server-row">
            <Field label="IMAP server" name="imap-host" value={imapHost} onChange={e => setImapHost(e.target.value)}
              placeholder="imap.example.com" autoCapitalize="none" spellCheck={false} autoComplete="off" required disabled={saving} />
            <SelectField label="IMAP port" value={imapPort} onChange={setImapPort} options={imapPorts} disabled={saving} />
          </div>
          {failedServer === 'IMAP' && <p id="imap-error" role="alert" className="account-error">{error}</p>}
        </section>
        <section aria-labelledby="SMTP-heading" className="account-form-section">
          <h2 id="SMTP-heading" tabIndex={-1} aria-describedby={failedServer === 'SMTP' ? 'smtp-error' : undefined}>Outgoing mail <span>SMTP</span></h2>
          <div className="account-server-row">
            <Field label="SMTP server" name="smtp-host" value={smtpHost} onChange={e => setSmtpHost(e.target.value)}
              placeholder="smtp.example.com" autoCapitalize="none" spellCheck={false} autoComplete="off" required disabled={saving} />
            <SelectField label="SMTP port" value={smtpPort} onChange={setSmtpPort} options={smtpPorts} disabled={saving} />
          </div>
          <Disclosure className="ui-disclosure" isExpanded={separate} isDisabled={saving} onExpandedChange={value => {
            if (value && !smtpUser) setSmtpUser(username)
            setSeparate(value)
          }}>
            <Heading level={3}>
              <DisclosureTrigger slot="trigger" className="ui-disclosure-trigger">
                <ChevronDown size={16} className="ui-disclosure-chevron" aria-hidden="true" />
                Use different SMTP credentials
              </DisclosureTrigger>
            </Heading>
            <DisclosurePanel>
              <fieldset className="account-credentials ui-disclosure-body" disabled={saving || !separate}>
                <Field label="SMTP username" name="smtp-username" value={smtpUser} required={separate} autoComplete="off"
                  autoCapitalize="none" spellCheck={false} onChange={e => setSmtpUser(e.target.value)} />
                <Field label="SMTP password" name="smtp-password" type="password" value={smtpPassword} autoComplete="new-password"
                  onChange={e => setSmtpPassword(e.target.value)} required={separate && needsSmtpPassword}
                  hint={!needsSmtpPassword ? passwordHint : undefined} />
              </fieldset>
            </DisclosurePanel>
          </Disclosure>
          {failedServer === 'SMTP' && <p id="smtp-error" role="alert" className="account-error">{error}</p>}
        </section>
        {error && !failedServer && <p id="inbox-form-error" tabIndex={-1} role="alert" className="account-error">{error}</p>}
        <div className="account-actions editor-actions">
          {onCancel && <Button type="button" data-variant="ghost" disabled={saving} onClick={onCancel}>Cancel</Button>}
          <Button type="submit" data-variant="primary" disabled={saving}>
            {saving ? 'Checking servers…' : inbox ? 'Save changes' : 'Connect inbox'}
          </Button>
        </div>
      </form>
    </section>
  )
}

import { useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import { Button } from '@animate-ui/react/primitives/buttons/button'
import { Dialog, Heading, Modal, ModalOverlay } from '@animate-ui/react/primitives/react-aria'
import { ArrowLeft } from '@/components/animate-ui/icons/arrow-left'
import type { Inbox } from '@shared/contracts'
import { errorMessage } from '../status'

interface AccountsProps {
  inboxes: Inbox[]
  onEdit: (inbox?: Inbox) => void
  onRemove: (id: string) => void
  onBack: () => void
}

export function Accounts({ inboxes, onEdit, onRemove, onBack }: AccountsProps) {
  const [selected, setSelected] = useState<Inbox>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const heading = useRef<HTMLHeadingElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  useEffect(() => { heading.current?.focus() }, [])

  function close() {
    if (busy) return
    setSelected(undefined)
    setError('')
    requestAnimationFrame(() => opener.current?.focus())
  }

  async function disconnect() {
    if (!selected || busy) return
    setBusy(true)
    setError('')
    try {
      await api(`/inboxes/${encodeURIComponent(selected.id)}`, undefined, 'DELETE')
      setSelected(undefined)
      onRemove(selected.id)
      requestAnimationFrame(() => heading.current?.focus())
    } catch (err) {
      setError(errorMessage(err, 'Couldn’t disconnect this inbox. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="account-panel" aria-labelledby="inboxes-heading">
      <Button data-variant="ghost" onClick={onBack} className="account-back">
        <ArrowLeft size={16} aria-hidden="true" /> Back to chats
      </Button>
      <header className="account-list-heading">
        <h1 id="inboxes-heading" ref={heading} tabIndex={-1}>Connected inboxes</h1>
        <Button data-variant="primary" onClick={() => onEdit()}>Add inbox</Button>
      </header>
      <ul className="managed-inboxes">
        {inboxes.map(inbox => (
          <li key={inbox.id}>
            <div className="managed-address"><strong>{inbox.email}</strong><span>{inbox.imap.host}</span></div>
            <div className="managed-actions">
              <Button data-variant="secondary" aria-label={`Edit ${inbox.email}`} onClick={() => onEdit(inbox)}>Edit</Button>
              <Button data-variant="ghost" aria-label={`Disconnect ${inbox.email}`} onClick={event => {
                opener.current = event.currentTarget
                setError('')
                setSelected(inbox)
              }}>Disconnect</Button>
            </div>
          </li>
        ))}
      </ul>
      <ModalOverlay className="ui-overlay" isOpen={!!selected} isDismissable={!busy}
        onOpenChange={open => { if (!open) close() }}>
        <Modal className="ui-modal">
          <Dialog className="ui-dialog">
            <Heading slot="title" level={2} className="ui-dialog-title">Disconnect inbox?</Heading>
            <p className="account-description">Disconnect <strong>{selected?.email}</strong> from Chatmail? You can reconnect it later.</p>
            {error && <p role="alert" className="account-error">{error}</p>}
            <div className="account-actions dialog-actions">
              <Button type="button" data-variant="secondary" autoFocus disabled={busy} onClick={close}>Cancel</Button>
              <Button type="button" data-variant="danger" disabled={busy} onClick={disconnect}>{busy ? 'Disconnecting…' : 'Disconnect'}</Button>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </section>
  )
}

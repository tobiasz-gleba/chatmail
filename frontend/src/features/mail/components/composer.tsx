import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ChatMessage, Inbox, SendInput, SendResult } from '@shared/contracts'
import { api, ApiError } from '@/api'
import { Button } from '@animate-ui/react/primitives/buttons/button'
import { Field, SelectField, TextareaField } from '@/components/labeled-fields'
import { Reply } from '@/components/animate-ui/icons/reply'
import { ArrowUp } from '@/components/animate-ui/icons/arrow-up'
import type { TopicAccent } from '../topic-accents'
import {
  emptyDraft, replyRecipients, sourceInbox, useDraft,
  type ComposerDrafts, type Draft, type SendOperation,
} from '../composer-drafts'
import '../conversation.css'

type Props = {
  drafts: ComposerDrafts
  draftKey: string
  inboxes: Inbox[]
  inboxId?: string
  reply?: { latest?: ChatMessage; target?: ChatMessage; accent?: TopicAccent }
  onSent: (notice?: string) => void
}

function operationLabel(op: SendOperation) {
  if (op.details) return op.details
  if (op.phase === 'sending') return 'Sending message…'
  if (op.phase === 'checking') return 'Checking Sent…'
  if (op.phase === 'pending') return 'The mail server is still processing this send.'
  if (op.phase === 'expired') return 'The send receipt expired. Check your mailbox before composing another message.'
  if (op.phase === 'missing') return 'No send receipt found. You can retry this submission.'
  if (op.phase === 'failed') return 'The message could not be sent. Your draft is here.'
  if (op.partial) return 'Some recipients may already have received this message. Check delivery with them.'
  if (op.checkedSent) return 'Send unconfirmed. No copy was found in Sent. Sending again may deliver a duplicate.'
  return 'Send unconfirmed. Check Sent before trying again.'
}

function recipientList(input: string) {
  return [...new Set(input.split(/[,;\n]/).map(value => value.trim()).filter(Boolean))]
}

export function Composer({ drafts, draftKey, inboxes, inboxId, reply, onSent }: Props) {
  const draft = useDraft(drafts, draftKey)
  const latest = reply?.latest
  const target = reply?.target
  const isReply = reply !== undefined
  const selectedInbox = draft.inboxId ?? sourceInbox(target, inboxes, inboxId)
  const operation = draft.operation
  const locked = Boolean(operation && operation.phase !== 'failed')
  const [validation, setValidation] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  function edit(changes: Partial<Draft>) {
    if (locked) return
    setValidation('')
    setConfirmation('')
    drafts.set(draftKey, { ...draft, ...changes, operation: undefined })
  }

  function editText(text: string) {
    const keepTarget = Boolean(text || draft.quoted)
    edit({ text, pinned: keepTarget ? target : undefined, inboxId: keepTarget ? selectedInbox : undefined })
  }

  async function submit(event?: FormEvent, action: 'send' | 'status' | 'retry' = 'send') {
    event?.preventDefault()
    const previous = drafts.get(draftKey).operation
    if (previous?.phase === 'sending' || previous?.phase === 'checking') return
    if (action === 'send' && previous && previous.phase !== 'failed') return
    if (action === 'retry' && previous?.phase !== 'missing' &&
      !(previous?.phase === 'unconfirmed' && previous.checkedSent && !previous.partial)) return
    const checking = action === 'status'
    const to = recipientList(draft.recipients)
    if (!checking && !isReply && (!to.length || to.some(address => !/^[^\s@,;<>]+@[^\s@,;<>]+$/.test(address)))) {
      setValidation('Enter each recipient’s email address, separated by commas.')
      document.getElementById('compose-to')?.focus()
      return
    }
    if (!checking && (!selectedInbox || !draft.text.trim() || (isReply ? !target : !draft.subject.trim()))) return
    if (checking && !previous) return
    const submissionId = (checking || previous?.phase === 'missing') && previous ? previous.id : Date.now() + '.' + crypto.randomUUID()
    const from = checking && previous ? previous.inboxId : selectedInbox
    const next: SendOperation = { id: submissionId, inboxId: from, phase: checking ? 'checking' : 'sending' }
    const frozen: Draft = { ...draft, pinned: target, inboxId: from }
    function finish(op: SendOperation) {
      drafts.set(draftKey, { ...frozen, operation: op })
    }
    finish(next)
    try {
      const input: SendInput = { submissionId, inboxId: from, body: draft.text,
        ...(isReply ? { replyToId: target?.id } : { to, subject: draft.subject.trim() }) }
      const result = checking
        ? await api<SendResult>('/mail/send/status', { submissionId, inboxId: from })
        : await api<SendResult>('/mail/send', input)
      if (result.status === 'sent') {
        drafts.set(draftKey, emptyDraft)
        const text = result.partial ? 'Message accepted for some recipients. Other recipients were rejected.'
          : result.sentCopy === false ? 'Message sent. A copy could not be confirmed in Sent.' : 'Message sent.'
        if (mounted.current) {
          if (isReply) setConfirmation(text)
          onSent(text)
        }
        return
      }
      finish({ ...next, phase: result.status, checkedSent: result.checkedSent, partial: result.partial })
    } catch (error) {
      if (error instanceof ApiError && error.code === 'SUBMISSION_EXPIRED') {
        finish({ ...next, phase: 'expired' })
      } else if (checking && error instanceof ApiError && error.code === 'SUBMISSION_NOT_FOUND') {
        finish({ ...next, phase: 'missing' })
      } else if (!checking && error instanceof ApiError && error.status >= 400 && error.status < 500) {
        finish({ ...next, phase: 'failed', details: error.message })
      } else {
        finish({ ...next, phase: 'unconfirmed', partial: previous?.partial,
          details: checking ? 'Couldn’t check the send status. Try checking again.' : undefined })
      }
    }
  }

  const canSend = Boolean(selectedInbox && inboxes.some(account => account.id === selectedInbox) &&
    draft.text.trim() && (isReply ? target : draft.subject.trim() && draft.recipients.trim()))
  const notice = operation ? operationLabel(operation) : confirmation
  return (
    <form className={isReply ? 'chat-composer' : 'new-message-composer'} aria-label={isReply ? 'Reply composer' : 'New message'} onSubmit={submit}>
      <div className="conversation-width composer-inner">
        <div className="composer-details">
          <div className="composer-addresses">
            <SelectField label="From" className="composer-from" value={selectedInbox} disabled={locked}
              options={inboxes.map(inbox => ({ value: inbox.id, label: inbox.email }))}
              onChange={id => edit({ inboxId: id, pinned: target })} />
            {target && <p className="composer-detail"><span>To</span>
              <span>{replyRecipients(target, inboxes).join(', ') || 'No external recipients'}</span>
            </p>}
          </div>
          {target && <p className="composer-detail composer-topic" data-topic-accent={reply?.accent}>
            <span>Subject</span><strong>{target.subject || '(No subject)'}</strong>
          </p>}
          {draft.quoted && target && <div className="composer-quote" data-topic-accent={reply?.accent}>
            <Reply aria-hidden="true" size={15} />
            <blockquote>{target.body.trim().slice(0, 160) || '(No message text)'}</blockquote>
            <Button type="button" data-variant="ghost" disabled={locked}
              onClick={() => edit({ pinned: latest, quoted: false, inboxId: undefined })}>Clear reply</Button>
          </div>}
          {!isReply && <>
            <Field id="compose-to" label="To" value={draft.recipients} placeholder="name@example.com"
              error={validation || undefined} required disabled={locked} onChange={event => edit({ recipients: event.target.value })} />
            <Field label="Subject" value={draft.subject} required disabled={locked} onChange={event => edit({ subject: event.target.value })} />
          </>}
        </div>
        <div className="composer-entry">
          <TextareaField id={isReply ? 'chat-reply' : 'compose-body'} className="composer-text" label={isReply ? 'Reply' : 'Message'}
            placeholder={isReply ? 'Write a reply…' : 'Write a message…'} rows={isReply ? 1 : 5} value={draft.text}
            required disabled={locked || (isReply && !target)}
            onChange={event => editText(event.target.value)}
            onKeyDown={event => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canSend && !locked) {
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            }} />
          <Button className="composer-submit" type="submit" data-variant="primary" disabled={!canSend || locked}>
            <span>{operation?.phase === 'failed' ? 'Try again' : 'Send'}</span>
            <ArrowUp aria-hidden="true" size={16} />
          </Button>
        </div>
        {notice && <div className="composer-feedback">
          <p role="status">{notice}</p>
          {(operation?.phase === 'unconfirmed' || operation?.phase === 'pending') &&
            <Button type="button" data-variant="secondary" onClick={() => void submit(undefined, 'status')}>Check Sent</Button>}
          {(operation?.phase === 'missing' || (operation?.phase === 'unconfirmed' && operation.checkedSent && !operation.partial)) &&
            <Button type="button" data-variant="secondary" onClick={() => void submit(undefined, 'retry')}>
              {operation.phase === 'missing' ? 'Retry send' : 'Send again'}
            </Button>}
          {(operation?.phase === 'expired' || operation?.phase === 'unconfirmed') &&
            <Button type="button" data-variant="ghost" onClick={() => drafts.set(draftKey, emptyDraft)}>Close draft</Button>}
        </div>}
      </div>
    </form>
  )
}

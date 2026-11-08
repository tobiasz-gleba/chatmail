import type { Inbox } from '@shared/contracts'
import { IconButton } from '@animate-ui/react/primitives/buttons/icon'
import { ArrowLeft } from '@/components/animate-ui/icons/arrow-left'
import { Composer } from './composer'
import type { ComposerDrafts } from '../composer-drafts'

interface Props {
  inboxes: Inbox[]
  inboxId?: string
  onBack: () => void
  onSent: (notice?: string) => void
  drafts: ComposerDrafts
}

export function NewMessage({ inboxes, inboxId, onBack, onSent, drafts }: Props) {
  return (
    <section className="conversation-pane" aria-labelledby="new-message-title">
      <header className="conversation-header">
        <div className="conversation-width conversation-heading">
          <IconButton aria-label="Back to chats" title="Back to chats" onClick={onBack}>
            <ArrowLeft aria-hidden="true" />
          </IconButton>
          <h2 id="new-message-title" tabIndex={-1}>New message</h2>
        </div>
      </header>
      <Composer drafts={drafts} draftKey="new-message" inboxes={inboxes} inboxId={inboxId} onSent={onSent} />
    </section>
  )
}

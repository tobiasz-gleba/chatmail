import { Button } from '@animate-ui/react/primitives/buttons/button'

interface MailNoticeProps {
  title?: string
  message: string
  action: string
  actionLabel?: string
  disabled?: boolean
  onAction: () => void
}

export function MailNotice({ title, message, action, actionLabel, disabled, onAction }: MailNoticeProps) {
  return (
    <div className="mail-notice">
      <div role="alert">
        {title && <strong>{title}</strong>}
        <p>{message}</p>
      </div>
      <Button data-variant="secondary" aria-label={actionLabel} onClick={onAction} disabled={disabled}>{action}</Button>
    </div>
  )
}

import { Mail } from './animate-ui/icons/mail'

export function Brand() {
  return (
    <span className="app-brand">
      <span className="app-brand-mark" aria-hidden="true"><Mail size={19} /></span>
      Chatmail
    </span>
  )
}

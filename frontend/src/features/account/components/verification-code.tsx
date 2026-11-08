import { useContext, useId } from 'react'
import { OTPInput, OTPInputContext, REGEXP_ONLY_DIGITS } from '@animate-ui/react/primitives/input-otp'
import { Label } from '@animate-ui/react/primitives/react-aria'

interface VerificationCodeProps {
  value: string
  onChange: (value: string) => void
  error?: string
  disabled?: boolean
}

function OtpGroup({ start }: { start: 0 | 3 }) {
  const { slots } = useContext(OTPInputContext)
  return (
    <span data-slot="input-otp-group" className="ui-otp-group" aria-hidden="true">
      {slots.slice(start, start + 3).map((slot, index) => (
        <span key={index} data-slot="input-otp-slot" data-active={slot.isActive} className="ui-otp-slot">
          {slot.char}{slot.hasFakeCaret && <span className="ui-caret" />}
        </span>
      ))}
    </span>
  )
}

export function VerificationCode({ error, ...input }: VerificationCodeProps) {
  const id = useId()
  return (
    <div className="ui-field">
      <Label className="ui-label" htmlFor={id}>One-time code</Label>
      <OTPInput {...input} autoFocus id={id} name="code" autoComplete="one-time-code" maxLength={6} inputMode="numeric" spellCheck={false}
        pattern={REGEXP_ONLY_DIGITS} pasteTransformer={text => text.replace(/[^0-9]/g, '')}
        aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined}
        containerClassName="ui-otp" data-slot="input-otp">
        <OtpGroup start={0} />
        <span data-slot="input-otp-separator" aria-hidden="true">−</span>
        <OtpGroup start={3} />
      </OTPInput>
      {error && <p id={`${id}-error`} role="alert" className="ui-error">{error}</p>}
    </div>
  )
}

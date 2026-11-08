import type { ComponentProps, ReactNode } from 'react'
import {
  Button as Trigger, Input, Label, ListBox, ListBoxItem, Popover, Select,
  SelectionIndicator, SelectValue, Text, TextArea, TextField,
} from '@animate-ui/react/primitives/react-aria'
import { Check } from './animate-ui/icons/check'
import { ChevronUpDown } from './animate-ui/icons/chevron-up-down'

interface FieldLabels {
  label: string
  hint?: string
  error?: string
  className?: string
}

function FieldGroup({ label, hint, error, className = '', children, ...props }: FieldLabels & {
  id?: string
  disabled?: boolean
  required?: boolean
  children: ReactNode
}) {
  return (
    <TextField id={props.id} className={`ui-field ${className}`} isInvalid={!!error}
      isDisabled={props.disabled} isRequired={props.required}>
      <Label className="ui-label">{label}</Label>
      {children}
      {hint && <Text slot="description" className="ui-hint">{hint}</Text>}
      {error && <Text slot="errorMessage" role="alert" className="ui-error">{error}</Text>}
    </TextField>
  )
}

export function Field({ label, hint, error, className, id, ...input }: FieldLabels & ComponentProps<'input'>) {
  return (
    <FieldGroup {...{ label, hint, error, id, className }} disabled={input.disabled} required={input.required}>
      <Input {...input} className="ui-input" />
    </FieldGroup>
  )
}

export function TextareaField({ label, hint, error, className, id, ...textarea }: FieldLabels & ComponentProps<'textarea'>) {
  return (
    <FieldGroup {...{ label, hint, error, id, className }} disabled={textarea.disabled} required={textarea.required}>
      <TextArea {...textarea} className="ui-input ui-textarea" />
    </FieldGroup>
  )
}

interface SelectFieldProps {
  label: string
  value: string
  onChange: (value: string) => void
  options: ReadonlyArray<{ value: string; label: string }>
  disabled?: boolean
  className?: string
}

export function SelectField({ label, value, onChange, options, disabled, className = '' }: SelectFieldProps) {
  return (
    <Select className={`ui-field ${className}`} value={`option-${value}`}
      onChange={key => { if (typeof key === 'string') onChange(key.slice('option-'.length)) }} isDisabled={disabled}>
      <Label className="ui-label">{label}</Label>
      <Trigger className="ui-select-trigger">
        <SelectValue className="ui-select-value">{({ selectedText }) => selectedText}</SelectValue>
        <ChevronUpDown size={15} aria-hidden="true" />
      </Trigger>
      <Popover className="ui-popover" placement="bottom start" offset={4}>
        <ListBox className="ui-options" aria-label={label}>
          {options.map(option => (
            <ListBoxItem key={option.value} id={`option-${option.value}`} textValue={option.label} className="ui-option">
              <span>{option.label}</span>
              <SelectionIndicator className="ui-selection-indicator" aria-hidden="true">
                <Check size={15} />
              </SelectionIndicator>
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </Select>
  )
}

import { Button, Menu, MenuItem, MenuTrigger, Popover } from '@animate-ui/react/primitives/react-aria'
import { ChevronUpDown } from '@/components/animate-ui/icons/chevron-up-down'
import { initials } from '../mail-format'

interface AccountMenuProps {
  email: string
  onManageInboxes: () => void
  onLogout: () => void
}

export function AccountMenu({ email, onManageInboxes, onLogout }: AccountMenuProps) {
  return (
    <MenuTrigger>
      <Button aria-label={email} className="ui-menu-trigger chat-account-menu">
        <span className="chat-account-avatar" aria-hidden="true">{initials(email)}</span>
        <span className="ui-menu-label">{email}</span>
        <ChevronUpDown size={15} aria-hidden="true" />
      </Button>
      <Popover className="ui-popover" placement="top start" offset={4}>
        <Menu className="ui-options" aria-label={email}>
          <MenuItem className="ui-option" onAction={onManageInboxes}>Manage inboxes</MenuItem>
          <MenuItem className="ui-option" onAction={onLogout}>Sign out</MenuItem>
        </Menu>
      </Popover>
    </MenuTrigger>
  )
}

import { useEffect, useRef } from 'react'
import type { Chat } from '@shared/contracts'
import { MessageSquareText } from '@/components/animate-ui/icons/message-square-text'
import type { ComposerDrafts } from '../composer-drafts'
import { NewMessage } from './new-message'
import { ChatSidebar, type ChatSidebarProps } from './chat-sidebar'
import { ChatView } from './chat-view'
import '../workspace.css'

interface WorkspaceLayoutProps {
  sidebar: ChatSidebarProps
  chat: Chat | null
  composing: boolean
  mobileDetailOpen: boolean
  announcement: string
  version: number
  checkVersion: number
  drafts: ComposerDrafts
  onBack: () => void
  onSent: (message?: string) => void
  onRead: (id: string) => void
}

export function WorkspaceLayout({ sidebar, chat, composing, mobileDetailOpen, announcement, version, checkVersion, drafts,
  onBack, onSent, onRead }: WorkspaceLayoutProps) {
  const container = useRef<HTMLElement>(null)
  useEffect(() => {
    const viewport = window.visualViewport
    const frame = container.current
    if (!viewport || !frame) return
    // Some mobile browsers resize only the visual viewport when the keyboard opens.
    const resize = () => {
      if (viewport.scale === 1) frame.style.setProperty('--visible-height', `${viewport.height}px`)
    }
    resize()
    viewport.addEventListener('resize', resize)
    return () => viewport.removeEventListener('resize', resize)
  }, [])

  const { inboxes, inboxId } = sidebar
  return (
    <main ref={container} className="chat-workspace" data-mobile-pane={mobileDetailOpen ? 'detail' : 'list'}>
      <ChatSidebar {...sidebar} />
      <div className="workspace-detail">
        {chat ? <ChatView key={chat.id + '/' + (inboxId ?? '')} chat={chat} inboxId={inboxId} inboxes={inboxes}
          drafts={drafts} version={version} checkVersion={checkVersion} onBack={onBack} onSent={onSent} onRead={onRead} />
          : composing ? <NewMessage inboxes={inboxes} inboxId={inboxId} onBack={onBack} onSent={onSent} drafts={drafts} />
            : <section className="workspace-welcome" aria-label="Conversation">
              <span className="workspace-welcome-mark"><MessageSquareText size={29} aria-hidden="true" /></span>
              <h2>Select a chat</h2>
            </section>}
      </div>
      {announcement && <p className="workspace-announcement" role="status">{announcement}</p>}
    </main>
  )
}

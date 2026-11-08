import type { Chat, ChatMessage, ChatPage, InboxFailure, MessagePage } from '@shared/contracts'

export const CHAT_LIMIT = 100

function union(left: string[], right: string[]) {
  return [...new Set([...left, ...right])]
}

export function mergeChats(previous: Chat[], incoming: Chat[]): Chat[] {
  const rows = new Map(previous.map(row => [row.id, row]))
  for (const row of incoming) {
    const existing = rows.get(row.id)
    rows.set(row.id, existing ? {
      ...(row.latestAt > existing.latestAt ? row : existing),
      unread: existing.unread || row.unread,
      inboxIds: union(existing.inboxIds, row.inboxIds),
    } : row)
  }
  return [...rows.values()]
    .sort((a, b) => b.latestAt.localeCompare(a.latestAt) || a.id.localeCompare(b.id))
    .slice(0, CHAT_LIMIT)
}

export function mergeFailures(previous: InboxFailure[], incoming: InboxFailure[]) {
  const byInbox = new Map(previous.map(item => [item.inboxId, item]))
  for (const item of incoming) byInbox.set(item.inboxId, item)
  return [...byInbox.values()]
}

export async function scanChats(
  getPage: (cursor: string | null) => Promise<ChatPage>,
  signal: AbortSignal,
  options: { previousHead?: string; show?: (chats: Chat[], failures: InboxFailure[]) => void } = {},
) {
  let chats: Chat[] = []
  let failures: InboxFailure[] = []
  let cursor: string | null = null
  let head: string | undefined
  let headFailures: InboxFailure[] = []
  do {
    const page = await getPage(cursor)
    if (signal.aborted) return
    if (page.cursor && page.cursor === cursor) throw new Error('Mail server did not advance to the next page.')
    chats = mergeChats(chats, page.chats)
    failures = mergeFailures(failures, page.failures)
    // Empty pages may only have advanced the server's mailbox scan. Wait for
    // actual rows (or the end) and ignore the freshly issued cursor token.
    if (head === undefined && (chats.length || !page.cursor)) {
      headFailures = [...failures].sort((a, b) => a.inboxId.localeCompare(b.inboxId))
      head = JSON.stringify([chats, headFailures, Boolean(page.cursor)])
      if (head === options.previousHead) return
    }
    options.show?.(chats, failures)
    cursor = page.cursor
  } while (cursor && chats.length < CHAT_LIMIT)
  // A failure deeper in history must be checked again even on an idle poll.
  return { chats, failures, head: failures.length === headFailures.length ? head : undefined }
}

export interface DisplayMessage extends ChatMessage {
  unreadIds: string[]
}

export function createMessagePager() {
  return { cursor: undefined as string | null | undefined, pending: [] as ChatMessage[], seen: new Set<string>(), oldestKey: '' }
}

export function hasMoreMessages(pager: ReturnType<typeof createMessagePager>) {
  return pager.pending.length > 0 || pager.cursor !== null
}

// A server page covers bounded work across several mailboxes. A visible window
// counts actual messages in this chat and can span many such server pages.
export async function loadMessageWindow(
  pager: ReturnType<typeof createMessagePager>,
  getPage: (cursor: string | null) => Promise<MessagePage>,
  show: (messages: ChatMessage[], failures: InboxFailure[]) => void,
  signal: AbortSignal,
  until?: (message: ChatMessage) => boolean,
) {
  const target = until ? Infinity : pager.seen.size + 20
  let reached = false
  while (!signal.aborted && !reached && hasMoreMessages(pager) && pager.seen.size < target) {
    let failures: InboxFailure[] = []
    if (!pager.pending.length) {
      const page = await getPage(pager.cursor ?? null)
      if (signal.aborted) return
      if (page.cursor && page.cursor === pager.cursor) throw new Error('Mail server did not advance to older messages.')
      pager.cursor = page.cursor
      pager.pending = page.messages
      failures = page.failures
    }
    let count = 0
    while (count < pager.pending.length && !reached && pager.seen.size < target) {
      const message = pager.pending[count]
      pager.seen.add(message.key)
      pager.oldestKey = message.key
      reached = until?.(message) ?? false
      count++
    }
    const ready = pager.pending.slice(0, count)
    pager.pending = pager.pending.slice(count)
    show(ready, failures)
  }
}

// Some servers return a parent ID without full References. An older page can
// supply that parent's ancestors, joining topics already on screen.
function resolveTopicRoots(messages: DisplayMessage[]) {
  const parents = new Map<string, string>()
  for (const message of messages) {
    const ancestors = message.ancestorKeys?.length ? message.ancestorKeys
      : message.key !== message.topicId ? [message.topicId] : []
    const path = [...ancestors, message.key]
    for (let index = 1; index < path.length; index++) {
      if (path[index] !== path[index - 1] && !parents.has(path[index])) parents.set(path[index], path[index - 1])
    }
  }
  const known = new Map<string, string>()
  return messages.map(message => {
    const path = new Set<string>()
    let key = message.key
    while (parents.has(key) && !known.has(key)) {
      if (path.has(key)) {
        const visited = [...path]
        key = visited.slice(visited.indexOf(key)).sort()[0]
        break
      }
      path.add(key)
      key = parents.get(key)!
    }
    const root = known.get(key) ?? key
    for (const visited of path) known.set(visited, root)
    return message.topicId === root ? message : { ...message, topicId: root }
  })
}

export function mergeMessages(previous: DisplayMessage[], incoming: ChatMessage[],
  options: { marking?: ReadonlySet<string>; refreshLocators?: boolean } = {}): DisplayMessage[] {
  const byKey = new Map(previous.map(message => [message.key, message]))
  for (const message of incoming) {
    const existing = byKey.get(message.key)
    const unreadIds = union(existing?.unreadIds ?? [], message.unread && !options.marking?.has(message.id) ? [message.id] : [])
    byKey.set(message.key, {
      ...message,
      id: options.refreshLocators ? message.id : existing?.id ?? message.id,
      inboxIds: union(existing?.inboxIds ?? [], message.inboxIds),
      unread: unreadIds.length > 0,
      unreadIds,
    })
  }
  return resolveTopicRoots([...byKey.values()]).sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.key.localeCompare(b.key))
}

export function chatName(chat: Chat): string {
  return chat.participants.map(person => person.name?.trim() || person.email).join(', ') || 'Your addresses'
}

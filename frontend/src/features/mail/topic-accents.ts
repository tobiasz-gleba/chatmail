import { useMemo, useState } from 'react'
import type { ChatMessage } from '@shared/contracts'

const palette = ['teal', 'blue', 'violet', 'amber', 'rose'] as const
export type TopicAccent = typeof palette[number]
type Assignments = ReadonlyMap<string, TopicAccent>

function preferredAccent(topicId: string) {
  let hash = 0
  for (let i = 0; i < topicId.length; i++) hash = (Math.imul(hash, 31) + topicId.charCodeAt(i)) >>> 0
  return palette[hash % palette.length]
}

export function assignTopicAccents(previous: Assignments, topics: ReadonlySet<string>): Assignments {
  const missing = [...topics].filter(id => !previous.has(id))
  if (!missing.length) return previous

  const next = new Map(previous)
  const seenColors = new Set(previous.values())
  const visibleColors = new Set([...topics].map(id => previous.get(id)))
  for (const id of missing) {
    const preferred = preferredAccent(id)
    // Reserve colors for loaded history too. Once all five have been used,
    // a merged or currently unloaded topic may have freed a visible color.
    const reserved = seenColors.size < palette.length ? seenColors : visibleColors
    const accent = reserved.has(preferred) ? palette.find(color => !reserved.has(color)) ?? preferred : preferred
    next.set(id, accent)
    seenColors.add(accent)
    visibleColors.add(accent)
  }
  return next
}

export function useTopicAccents(messages: readonly ChatMessage[], replyTopic?: string) {
  const [assigned, setAssigned] = useState<Assignments>(() => new Map())
  const topics = useMemo(() => {
    const ids = new Set(messages.map(message => message.topicId))
    // A pinned reply can be available before its page of history is loaded.
    if (replyTopic !== undefined) ids.add(replyTopic)
    return ids
  }, [messages, replyTopic])
  const next = useMemo(() => assignTopicAccents(assigned, topics), [assigned, topics])
  if (next !== assigned) setAssigned(next)
  return next
}

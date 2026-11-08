import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMessage, InboxFailure, MessagePage } from '@shared/contracts'
import { api, ApiError } from '@/api'
import { createMessagePager, type DisplayMessage, hasMoreMessages, loadMessageWindow, mergeFailures, mergeMessages } from './live'

interface LiveRequest {
  controller: AbortController
  marking: Set<string>
  update: (activity: string, version: number, checkVersion: number) => void
  loadOlder: () => void
  retry: () => void
}

type Load = 'history' | 'latest'

export function useMessages(chatId: string, inboxId: string | undefined, version: number, activity: string, checkVersion: number) {
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [hasOlder, setHasOlder] = useState(false)
  const [loading, setLoading] = useState(true)
  const [historyError, setHistoryError] = useState('')
  const [latestError, setLatestError] = useState('')
  const [failures, setFailures] = useState<InboxFailure[]>([])
  const [readError, setReadError] = useState(false)
  const request = useRef<LiveRequest | null>(null)
  const failedIds = useRef(new Set<string>())

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    const marking = new Set<string>()
    const getPage = (cursor: string | null) => api<MessagePage>('/mail/messages', { chatId, inboxId, cursor }, 'POST', signal)
    let history = createMessagePager()
    let rebuildHistory = false
    const failed = new Set<Load>()
    const pending = new Map<Load, boolean>()
    let running: Load | undefined
    let previous: { activity: string; version: number; checkVersion: number } | undefined

    function show(incoming: ChatMessage[], refreshLocators = false) {
      if (incoming.length) setMessages(current => mergeMessages(current, incoming, { marking, refreshLocators }))
    }
    async function loadHistory() {
      await loadMessageWindow(history, getPage, (incoming, offline) => {
        setHasOlder(hasMoreMessages(history))
        if (offline.length) {
          rebuildHistory = true
          setFailures(current => mergeFailures(current, offline))
        }
        show(incoming)
      }, signal)
    }
    async function loadLatest() {
      const fresh = createMessagePager()
      const incoming: ChatMessage[] = []
      let offline: InboxFailure[] = []
      // An expired cursor or dropped mailbox needs a new history cursor at
      // the oldest displayed message. Otherwise stop at the first overlap.
      const overlap = (message: ChatMessage) => rebuildHistory ? history.oldestKey === message.key : history.seen.has(message.key)
      await loadMessageWindow(fresh, getPage, (rows, failures) => {
        incoming.push(...rows)
        offline = mergeFailures(offline, failures)
      }, signal, history.seen.size ? overlap : undefined)
      if (signal.aborted) return

      // Commit the new head together. A failed second page must not become an
      // overlap point on the next attempt, leaving a gap before the old head.
      // The server may also have supplied fresh reply locators for already
      // displayed messages past the overlap point in this same response.
      incoming.push(...fresh.pending.filter(message => history.seen.has(message.key)))
      if (!history.seen.size || (rebuildHistory && !offline.length)) {
        history = fresh
        setHasOlder(hasMoreMessages(history))
      } else if (!offline.length) {
        for (const key of fresh.seen) history.seen.add(key)
      }
      rebuildHistory = offline.length > 0
      setFailures(offline)
      show(incoming, true)
    }

    async function loadOlderWindow() {
      try {
        await loadHistory()
      } catch (error) {
        if (!history.cursor || !(error instanceof ApiError) || error.code !== 'INVALID_MAIL_REQUEST') throw error
        // History cursors expire after an hour even if the tab keeps polling.
        rebuildHistory = true
        await loadLatest()
        if (!signal.aborted && !rebuildHistory && hasMoreMessages(history)) await loadHistory()
      }
    }

    async function run(job: Load, quiet = false) {
      if (signal.aborted || (job === 'history' && running === 'history')) return
      // Preserve an update arriving during a slow history load or head check.
      if (!pending.has(job) || !quiet) pending.set(job, quiet)
      if (running) return
      for (const [next, silent] of pending) {
        pending.delete(next)
        running = next
        const setError = next === 'history' ? setHistoryError : setLatestError
        if (!silent) setLoading(true)
        try {
          if (next === 'history') await loadOlderWindow()
          else await loadLatest()
          if (signal.aborted) return
          failed.delete(next)
          setError('')
        } catch (error) {
          if (signal.aborted) return
          failed.add(next)
          setError(error instanceof Error ? error.message : 'Could not load the conversation.')
        } finally {
          if (!signal.aborted && !silent) setLoading(false)
        }
      }
      running = undefined
    }

    request.current = {
      controller, marking,
      loadOlder: () => { if (hasMoreMessages(history)) void run('history') },
      retry: () => { for (const job of failed) void run(job, job === 'latest') },
      update(activity, version, checkVersion) {
        const changed = previous && (previous.activity !== activity || previous.version !== version)
        const checked = previous && previous.checkVersion !== checkVersion
        previous = { activity, version, checkVersion }
        const retryLatest = checked && running !== 'latest' && (rebuildHistory || failed.has('latest'))
        if (changed || retryLatest) void run('latest', true)
        if (checked && failed.has('history')) void run('history', true)
      },
    }
    setMessages([])
    setFailures([])
    setHistoryError('')
    setLatestError('')
    setHasOlder(false)
    setReadError(false)
    failedIds.current = new Set()
    void run('history')
    return () => { controller.abort() }
  }, [chatId, inboxId])

  useEffect(() => {
    request.current?.update(activity, version, checkVersion)
  }, [activity, version, checkVersion, chatId, inboxId])

  const loadOlder = useCallback(() => request.current?.loadOlder(), [])
  const retryPage = useCallback(() => request.current?.retry(), [])

  const saveRead = useCallback(async (ids: string[]) => {
    const session = request.current
    if (!session || session.controller.signal.aborted) return
    const { signal } = session.controller
    const pending = [...new Set(ids)].filter(id => !session.marking.has(id))
    pending.forEach(id => session.marking.add(id))
    for (let index = 0; index < pending.length; index += 50) {
      if (signal.aborted) return
      const group = pending.slice(index, index + 50)
      try {
        await api('/mail/read', { messageIds: group }, 'POST', signal)
        if (signal.aborted) return
        const read = new Set(group)
        setMessages(current => current.map(message => {
          if (!message.unreadIds.some(id => read.has(id))) return message
          const unreadIds = message.unreadIds.filter(id => !read.has(id))
          return { ...message, unreadIds, unread: unreadIds.length > 0 }
        }))
        for (const id of group) failedIds.current.delete(id)
        setReadError(failedIds.current.size > 0)
      } catch {
        if (signal.aborted) return
        for (const id of group) {
          failedIds.current.add(id)
          session.marking.delete(id)
        }
        setReadError(true)
      }
    }
  }, [])

  const visible = useCallback((ids: string[]) => {
    const visibleIds = new Set(ids)
    const sources = messages.filter(message => visibleIds.has(message.id))
      .flatMap(message => message.unreadIds).filter(id => !failedIds.current.has(id))
    void saveRead(sources)
  }, [messages, saveRead])
  const retryRead = useCallback(() => { void saveRead([...failedIds.current]) }, [saveRead])

  return { messages, hasOlder, loading, loadOlder, readError, retryRead, visible, failures, error: historyError || latestError, retryPage }
}

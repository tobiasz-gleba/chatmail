import { useCallback, useEffect, useRef, useState } from 'react'
import type { Chat, ChatPage, InboxFailure } from '@shared/contracts'
import { api } from '@/api'
import { mergeChats, mergeFailures, scanChats } from './live'

const POLL_DELAY = 10_000
const getPage = (inboxId: string | undefined, cursor: string | null, signal: AbortSignal) =>
  api<ChatPage>('/mail/chats', { inboxId, cursor }, 'POST', signal)

export function useChatList(inboxId: string | undefined, refreshVersion: number) {
  const [chats, setChats] = useState<Chat[]>([])
  const [failures, setFailures] = useState<InboxFailure[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [retrying, setRetrying] = useState<string[]>([])
  const [checkVersion, setCheckVersion] = useState(0)
  const retry = useRef<(failedId: string) => Promise<boolean | undefined>>(undefined)
  const previousInbox = useRef(inboxId)
  const hasResult = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    const pendingRetries = new Set<string>()
    let timer: number | undefined
    let checking: Promise<void> | undefined
    let head: string | undefined

    if (previousInbox.current !== inboxId) {
      previousInbox.current = inboxId
      hasResult.current = false
      setChats([])
      setFailures([])
      setError('')
    }
    setLoading(!hasResult.current)
    setRetrying([])

    async function scan() {
      try {
        const result = await scanChats(cursor => getPage(inboxId, cursor, signal), signal, {
          previousHead: head,
          // Show the first load progressively. Later scans commit together so a
          // failed check can't replace the user's last successful view.
          show: hasResult.current ? undefined : (rows, offline) => {
            setChats(rows)
            setFailures(offline)
          },
        })
        if (signal.aborted) return
        if (result) {
          head = result.head
          const offline = new Set(result.failures.map(failure => failure.inboxId))
          setChats(current => offline.size
            ? mergeChats(result.chats, current.filter(chat => chat.inboxIds.some(id => offline.has(id))))
            : result.chats)
          setFailures(result.failures)
        }
        hasResult.current = true
        setError('')
        setCheckVersion(value => value + 1)
      } catch (error) {
        if (!signal.aborted) setError(error instanceof Error ? error.message : 'Could not load your chats.')
      } finally {
        if (!signal.aborted) setLoading(false)
      }
    }

    function schedule() {
      window.clearTimeout(timer)
      if (!signal.aborted && document.visibilityState === 'visible' && !checking && !pendingRetries.size) {
        timer = window.setTimeout(check, POLL_DELAY)
      }
    }
    function check() {
      if (signal.aborted || document.visibilityState !== 'visible' || checking || pendingRetries.size) return
      window.clearTimeout(timer)
      checking = scan().finally(() => {
        checking = undefined
        schedule()
      })
    }
    function visibilityChanged() {
      if (document.visibilityState === 'visible') check()
      else window.clearTimeout(timer)
    }

    retry.current = async failedId => {
      if (pendingRetries.has(failedId)) return
      pendingRetries.add(failedId)
      setRetrying([...pendingRetries])
      window.clearTimeout(timer)
      try {
        // Let an in-flight poll finish before writing the recovered inbox rows.
        await checking
        if (signal.aborted) return
        head = undefined
        const result = await scanChats(cursor => getPage(failedId, cursor, signal), signal)
        if (signal.aborted || !result) return
        setChats(current => mergeChats(current, result.chats))
        setFailures(current => mergeFailures(current.filter(item => item.inboxId !== failedId), result.failures))
        return !result.failures.some(item => item.inboxId === failedId)
      } catch (error) {
        if (!signal.aborted) setFailures(current => mergeFailures(current, [{
          inboxId: failedId,
          message: error instanceof Error ? error.message : 'Could not connect.',
        }]))
      } finally {
        pendingRetries.delete(failedId)
        if (!signal.aborted) {
          setRetrying([...pendingRetries])
          schedule()
        }
      }
    }

    document.addEventListener('visibilitychange', visibilityChanged)
    check()
    return () => {
      controller.abort()
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', visibilityChanged)
      retry.current = undefined
    }
  }, [inboxId, refreshVersion])

  const retryInbox = useCallback((failedId: string) => retry.current?.(failedId), [])
  const markChatRead = useCallback((chatId: string) => {
    setChats(current => current.some(chat => chat.id === chatId && chat.unread)
      ? current.map(chat => chat.id === chatId ? { ...chat, unread: false } : chat)
      : current)
  }, [])
  return { chats, failures, error, loading, retrying, checkVersion, retryInbox, markChatRead }
}

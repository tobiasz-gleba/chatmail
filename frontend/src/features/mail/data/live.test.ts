import { expect, test } from 'bun:test'
import type { Chat, ChatMessage, ChatPage, MessagePage } from '@shared/contracts'
import { createMessagePager, hasMoreMessages, loadMessageWindow, mergeMessages, scanChats } from './live'

function row(id: string, time = 0, inbox = 'work'): Chat {
  return { id, latestAt: new Date(time).toISOString(), subject: id, participants: [{ email: id }], unread: true, inboxIds: [inbox] }
}

test('initial scan counts 100 distinct chats across pages and reports partial failures', async () => {
  const ada = row('ada', 1000)
  const pages: ChatPage[] = [
    { chats: Array(100).fill(ada), cursor: 'more', failures: [{ inboxId: 'offline', message: 'Unavailable' }] },
    { chats: [row('ada', 200, 'personal'), ...Array.from({ length: 110 }, (_, n) => row(String(n), n))], cursor: 'next', failures: [] },
  ]
  const counts: number[] = []
  await scanChats(async () => pages.shift()!, new AbortController().signal, { show: (chats, failures) => {
    counts.push(chats.length)
    expect(failures[0]?.inboxId).toBe('offline')
    if (chats.length === 100) {
      expect(chats[0].inboxIds).toEqual(['work', 'personal'])
      expect(chats.at(-1)?.id).toBe('11')
    }
  } })
  expect(counts).toEqual([1, 100])
})

test('idle inbox checks follow empty pages and skip older mail until the newest rows or failures change', async () => {
  const signal = new AbortController().signal
  const ada = row('ada', 1000)
  const older = row('older')
  const failure = { inboxId: 'personal', message: 'Unavailable' }
  const cursors: (string | null)[] = []
  let offline = true
  let generation = 0
  async function scan(previousHead?: string) {
    generation++
    cursors.length = 0
    return scanChats(async cursor => {
      cursors.push(cursor)
      if (!cursor) return { chats: [], cursor: 'next-' + generation, failures: offline ? [failure] : [] }
      if (cursor.startsWith('next-')) return { chats: [ada], cursor: 'older-' + generation, failures: [] }
      return { chats: [older], cursor: null, failures: [] }
    }, signal, { previousHead })
  }
  const initial = await scan()
  expect(initial?.chats).toEqual([ada, older])
  expect(await scan(initial?.head)).toBeUndefined()
  expect(cursors).toEqual([null, 'next-2'])
  offline = false
  const recovered = await scan(initial?.head)
  expect(recovered?.failures).toEqual([])
  expect(cursors).toEqual([null, 'next-3', 'older-3'])
  ada.subject = 'New subject'
  expect((await scan(recovered?.head))?.chats[0].subject).toBe('New subject')
})

test('message copies collapse by stable key while retaining all unread locators', () => {
  const message: ChatMessage = {
    id: 'work-locator', key: 'canonical', topicId: 'first', subject: 'Plans', from: { email: 'a@example.com' },
    to: [], cc: [], replyTo: [], body: 'Hello', sentAt: '2025-01-01', outgoing: false, inboxIds: ['work'], unread: true,
  }
  const first = mergeMessages([], [message])
  const all = mergeMessages(first, [{ ...message, id: 'personal-locator', inboxIds: ['personal'] }])
  expect(all.length).toBe(1)
  expect(all[0].id).toBe('work-locator')
  expect(all[0].inboxIds).toEqual(['work', 'personal'])
  expect(all[0].unreadIds).toEqual(['work-locator', 'personal-locator'])
})

test('reconnects a short reply chain when its parent arrives on an older page', () => {
  const child: ChatMessage = {
    id: 'child-locator', key: 'child', topicId: 'parent', ancestorKeys: ['parent'], subject: 'Plans',
    from: { email: 'a@example.com' }, to: [], cc: [], replyTo: [], body: '', sentAt: '2025-01-02',
    outgoing: false, inboxIds: ['work'], unread: false,
  }
  const first = mergeMessages([], [child])
  const all = mergeMessages(first, [{ ...child, id: 'parent-locator', key: 'parent', topicId: 'root', ancestorKeys: ['root'], sentAt: '2025-01-01' }])
  expect(all.map(message => message.topicId)).toEqual(['root', 'root'])
})


function entry(index: number): ChatMessage {
  const id = String(index)
  return {
    id, key: id, topicId: id, from: { email: 'ada@example.com' }, to: [], cc: [], replyTo: [],
    subject: 'Hello', body: 'Body', sentAt: new Date(index).toISOString(), outgoing: false, inboxIds: ['work'], unread: false,
  }
}

test('fills visible windows from sparse pages, counting copied messages once and retaining the final page overflow', async () => {
  const pages: MessagePage[] = [
    { cursor: '2', messages: [entry(30)], failures: [] },
    { cursor: '3', messages: [], failures: [] },
    { cursor: '4', messages: [entry(30), entry(29)], failures: [] },
    { cursor: null, messages: Array.from({ length: 20 }, (_, i) => entry(28 - i)), failures: [] },
  ]
  const cursors: (string | null)[] = []
  const getPage = async (cursor: string | null) => { cursors.push(cursor); return pages.shift()! }
  const pager = createMessagePager()
  const snapshots: string[][] = []
  const signal = new AbortController().signal
  const show = (messages: ChatMessage[]) => snapshots.push(messages.map(message => message.key))
  await loadMessageWindow(pager, getPage, show, signal)
  expect(snapshots.slice(0, 3)).toEqual([['30'], [], ['30', '29']])
  expect(pager.seen.size).toBe(20)
  expect(hasMoreMessages(pager)).toBe(true)
  await loadMessageWindow(pager, getPage, show, signal)
  expect(snapshots.at(-1)).toEqual(['10', '9'])
  expect(pager.seen.size).toBe(22)
  expect(hasMoreMessages(pager)).toBe(false)
  expect(cursors).toEqual([null, '2', '3', '4'])
})

test('cancelled window ignores an in-flight page and stops requesting more mail', async () => {
  const controller = new AbortController()
  const pager = createMessagePager()
  const received: string[] = []
  let calls = 0
  await loadMessageWindow(pager, async () => {
    if (++calls === 2) controller.abort()
    return { messages: [entry(calls)], cursor: String(calls), failures: [] }
  }, messages => received.push(...messages.map(message => message.id)), controller.signal)
  expect(calls).toBe(2)
  expect(received).toEqual(['1'])
  expect(pager.cursor).toBe('1')
})

test('new arrivals bridge sparse pages and stop at the first loaded message even after more than one window', async () => {
  const pages: MessagePage[] = [
    { cursor: '2', messages: [], failures: [] },
    { cursor: '3', messages: Array.from({ length: 20 }, (_, i) => entry(30 - i)), failures: [] },
    { cursor: '4', messages: [entry(10), entry(9), entry(8)], failures: [] },
  ]
  const known = new Set(['9', '8', '7'])
  const fresh = createMessagePager()
  const keys: string[] = []
  await loadMessageWindow(fresh, async () => pages.shift()!, rows => keys.push(...rows.map(row => row.key)),
    new AbortController().signal, row => known.has(row.key))
  expect(keys).toEqual(Array.from({ length: 22 }, (_, i) => String(30 - i)))
  expect(fresh.pending.map(row => row.key)).toEqual(['8'])
  expect(fresh.cursor).toBe('4')
})

test('a refresh started before a read completes cannot mark the same copy unread again', () => {
  const read = entry(1)
  const stale = { ...read, unread: true }
  const messages = mergeMessages(mergeMessages([], [read]), [stale], { marking: new Set([read.id]) })
  expect(messages[0].unread).toBe(false)
  expect(messages[0].unreadIds).toEqual([])
})

test('refreshing a moved message updates its reply locator and keeps its stable key', () => {
  const before = entry(1)
  const after = { ...before, id: 'moved-locator' }
  const current = mergeMessages(mergeMessages([], [before]), [after], { refreshLocators: true })
  expect(current.map(message => [message.key, message.id])).toEqual([[before.key, after.id]])
})

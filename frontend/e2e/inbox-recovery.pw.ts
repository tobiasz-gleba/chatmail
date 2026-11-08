import { expect, test } from '@playwright/test'
import { latestMessage, MockApi, samChat } from './mock-api'

test('the next inbox check recovers a failed conversation update at the same reading position', async ({ page }) => {
  await page.clock.install()
  const api = new MockApi()
  api.chats = [{ ...samChat, unread: false }]
  api.messages = Array.from({ length: 35 }, (_, index) => ({
    ...latestMessage, id: String(index), key: String(index), unread: false, body: `Earlier message ${index}`,
    sentAt: new Date(Date.parse(latestMessage.sentAt) - index * 60_000).toISOString(),
  }))
  await api.install(page)
  await page.goto('/')
  await page.getByRole('button', { name: /Sam Lee/ }).click()
  const history = page.getByRole('region', { name: 'Conversation history' })
  await expect(history.getByText('Earlier message 0', { exact: true })).toBeInViewport()
  await history.evaluate(region => { region.scrollTop = 0 })
  const anchor = history.getByText('Earlier message 25', { exact: true })
  await anchor.scrollIntoViewIfNeeded()
  await page.evaluate(() => document.fonts.ready)
  const before = await anchor.evaluate(element => element.getBoundingClientRect().top)

  const incoming = { ...latestMessage, subject: 'New arrival', body: 'Mail just arrived.', unread: false,
    sentAt: '2026-11-08T11:00:00.000Z' }
  api.chats = [{ ...samChat, latestAt: incoming.sentAt, subject: incoming.subject, unread: false }]
  api.messages = [incoming, ...api.messages.slice(0, 19)]
  await page.route('**/api/mail/messages', route => route.fulfill({
    status: 503, json: { error: { message: 'Mailbox temporarily offline' } },
  }), { times: 1 })

  await page.clock.fastForward(10_000)
  await expect(page.getByText('Mailbox temporarily offline')).toBeVisible()
  await expect(anchor).toBeInViewport()
  await page.clock.fastForward(10_000)
  await expect(history.getByText(incoming.body)).toBeAttached()
  await expect(page.getByText('Mailbox temporarily offline')).toHaveCount(0)
  await expect.poll(() => anchor.evaluate((element, top) =>
    Math.abs(element.getBoundingClientRect().top - top), before)).toBeLessThan(2)
})

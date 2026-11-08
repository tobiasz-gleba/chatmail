import { expect, test, type Page } from '@playwright/test'
import { earlierMessage, latestMessage, MockApi, owner, personal, work } from './mock-api'

const fixtures = new WeakMap<Page, MockApi>()
const scriptErrors = new WeakMap<Page, string[]>()

test.beforeEach(async ({ page }) => {
  const errors: string[] = []
  scriptErrors.set(page, errors)
  page.on('pageerror', error => errors.push(error.message))
})

test.afterEach(async ({ page }) => {
  expect(fixtures.get(page)?.unexpected ?? []).toEqual([])
  expect(scriptErrors.get(page) ?? []).toEqual([])
})

async function openApp(page: Page, configure?: (api: MockApi) => void) {
  const api = new MockApi()
  configure?.(api)
  fixtures.set(page, api)
  await api.install(page)
  await page.goto('/')
  return api
}

async function connectInbox(page: Page, email: string) {
  await page.getByLabel('Mailbox email', { exact: true }).fill(email)
  await page.getByLabel('Password or app password', { exact: true }).fill('mailbox-app-password')
  await page.getByLabel('IMAP server', { exact: true }).fill('imap.example.com')
  await page.getByLabel('SMTP server', { exact: true }).fill('smtp.example.com')
  await page.getByRole('button', { name: 'Connect inbox', exact: true }).click()
}

async function manageInboxes(page: Page) {
  await page.getByRole('button', { name: owner.email, exact: true }).click()
  await page.getByRole('menuitem', { name: 'Manage inboxes', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Connected inboxes' })).toBeVisible()
}

async function openSam(page: Page) {
  const row = page.getByRole('list', { name: 'Chats', exact: true }).getByRole('button', { name: /Sam Lee/ })
  await expect(row).toBeVisible()
  await row.click()
  await expect(page.getByRole('list', { name: 'Messages', exact: true })).toBeVisible()
  return row
}

async function chooseFrom(page: Page, email: string) {
  await page.getByRole('button', { name: /\bFrom\b/ }).click()
  await page.getByRole('option', { name: email, exact: true }).click()
}

async function expectReplyAccent(page: Page, color: string) {
  const subject = page.locator('.composer-topic strong')
  await expect.poll(() => subject.evaluate(label => getComputedStyle(label, '::before').backgroundColor)).toBe(color)
  await expect(page.locator('.composer-quote')).toHaveCSS('border-inline-start-color', color)
}

test('email and one-time-code sign-in supports correction and resend', async ({ page }) => {
  await page.clock.install()
  const api = await openApp(page, state => { state.user = null; state.inboxes = [] })
  await page.getByLabel('Email address', { exact: true }).fill(owner.email)
  await page.getByRole('button', { name: 'Send code', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Resend in 60s', exact: true })).toBeDisabled()
  const code = page.locator('input[autocomplete="one-time-code"]')
  await code.fill('000000')
  await code.press('Enter')
  await expect(page.getByRole('alert')).toHaveText('This code is incorrect or has expired.')
  await expect(code).toBeFocused()
  await page.clock.fastForward(61_000)
  await page.getByRole('button', { name: 'Resend code', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('A new code is on its way.')
  await code.fill('123456')
  await page.getByRole('button', { name: 'Verify code', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Connect your inbox' })).toBeVisible()
  expect(api.requests.filter(request => request.path === '/api/auth/code')).toHaveLength(2)
  expect(api.user?.email).toBe(owner.email)
})

for (const failed of ['IMAP', 'SMTP'] as const) {
  test(`first inbox corrects an ${failed} failure without losing entered settings`, async ({ page }) => {
    const api = await openApp(page, state => {
      state.inboxes = []
      state.chats = []
      state.nextInboxFailure = `${failed}_CONNECTION_FAILED`
    })
    await connectInbox(page, personal.email)
    await expect(page.getByRole('alert')).toHaveText(failed === 'IMAP'
      ? 'The incoming server could not be reached.' : 'The outgoing server rejected these credentials.')
    await expect(page.getByLabel('Mailbox email', { exact: true })).toHaveValue(personal.email)
    await expect(page.getByLabel('Password or app password', { exact: true })).toHaveValue('mailbox-app-password')
    await expect(page.getByRole('heading', { name: failed === 'IMAP' ? 'Incoming mail IMAP' : 'Outgoing mail SMTP' })).toBeFocused()
    await page.getByLabel(`${failed} server`, { exact: true }).fill('mail.correct.example')
    await page.getByRole('button', { name: 'Connect inbox', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Chats', exact: true })).toBeVisible()
    expect(api.inboxes).toHaveLength(1)
    expect(api.inboxes[0][failed.toLowerCase() as 'imap' | 'smtp'].host).toBe('mail.correct.example')
    expect(api.inboxes[0]).not.toHaveProperty('password')
  })
}

test('a signed-in user can connect a second inbox with separate SMTP credentials', async ({ page }) => {
  const api = await openApp(page, state => { state.inboxes = [personal] })
  await manageInboxes(page)
  await page.getByRole('button', { name: 'Add inbox', exact: true }).click()
  await page.getByLabel('Mailbox email', { exact: true }).fill(work.email)
  await page.getByLabel('Password or app password', { exact: true }).fill('work-imap-password')
  await page.getByLabel('IMAP server', { exact: true }).fill('imap.work.example')
  await page.getByLabel('SMTP server', { exact: true }).fill('smtp.work.example')
  await page.getByRole('button', { name: 'Use different SMTP credentials', exact: true }).click()
  await page.getByLabel('SMTP username', { exact: true }).fill('smtp-user')
  await page.getByLabel('SMTP password', { exact: true }).fill('work-smtp-password')
  await page.getByRole('button', { name: 'Connect inbox', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Connected inboxes' })).toBeVisible()
  await expect(page.getByText(work.email, { exact: true })).toBeVisible()
  const added = api.requests.find(request => request.path === '/api/inboxes' && request.method === 'POST')
  expect(added?.body).toMatchObject({
    email: work.email, password: 'work-imap-password', smtpPassword: 'work-smtp-password',
    separateSmtpCredentials: true, smtp: { username: 'smtp-user' },
  })
  expect(api.inboxes).toHaveLength(2)
})

test('replying to an earlier topic keeps its target when sending from a different inbox', async ({ page }) => {
  const api = await openApp(page)
  const release = api.holdSend()
  await openSam(page)
  const icons = page.locator('.message-topic svg')
  await expect(icons).toHaveCount(2)
  const colors = await icons.evaluateAll(elements => elements.map(icon => getComputedStyle(icon).color))
  expect(new Set(colors).size).toBe(2)
  const oldMessage = page.getByRole('list', { name: 'Messages', exact: true }).getByRole('listitem')
    .filter({ hasText: earlierMessage.body })
  await oldMessage.getByRole('button', { name: 'Reply', exact: true }).click()
  const composer = page.getByRole('form', { name: 'Reply composer', exact: true })
  await expect(composer.getByText(earlierMessage.subject, { exact: true })).toBeVisible()
  await expect(composer.locator('blockquote')).toContainText(earlierMessage.body)
  await expectReplyAccent(page, colors[0])
  await chooseFrom(page, work.email)
  await expectReplyAccent(page, colors[0])
  await page.getByRole('textbox', { name: 'Reply', exact: true }).fill('The budget is ready for review.')
  await composer.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => api.sends.length).toBe(1)
  await expect(composer.getByRole('button', { name: /\bFrom\b/ })).toBeDisabled()
  await expect(page.getByRole('textbox', { name: 'Reply', exact: true })).toBeDisabled()
  expect(api.sends[0]).toMatchObject({
    inboxId: work.id, replyToId: earlierMessage.id, body: 'The budget is ready for review.',
  })
  release()
  await expect(page.getByRole('textbox', { name: 'Reply', exact: true })).toHaveValue('')
  expect(api.sends).toHaveLength(1)
})

test('a draft reply stays attached to its original message when newer mail arrives', async ({ page }) => {
  await page.clock.install()
  const api = await openApp(page)
  const row = await openSam(page)
  const reply = page.getByRole('textbox', { name: 'Reply', exact: true })
  await expect(page.getByText(latestMessage.body, { exact: true })).toBeVisible()
  const originalIcon = page.locator('.message-topic').filter({ hasText: latestMessage.subject }).locator('svg')
  const originalColor = await originalIcon.evaluate(icon => getComputedStyle(icon).color)
  await reply.fill('Sunday works for me.')
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0)
  const incoming = {
    ...latestMessage, id: 'opaque-new-arrival', key: 'message-new-arrival', topicId: 'topic-travel',
    subject: 'Travel dates', body: 'Do these travel dates work?', sentAt: '2026-11-08T11:00:00.000Z',
  }
  const updatedReplyId = 'updated-locator-for-original-message'
  api.messages = [incoming, ...api.messages.map(message =>
    message.key === latestMessage.key ? { ...message, id: updatedReplyId } : message)]
  api.chats = api.chats.map(chat => ({ ...chat, subject: incoming.subject, latestAt: incoming.sentAt }))
  await page.clock.fastForward(10_000)
  await expect(row).toContainText(incoming.subject)
  await expect(page.getByText(incoming.body, { exact: true })).toBeVisible()
  await expect(reply).toBeFocused()
  await expect(reply).toHaveValue('Sunday works for me.')
  const composer = page.getByRole('form', { name: 'Reply composer', exact: true })
  await expect(composer.getByText(latestMessage.subject, { exact: true })).toBeVisible()
  await expect(originalIcon).toHaveCSS('color', originalColor)
  await expect.poll(() => composer.locator('.composer-topic strong').evaluate(label => getComputedStyle(label, '::before').backgroundColor)).toBe(originalColor)
  const inboxChecks = () => api.requests.filter(request => request.path === '/api/mail/chats').length
  const beforeSend = inboxChecks()
  await composer.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => api.sends.length).toBe(1)
  expect(api.sends[0]).toMatchObject({ inboxId: personal.id, replyToId: updatedReplyId, body: 'Sunday works for me.' })
  await expect.poll(inboxChecks).toBeGreaterThan(beforeSend)
})

test('older mail that joins two topics updates the quoted reply accent', async ({ page }) => {
  await openApp(page, api => {
    const time = Date.parse(latestMessage.sentAt)
    api.messages = Array.from({ length: 21 }, (_, index) => ({
      ...latestMessage, id: `mail-${index}`, key: `message-${index}`, subject: '', body: `Note ${index}`,
      // Note 0 originally knows only its parent. The last page connects that parent to the root.
      topicId: index === 0 ? 'message-20' : 'root',
      sentAt: new Date(time - index * 60_000).toISOString(),
    }))
  })
  await openSam(page)
  const topics = page.locator('.message-topic')
  await expect(topics).toHaveText(['(No subject)', '(No subject)'])
  const before = await topics.locator('svg').evaluateAll(icons => icons.map(icon => getComputedStyle(icon).color))
  expect(new Set(before).size).toBe(2)
  const note = page.getByRole('listitem').filter({ has: page.getByText('Note 0', { exact: true }) })
  await note.getByRole('button', { name: 'Reply', exact: true }).click()
  await expectReplyAccent(page, before[1])
  await page.getByRole('region', { name: 'Conversation history' }).evaluate(region => { region.scrollTop = 0 })
  await expect(topics).toHaveText(['(No subject)'])
  await expect(page.locator('.composer-quote blockquote')).toHaveText('Note 0')
  await expectReplyAccent(page, await topics.locator('svg').evaluate(icon => getComputedStyle(icon).color))
})

test('a slow inbox check finishes before the next ten-second wait starts', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-08T12:00:00Z') })
  await page.clock.pauseAt(new Date('2026-11-08T12:01:00Z'))
  const api = await openApp(page)
  const row = page.getByRole('button', { name: /Sam Lee/ })
  await expect(row).toContainText(latestMessage.subject)
  const checks = () => api.requests.filter(request => request.path === '/api/mail/chats').length
  const initial = checks()
  const release = api.holdChats()
  await page.clock.fastForward(10_000)
  await expect.poll(checks).toBe(initial + 1)

  await page.clock.fastForward(30_000)
  await page.clock.fastForward(3_000)
  await expect(row).toContainText(latestMessage.subject)
  await expect(page.getByText(/Opening your inboxes…|Loading more chats…/)).toHaveCount(0)
  expect(checks()).toBe(initial + 1)

  api.chats = api.chats.map(chat => ({ ...chat, subject: 'Delayed update' }))
  release()
  await expect(row).toContainText('Delayed update')
  await page.clock.fastForward(9_999)
  expect(checks()).toBe(initial + 1)
  await page.clock.fastForward(1)
  await expect.poll(checks).toBe(initial + 2)
})

test('a hidden tab checks the selected inbox once when it becomes visible', async ({ page }) => {
  await page.clock.install()
  const api = await openApp(page)
  const row = page.getByRole('button', { name: /Sam Lee/ })
  await expect(row).toBeVisible()
  await page.getByRole('button', { name: /All inboxes/ }).click()
  await page.getByRole('option', { name: work.email, exact: true }).click()
  const checks = () => api.requests.filter(request => request.path === '/api/mail/chats')
  await expect.poll(() => checks().at(-1)?.body.inboxId).toBe(work.id)
  await expect(row).toBeVisible()
  const initial = checks().length
  const setVisibility = (hidden: boolean) => page.evaluate(hidden => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: hidden })
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: hidden ? 'hidden' : 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  }, hidden)

  await setVisibility(true)
  api.chats = api.chats.map(chat => ({ ...chat, subject: 'While you were away' }))
  await page.clock.fastForward(35_000)
  await expect(row).toContainText(latestMessage.subject)
  expect(checks()).toHaveLength(initial)

  await setVisibility(false)
  await expect(row).toContainText('While you were away')
  await page.clock.fastForward(8_000)
  expect(checks().slice(initial).map(request => request.body.inboxId)).toEqual([work.id])
  await page.clock.fastForward(2_000)
  await expect.poll(() => checks().slice(initial).map(request => request.body.inboxId)).toEqual([work.id, work.id])
})

test('a new message sends from the selected inbox with explicit recipients and subject', async ({ page }) => {
  const api = await openApp(page)
  await page.getByRole('button', { name: 'New message', exact: true }).click()
  const composer = page.getByRole('form', { name: 'New message', exact: true })
  await chooseFrom(page, work.email)
  await composer.getByRole('textbox', { name: 'To', exact: true }).fill('sam@example.com, ada@example.com')
  await composer.getByRole('textbox', { name: 'Subject', exact: true }).fill('Project update')
  await composer.getByRole('textbox', { name: 'Message', exact: true }).fill('The first release is ready.')
  await composer.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => api.sends.length).toBe(1)
  expect(api.sends[0]).toMatchObject({
    inboxId: work.id, to: ['sam@example.com', 'ada@example.com'], subject: 'Project update', body: 'The first release is ready.',
  })
  expect(api.sends[0]).not.toHaveProperty('replyToId')
  await expect(page.getByRole('status').filter({ hasText: /^Message sent\.$/ })).toBeVisible()
})

test('an unconfirmed send checks Sent without automatically sending a duplicate', async ({ page }) => {
  const api = await openApp(page, state => { state.sendResult = { status: 'unconfirmed' } })
  await openSam(page)
  await page.getByRole('textbox', { name: 'Reply', exact: true }).fill('Please confirm the meeting.')
  const composer = page.getByRole('form', { name: 'Reply composer', exact: true })
  await composer.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(composer.getByRole('status')).toHaveText('Send unconfirmed. Check Sent before trying again.')
  await expect(page.getByRole('textbox', { name: 'Reply', exact: true })).toBeDisabled()
  await expect(composer.getByRole('button', { name: 'Send again', exact: true })).toHaveCount(0)
  await composer.getByRole('button', { name: 'Check Sent', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Reply', exact: true })).toHaveValue('')
  expect(api.sends).toHaveLength(1)
  expect(api.requests.filter(request => request.path === '/api/mail/send/status').map(request => request.body))
    .toEqual([{ submissionId: api.sends[0].submissionId, inboxId: personal.id }])
})

test('an unavailable inbox keeps other conversations usable and can be retried', async ({ page }) => {
  const api = await openApp(page, state => {
    state.failures = [{ inboxId: work.id, message: 'The work inbox is temporarily unavailable.' }]
  })
  await expect(page.getByText('The work inbox is temporarily unavailable.', { exact: true }).first()).toBeVisible()
  await openSam(page)
  await expect(page.getByText(latestMessage.body, { exact: true })).toBeVisible()
  api.failures = []
  await page.getByRole('button', { name: `Retry ${work.email}`, exact: true }).first().click()
  await expect(page.getByText('The work inbox is temporarily unavailable.', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('list', { name: 'Chats', exact: true }).getByRole('button', { name: /Sam Lee/ })).toBeVisible()
})

test('mobile back navigation returns keyboard focus to each pane’s opener', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openApp(page)
  const row = page.getByRole('list', { name: 'Chats', exact: true }).getByRole('button', { name: /Sam Lee/ })
  await row.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('list', { name: 'Messages', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Sam Lee', exact: true })).toBeFocused()
  const back = page.getByRole('button', { name: /Back to (chats|inbox)/i })
  await back.focus()
  await page.keyboard.press('Enter')
  await expect(row).toBeVisible()
  await expect(row).toBeFocused()
  await expect(page.getByRole('list', { name: 'Messages', exact: true })).toBeHidden()
  const compose = page.getByRole('button', { name: 'New message', exact: true })
  await compose.press('Enter')
  await expect(page.getByRole('heading', { name: 'New message' })).toBeFocused()
  await page.goBack()
  await expect(compose).toBeFocused()
})

test('loading older mail preserves the reading position and marks only visible messages read', async ({ page }) => {
  const api = await openApp(page, state => {
    state.messages = Array.from({ length: 35 }, (_, index) => ({
      ...latestMessage, id: `read-${index}`, key: `message-${index}`, body: `Update number ${index}`,
      sentAt: new Date(Date.parse(latestMessage.sentAt) - index * 60_000).toISOString(),
    }))
  })
  const history = page.getByRole('region', { name: 'Conversation history' })
  await page.route('**/api/mail/messages', async route => {
    const { cursor } = route.request().postDataJSON()
    const start = Number(cursor ?? 0)
    const end = start === 0 ? 20 : start === 20 ? 27 : api.messages.length
    // The final server response arrives after the first batch is on screen.
    if (start === 27) await history.getByText('Update number 26', { exact: true }).waitFor({ state: 'attached' })
    await route.fulfill({ json: {
      messages: api.messages.slice(start, end), cursor: end < api.messages.length ? String(end) : null, failures: [],
    } })
  })
  await openSam(page)
  await expect(history.getByText('Update number 0', { exact: true })).toBeInViewport()
  await page.evaluate(() => document.fonts.ready)
  await expect.poll(() => api.messages[0].unread).toBe(false)
  const anchor = history.getByText('Update number 19', { exact: true })
  await expect(anchor).not.toBeInViewport()
  expect(api.messages[19].unread).toBe(true)
  const anchorTop = await anchor.evaluate(element => {
    const region = element.closest('[role="region"]')!
    region.scrollTop = 0
    return element.getBoundingClientRect().top
  })
  await expect(history.getByText('Update number 34', { exact: true })).toBeAttached()
  await expect.poll(() => anchor.evaluate((element, previousTop) =>
    Math.abs(element.getBoundingClientRect().top - previousTop), anchorTop)).toBeLessThan(2)
  await expect.poll(() => api.messages[19].unread).toBe(false)
  expect(api.messages[34].unread).toBe(true)
})

test('long addresses and subjects keep timestamps and Send in view on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  const address = 'international-project-coordination@correspondence.example.com'
  const subject = 'Quarterly planning and outstanding delivery milestones for international customers'
  await openApp(page, state => {
    state.inboxes = [{ ...personal, email: address }]
    const participant = { name: 'Sam Lee, international project coordination and operations', email: address.replace('coordination', 'operations') }
    state.chats = [{ ...state.chats[0], participants: [participant], subject }]
    state.messages = [{ ...latestMessage, from: participant, subject, body: 'Hello!\n\n' + 'Long reference '.repeat(30) }]
  })
  const row = page.getByRole('list', { name: 'Chats' }).getByRole('button', { name: /Sam Lee/ })
  await expect(row.locator('time')).toBeInViewport({ ratio: 1 })
  await row.click()
  const reply = page.getByRole('textbox', { name: 'Reply', exact: true })
  await reply.fill('First line\nSecond line\nThird line')
  await page.setViewportSize({ width: 320, height: 400 })
  await expect(reply).toBeFocused()
  await expect(reply).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeInViewport({ ratio: 1 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)
})

test('mail, credentials and drafts stay out of browser persistence and drafts clear on reload', async ({ page }) => {
  await openApp(page)
  await openSam(page)
  await page.getByRole('textbox', { name: 'Reply', exact: true }).fill('Private unsent text')
  await expect.poll(async () => page.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    databases: (await indexedDB.databases()).length,
    caches: (await caches.keys()).length,
  }))).toEqual({ local: 0, session: 0, databases: 0, caches: 0 })
  await page.reload()
  await openSam(page)
  await expect(page.getByRole('textbox', { name: 'Reply', exact: true })).toHaveValue('')
  await expect(page.getByText('Private unsent text', { exact: true })).toHaveCount(0)
})

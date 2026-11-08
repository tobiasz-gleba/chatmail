import { expect, test, type Page } from '@playwright/test'
import type { SendResult } from '../../shared/contracts'
import { MockApi, owner } from './mock-api'

async function sendDraft(page: Page, result: SendResult) {
  const mail = new MockApi()
  mail.sendResult = result
  await mail.install(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'New message', exact: true }).click()
  const form = page.getByRole('form', { name: 'New message' })
  await form.getByRole('textbox', { name: 'To', exact: true }).fill('sam@example.com')
  await form.getByRole('textbox', { name: 'Subject' }).fill('Delivery status')
  await form.getByRole('textbox', { name: 'Message' }).fill('Can you confirm the dates?')
  await form.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => mail.sends.length).toBe(1)
  return { mail, form }
}

test('a missing receipt retries the original submission identifier', async ({ page }) => {
  const { mail, form } = await sendDraft(page, { status: 'unconfirmed' })
  const original = mail.sends[0]
  await page.route('**/api/mail/send/status', route => route.fulfill({
    status: 404, json: { error: { code: 'SUBMISSION_NOT_FOUND', message: 'No receipt found.' } },
  }))
  await form.getByRole('button', { name: 'Check Sent' }).click()
  await expect(form.getByRole('button', { name: 'Retry send' })).toBeVisible()
  expect(mail.sends).toHaveLength(1)
  mail.sendResult = { status: 'sent', sentCopy: true }
  await form.getByRole('button', { name: 'Retry send' }).click()
  await expect.poll(() => mail.sends.length).toBe(2)
  expect(original.submissionId).toMatch(/^\d{13}\.[a-f0-9-]{36}$/)
  expect(mail.sends[1]).toEqual(original)
})

test('an expired receipt can be dismissed without sending the draft again', async ({ page }) => {
  const { mail, form } = await sendDraft(page, { status: 'pending' })
  await page.route('**/api/mail/send/status', route => route.fulfill({
    status: 410, json: { error: { code: 'SUBMISSION_EXPIRED', message: 'The receipt expired.' } },
  }))
  await form.getByRole('button', { name: 'Check Sent' }).click()
  await expect(form.getByRole('status')).toContainText('expired')
  await expect(form.getByRole('button', { name: /Retry send|Send again/ })).toHaveCount(0)
  await form.getByRole('button', { name: 'Close draft' }).click()
  await expect(form.getByRole('textbox', { name: 'Message' })).toHaveValue('')
  expect(mail.sends).toHaveLength(1)
})

test('partial SMTP acceptance never offers a blanket resend', async ({ page }) => {
  const { mail, form } = await sendDraft(page, { status: 'unconfirmed', partial: true })
  mail.statusResult = { status: 'unconfirmed', partial: true, checkedSent: true, sentCopy: true }
  await form.getByRole('button', { name: 'Check Sent' }).click()
  await expect(form.getByRole('status')).toContainText('Some recipients')
  await expect(form.getByRole('button', { name: /Send again|Retry send/ })).toHaveCount(0)
  expect(mail.sends).toHaveLength(1)
})

test('an unconfirmed draft can check its original send after managing inboxes', async ({ page }) => {
  const { mail, form } = await sendDraft(page, { status: 'unconfirmed' })
  const original = mail.sends[0]
  await expect(form.getByRole('button', { name: 'Check Sent' })).toBeVisible()
  await page.getByRole('button', { name: owner.email, exact: true }).click()
  await page.getByRole('menuitem', { name: 'Manage inboxes' }).click()
  await page.getByRole('button', { name: 'Back to chats' }).click()
  await page.getByRole('button', { name: 'New message', exact: true }).click()
  await expect(form.getByRole('textbox', { name: 'Message' })).toHaveValue(original.body)
  await form.getByRole('button', { name: 'Check Sent' }).click()
  await expect(page.getByRole('status').filter({ hasText: /^Message sent\.$/ })).toBeVisible()
  expect(mail.sends).toHaveLength(1)
  expect(mail.requests.filter(request => request.path === '/api/mail/send/status').map(request => request.body))
    .toEqual([{ submissionId: original.submissionId, inboxId: original.inboxId }])
})

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { parseEmailFile } = require('../src/email-file')
const { buildMsg } = require('./helpers/msg-fixture')

const SENDER_X500 = '/O=EXCHANGELABS/OU=EXCHANGE ADMINISTRATIVE GROUP (FYDIBOHF23SPDLT)/CN=RECIPIENTS/CN=0123456789ABCDEF-TEST.SENDER'
const RECIPIENT_X500 = '/o=ExchangeLabs/ou=Exchange Administrative Group (FYDIBOHF23SPDLT)/cn=Recipients/cn=fedcba9876543210-test.recipient'

async function parse(t, fields) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brinq-email-file-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'message.msg')
  await fs.writeFile(file, buildMsg(fields))
  return (await parseEmailFile(file)).metadata
}
const addresses = (m) => ({ from: m.from, to: m.to, cc: m.cc, bcc: m.bcc })
const noX500 = (m) => assert.doesNotMatch(JSON.stringify(addresses(m)), /\/o=/i)

test('internal Exchange sender and recipients without SMTP properties show names, never the X.500 address', async t => {
  const m = await parse(t, {
    sender: { name: 'Test Sender', addressType: 'EX', email: SENDER_X500 },
    representing: { name: 'Test Sender', addressType: 'EX', email: SENDER_X500 },
    recipients: [
      { name: 'Test Recipient', addressType: 'EX', email: RECIPIENT_X500 },
      { name: 'Copy Recipient', addressType: 'EX', email: RECIPIENT_X500, type: 'cc' },
    ],
  })
  assert.deepEqual(addresses(m), {
    from: [{ name: 'Test Sender', address: '' }],
    to: [{ name: 'Test Recipient', address: '' }],
    cc: [{ name: 'Copy Recipient', address: '' }],
    bcc: [],
  })
  noX500(m)
})

test('Exchange SMTP properties replace the X.500 address for sender and recipients', async t => {
  const m = await parse(t, {
    sender: { name: 'Test Sender', addressType: 'EX', email: SENDER_X500, smtp: 'sender@example.com' },
    recipients: [{ name: 'Test Recipient', addressType: 'EX', email: RECIPIENT_X500, smtp: 'recipient@example.com' }],
  })
  assert.deepEqual(m.from, [{ name: 'Test Sender', address: 'sender@example.com' }])
  assert.deepEqual(m.to, [{ name: 'Test Recipient', address: 'recipient@example.com' }])
  noX500(m)
})

test('received mail without SMTP properties takes addresses from its transport headers', async t => {
  const m = await parse(t, {
    sender: { name: 'Test Sender', addressType: 'EX', email: SENDER_X500 },
    headers: 'Received: from mail.example.com\r\nFrom: Test Sender <sender@example.com>\r\nTo: Test Recipient <recipient@example.com>\r\nSubject: Fixture subject',
    recipients: [{ name: 'Test Recipient', addressType: 'EX', email: RECIPIENT_X500 }],
  })
  assert.deepEqual(m.from, [{ name: 'Test Sender', address: 'sender@example.com' }])
  assert.deepEqual(m.to, [{ name: 'Test Recipient', address: 'recipient@example.com' }])
})

test('a delegate send shows the represented mailbox and never pairs it with the delegate address', async t => {
  const onBehalf = await parse(t, {
    sender: { name: 'Test Assistant', addressType: 'SMTP', email: 'assistant@example.com', smtp: 'assistant@example.com' },
    representing: { name: 'Test Principal', addressType: 'SMTP', email: 'principal@example.com', smtp: 'principal@example.com' },
  })
  assert.deepEqual(onBehalf.from, [{ name: 'Test Principal', address: 'principal@example.com' }])
  const internalPrincipal = await parse(t, {
    sender: { name: 'Test Assistant', addressType: 'SMTP', email: 'assistant@example.com', smtp: 'assistant@example.com' },
    representing: { name: 'Test Principal', addressType: 'EX', email: SENDER_X500 },
  })
  assert.deepEqual(internalPrincipal.from, [{ name: 'Test Principal', address: '' }])
})

test('external SMTP senders keep their address, and a legacyDN display name is never shown', async t => {
  const m = await parse(t, {
    sender: { name: 'Outside Sender', addressType: 'SMTP', email: 'outside@example.org' },
    recipients: [{ name: RECIPIENT_X500, addressType: 'EX', email: RECIPIENT_X500, smtp: 'SMTP:recipient@example.com' }],
  })
  assert.deepEqual(m.from, [{ name: 'Outside Sender', address: 'outside@example.org' }])
  assert.deepEqual(m.to, [{ name: '', address: 'recipient@example.com' }])
  noX500(m)
})

test('a delegate that shares the mailbox display name never lends its own address', async t => {
  const support = await parse(t, {
    sender: { name: 'Support', addressType: 'SMTP', email: 'delegate@example.com', smtp: 'delegate@example.com' },
    representing: { name: 'Support', addressType: 'EX', email: SENDER_X500 },
  })
  assert.deepEqual(support.from, [{ name: 'Support', address: '' }])
  const unnamedSender = await parse(t, {
    sender: { addressType: 'SMTP', email: 'delegate@example.com', smtp: 'delegate@example.com' },
    representing: { name: 'Shared Mailbox', addressType: 'EX', email: SENDER_X500 },
  })
  assert.deepEqual(unnamedSender.from, [{ name: 'Shared Mailbox', address: '' }])
  // The same mailbox (matching addresses) still uses the sender's SMTP address.
  const self = await parse(t, {
    sender: { name: 'Test Sender', addressType: 'EX', email: SENDER_X500, smtp: 'sender@example.com' },
    representing: { name: 'Test Sender', addressType: 'EX', email: SENDER_X500 },
  })
  assert.deepEqual(self.from, [{ name: 'Test Sender', address: 'sender@example.com' }])
})

test('recipients with the same display name never borrow one another\'s header address', async t => {
  const m = await parse(t, {
    sender: { name: 'Test Sender', addressType: 'SMTP', email: 'sender@example.com' },
    headers: 'From: Test Sender <sender@example.com>\r\nTo: John Smith <john.one@example.com>, John Smith <john.two@example.com>, Unique Person <unique@example.com>',
    recipients: [
      { name: 'John Smith', addressType: 'EX', email: RECIPIENT_X500 },
      { name: 'John Smith', addressType: 'EX', email: RECIPIENT_X500 },
      { name: 'Unique Person', addressType: 'EX', email: RECIPIENT_X500 },
    ],
  })
  assert.deepEqual(m.to, [
    { name: 'John Smith', address: '' },
    { name: 'John Smith', address: '' },
    { name: 'Unique Person', address: 'unique@example.com' },
  ])
})

test('a legacyDN that ends in an address-shaped segment is still not an SMTP address', async t => {
  const m = await parse(t, {
    sender: { name: 'Test Sender', addressType: 'EX', email: '/o=Org/ou=Group/cn=Recipients/cn=user@example.com' },
    recipients: [{ name: 'Test Recipient', addressType: 'EX', email: '/o=Org/cn=Recipients/cn=r@example.com' }],
  })
  assert.deepEqual(m.from, [{ name: 'Test Sender', address: '' }])
  assert.deepEqual(m.to, [{ name: 'Test Recipient', address: '' }])
})

const test = require('node:test')
const assert = require('node:assert/strict')
const { createNativeNotifier, RETAIN_MS } = require('../src/native-notifications')

function harness({ focused = false } = {}) {
  const state = { focused, time: 1_000_000, popups: [], clicks: [] }
  class FakeNotification {
    constructor(options) { this.options = options; this.handlers = {}; this.shown = false }
    on(name, handler) { this.handlers[name] = handler }
    show() { this.shown = true; state.popups.push(this) }
  }
  state.notify = createNativeNotifier({
    Notification: FakeNotification,
    appFocused: () => state.focused,
    onClick: (uid) => state.clicks.push(uid),
    icon: '/icon.png',
    now: () => state.time,
  })
  return state
}

test('two unfocused Brinq tabs reporting the same email show one popup', () => {
  const h = harness()
  assert.equal(h.notify('Sender', 'Subject', { uid: 'email-1' }), 'shown')
  assert.equal(h.notify('Sender', 'Subject', { uid: 'email-1' }), 'duplicate')
  assert.equal(h.popups.length, 1)
  assert.deepEqual(h.popups[0].options, { title: 'Sender', body: 'Subject', icon: '/icon.png' })
  assert.equal(h.popups[0].shown, true)
})

test('different emails each get their own popup', () => {
  const h = harness()
  h.notify('A', 'one', { uid: 'email-1' })
  h.notify('A', 'two', { uid: 'email-2' })
  assert.deepEqual(h.popups.map(p => p.options.body), ['one', 'two'])
})

test('no popup while any Brinq window has focus, and none later when focus moves away', () => {
  const h = harness({ focused: true })
  assert.equal(h.notify('Sender', 'Subject', { uid: 'email-1' }), 'focused')
  assert.equal(h.popups.length, 0)
  h.focused = false
  // Another tab delivering the same event after the user left Brinq.
  assert.equal(h.notify('Sender', 'Subject', { uid: 'email-1' }), 'duplicate')
  assert.equal(h.popups.length, 0)
  // A new email after focus left does pop up.
  assert.equal(h.notify('Sender', 'Later', { uid: 'email-2' }), 'shown')
})

test('clicking a popup opens its email', () => {
  const h = harness()
  h.notify('Sender', 'Subject', { uid: 'email-1' })
  h.popups[0].handlers.click()
  assert.deepEqual(h.clicks, ['email-1'])
})

test('a seen email is forgotten only after the retention window', () => {
  const h = harness()
  h.notify('Sender', 'Subject', { uid: 'email-1' })
  h.time += RETAIN_MS - 1
  assert.equal(h.notify('Sender', 'Subject', { uid: 'email-1' }), 'duplicate')
  h.time += 1
  assert.equal(h.notify('Sender', 'Subject', { uid: 'email-1' }), 'shown')
  assert.equal(RETAIN_MS, 600_000)
})

test('invalid requests never show a popup; a request without a usable uid is not deduplicated', () => {
  const h = harness()
  for (const [title, body] of [[1, 'b'], ['t', null], [undefined, undefined]]) {
    assert.equal(h.notify(title, body, { uid: 'email-1' }), 'invalid')
  }
  assert.equal(h.popups.length, 0)
  // The invalid calls consumed nothing.
  assert.equal(h.notify('Sender', 'Subject', { uid: 'email-1' }), 'shown')
  for (const data of [undefined, null, {}, { uid: '' }, { uid: 7 }, { uid: 'x'.repeat(513) }]) {
    assert.equal(h.notify('Sender', 'Subject', data), 'shown')
  }
  h.popups.at(-1).handlers.click()
  assert.deepEqual(h.clicks, [null])
})

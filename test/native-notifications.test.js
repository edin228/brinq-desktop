const test = require('node:test')
const assert = require('node:assert/strict')
const { createNativeNotifier, SEEN_LIMIT, LIVE_LIMIT, MAX_DELIVERY_AGE_MS } = require('../src/native-notifications')

function harness({ focused = false, ...limits } = {}) {
  const state = { focused, time: 1_000_000, popups: [], clicks: [] }
  class FakeNotification {
    constructor(options) { this.options = options; this.handlers = {}; this.shown = false }
    on(name, handler) { this.handlers[name] = handler }
    show() { this.shown = true; state.popups.push(this) }
    // The OS reports display later, as Electron's 'show' event.
    display() { this.handlers.show?.() }
    close() { this.closed = true }
  }
  state.notify = createNativeNotifier({
    Notification: FakeNotification,
    appFocused: () => state.focused,
    onClick: (uid) => state.clicks.push(uid),
    icon: '/icon.png',
    now: () => state.time,
    ...limits,
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

const DAY = 24 * 60 * 60 * 1000

test('a copy that arrives days later never pops up, whatever the clock does', () => {
  const h = harness({ focused: true })
  assert.equal(h.notify('Sender', 'Subject', { uid: 'email-1' }), 'focused')
  h.focused = false
  // A stalled page delivering after a weekend.
  h.time += 3 * DAY
  assert.equal(h.notify('Sender', 'Subject', { uid: 'email-1' }), 'duplicate')
  // A clock corrected backwards changes nothing either.
  h.time -= 30 * DAY
  assert.equal(h.notify('Sender', 'Subject', { uid: 'email-1' }), 'duplicate')
  assert.equal(h.popups.length, 0)
})

test('seen emails are bounded by count, oldest first, and a clock rollback cannot strand them', () => {
  const h = harness({ seenLimit: 3 })
  for (const uid of ['a', 'b', 'c']) h.notify('S', uid, { uid })
  h.time -= 10 * DAY
  h.notify('S', 'd', { uid: 'd' })
  assert.deepEqual(h.notify.sizes().seen, 3)
  // 'a' was the oldest and is forgotten; the newer ones are still duplicates.
  for (const uid of ['b', 'c', 'd']) assert.equal(h.notify('S', uid, { uid }), 'duplicate')
  assert.equal(h.notify('S', 'a', { uid: 'a' }), 'shown')
  assert.equal(SEEN_LIMIT, 10000)
})

test('a shown popup stays referenced until clicked, dismissed or failed; a timed-out toast stays clickable', () => {
  const h = harness()
  for (const uid of ['a', 'b', 'c', 'd', 'e']) h.notify('Sender', uid, { uid })
  assert.deepEqual(h.notify.sizes(), { seen: 5, live: 5 })
  const [a, b, c, d, e] = h.popups
  a.handlers.click()
  b.handlers.close({ reason: 'userCanceled' })
  c.handlers.failed()
  // Windows: the banner timed out, but the toast waits in the Action Center.
  d.handlers.close({ reason: 'timedOut' })
  e.handlers.close()
  assert.deepEqual(h.notify.sizes(), { seen: 5, live: 1 })
  d.handlers.click()
  assert.deepEqual(h.clicks, ['a', 'd'])
  assert.deepEqual(h.notify.sizes(), { seen: 5, live: 0 })
})

test('beyond the bound the oldest shown popup is dismissed, never left without a click handler', () => {
  const h = harness({ liveLimit: 2 })
  h.notify('Sender', 'a', { uid: 'a' }); h.popups[0].display()
  h.notify('Sender', 'b', { uid: 'b' }); h.popups[1].display()
  h.notify('Sender', 'c', { uid: 'c' }); h.popups[2].display()
  const [a, b, c] = h.popups
  assert.deepEqual([a.closed, b.closed, c.closed], [true, undefined, undefined])
  assert.deepEqual(h.notify.sizes(), { seen: 3, live: 2 })
  // The survivors are still the referenced ones: settling them empties the set.
  b.handlers.click()
  c.handlers.close({ reason: 'userCanceled' })
  assert.deepEqual(h.notify.sizes(), { seen: 3, live: 0 })
  assert.deepEqual(h.clicks, ['b'])
  assert.equal(LIVE_LIMIT, 100)
})

test('a popup still waiting for the OS to show it is never dismissed by the bound', () => {
  const h = harness({ liveLimit: 2 })
  for (const uid of ['a', 'b', 'c']) h.notify('Sender', uid, { uid })
  // A burst: none shown yet, so none is closed and the set runs over.
  assert.deepEqual(h.popups.map(p => p.closed), [undefined, undefined, undefined])
  assert.deepEqual(h.notify.sizes(), { seen: 3, live: 3 })
  // Once shown, the oldest shown one goes; a still-pending older one stays.
  h.popups[1].display()
  assert.deepEqual(h.popups.map(p => p.closed), [undefined, true, undefined])
  assert.deepEqual(h.notify.sizes(), { seen: 3, live: 2 })
  h.popups[0].display()
  h.popups[2].display()
  assert.deepEqual(h.notify.sizes(), { seen: 3, live: 2 })
  // A 'show' after the popup settled changes nothing.
  h.popups[0].handlers.click()
  h.popups[0].display()
  assert.deepEqual(h.notify.sizes(), { seen: 3, live: 1 })
})

test('a copy decided more than a day ago is refused and still counts as seen', () => {
  const h = harness()
  const at = (ms) => new Date(h.time - ms).toISOString()
  assert.equal(h.notify('S', 'old', { uid: 'old', decidedAt: at(MAX_DELIVERY_AGE_MS + 1) }), 'stale')
  assert.equal(h.notify('S', 'old', { uid: 'old' }), 'duplicate')
  assert.equal(h.notify('S', 'recent', { uid: 'recent', decidedAt: at(60 * 1000) }), 'shown')
  // Clock skew putting the decision in the future, or an unreadable time, is not refused.
  assert.equal(h.notify('S', 'skew', { uid: 'skew', decidedAt: at(-60 * 1000) }), 'shown')
  assert.equal(h.notify('S', 'junk', { uid: 'junk', decidedAt: 'yesterday-ish' }), 'shown')
  assert.equal(h.popups.length, 3)
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

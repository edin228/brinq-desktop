const test = require('node:test')
const assert = require('node:assert/strict')
const { visibleBounds, modeUrl, parseProtocolUrl, incomingNavigationUrl, createNavigationQueue } = require('../src/window-state')
const primary = { x: 0, y: 0, width: 1920, height: 1040 }
const left = { x: -1600, y: -200, width: 1600, height: 900 }

test('bounds preserve reachable positions, including monitors with negative coordinates', () => {
  const saved = { x: -1500, y: -100, width: 1200, height: 700 }
  assert.deepEqual(visibleBounds(saved, [primary, left]), saved)
  assert.deepEqual(visibleBounds({ x: 100, y: 50, width: 1200, height: 800 }, [primary]), { x: 100, y: 50, width: 1200, height: 800 })
})
test('removed displays, oversized windows and malformed data restore entirely inside the work area', () => {
  for (const saved of [null, {}, { width: NaN, height: Infinity }, { width: -10, height: 10 }, { width: 0, height: 2 }, { width: 9000, height: 8000, x: -2000, y: -2000 }, { width: 1200, height: 800, x: 5000, y: 3000 }, { width: 1200, height: 800, x: '40', y: 0 }]) {
    const bounds = visibleBounds(saved, [primary])
    assert.ok(bounds.x >= 0 && bounds.y >= 0)
    assert.ok(bounds.x + bounds.width <= primary.width)
    assert.ok(bounds.y + bounds.height <= primary.height)
  }
  assert.deepEqual(visibleBounds(null, [{ x: 0, y: 0, width: 800, height: 600 }]), { x: 0, y: 0, width: 800, height: 600 })
})
test('mode and incoming URLs preserve mode, wait at login and route dashboard actions to emails', () => {
  const base = 'https://brinq.io'
  assert.equal(modeUrl(base, 'full'), `${base}/dashboard?standalone=full`)
  assert.equal(modeUrl(base, 'email'), `${base}/emails?standalone=email`)
  for (const mode of ['email', 'full']) {
    assert.equal(incomingNavigationUrl(`${base}/dashboard`, base, mode), `${base}/emails?standalone=${mode}`)
    for (const route of ['login', 'emails']) assert.equal(incomingNavigationUrl(`${base}/${route}`, base, mode), null)
  }
})
test('malformed protocols fail safely and Brinq activation never selects a supplied path', () => {
  for (const value of ['mailto:%ZZ', 'brinq://[', 'https://example.com', 'file:///etc/passwd', null]) assert.equal(parseProtocolUrl(value), null)
  assert.deepEqual(parseProtocolUrl('brinq://https://example.com/private'), { type: 'activate' })
  assert.deepEqual(parseProtocolUrl('mailto:a%40example.com,b@example.com?subject=Hello&body=Line%201%0ALine%202&cc=c@example.com'), { type: 'mailto', data: { to: ['a@example.com', 'b@example.com'], subject: 'Hello', body: 'Line 1\nLine 2', cc: ['c@example.com'] } })
})
test('pending actions wait for their channel and current document, survive reload/login, and drain once', () => {
  const queue = createNavigationQueue()
  const first = {}; const reloaded = {}; const sent = []
  const send = (...args) => sent.push(args)
  queue.push('mailto', { subject: 'before login' })
  queue.push('navigate-email', 'message')
  queue.drain(first, send)
  assert.deepEqual(sent, [])
  queue.subscribe('mailto', first, true)
  queue.reset()
  queue.drain(reloaded, send)
  queue.subscribe('navigate-email', reloaded, true)
  queue.drain(reloaded, send)
  assert.deepEqual(sent, [['navigate-email', 'message']])
  queue.subscribe('mailto', reloaded, true)
  queue.drain(reloaded, send)
  queue.drain(reloaded, send)
  assert.equal(sent.length, 2)
  assert.equal(queue.hasPending(), false)
  queue.subscribe('mailto', first, false) // stale removal cannot clear the current frame
  queue.push('mailto', { subject: 'current document' })
  queue.drain(reloaded, send)
  assert.equal(sent.length, 3)
  queue.subscribe('mailto', reloaded, false)
  queue.push('mailto', { subject: 'unmounted' })
  queue.drain(reloaded, send)
  assert.equal(sent.length, 3)
})


test('failed mode navigation retains the saved choice and successful navigation commits it', async () => {
  // Exercise the actual main-process transition with controllable navigation.
  const fs = require('node:fs')
  const vm = require('node:vm')
  const source = fs.readFileSync(require.resolve('../src/main'), 'utf8')
  const transition = source.slice(source.indexOf('function desktopState()'), source.indexOf('// IPC handlers'))
  let mode = 'email'
  let fail = true
  let resolveNavigation
  let trayUpdates = 0
  const targets = []
  const context = {
    isMode: require('../src/window-state').isMode,
    modeUrl,
    BASE_URL: 'https://brinq.io',
    config: { getMode: () => mode, setMode: (value) => { mode = value } },
    app: { getVersion: () => '1.2.5' },
    updateTrayMenu: () => { trayUpdates++ },
    mainWindow: { loadURL: (url) => {
      targets.push(url)
      if (fail) return Promise.reject(new Error('Navigation failed'))
      return new Promise((resolve) => { resolveNavigation = resolve })
    } },
  }
  vm.createContext(context)
  vm.runInContext(transition, context)
  const failed = await context.switchMode('full')
  assert.equal(failed.ok, false)
  assert.equal(failed.state.mode, 'email')
  assert.equal(mode, 'email')
  assert.equal(trayUpdates, 0)
  assert.deepEqual(targets, ['https://brinq.io/dashboard?standalone=full'])
  fail = false
  const pending = context.switchMode('full')
  assert.equal(mode, 'email')
  resolveNavigation()
  const success = await pending
  assert.equal(success.ok, true)
  assert.equal(success.state.mode, 'full')
  assert.equal(mode, 'full')
  assert.equal(trayUpdates, 1)
})

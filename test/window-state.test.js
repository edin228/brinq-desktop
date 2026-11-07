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
test('only an exact browser sign-in callback carries its code and state', () => {
  const code = 'c'.repeat(43)
  const state = 's'.repeat(43)
  const callback = { type: 'browser-sign-in', data: { code, state } }
  assert.deepEqual(parseProtocolUrl(`brinq://sign-in?code=${code}&state=${state}`), callback)
  // Some browsers add a slash after the host of a custom scheme.
  assert.deepEqual(parseProtocolUrl(`brinq://sign-in/?state=${state}&code=${code}`), callback)
  for (const value of [
    `brinq://sign-in?code=${code}`,
    `brinq://sign-in?code=${code}&state=${state}&next=https://evil.test`,
    `brinq://sign-in?code=${code}&code=${code}&state=${state}`,
    `brinq://sign-in?code=${code.slice(1)}&state=${state}`,
    `brinq://sign-in?code=${code}!&state=${state}`,
    `brinq://sign-in/extra?code=${code}&state=${state}`,
    `brinq://sign-in:8080?code=${code}&state=${state}`,
    `brinq://user:pass@sign-in?code=${code}&state=${state}`,
    `brinq://sign-in?code=${code}&state=${state}#x`,
    `brinq://other?code=${code}&state=${state}`,
  ]) assert.deepEqual(parseProtocolUrl(value), { type: 'activate' }, value)
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
  queue.navigationStarted()
  queue.navigationCommitted()
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


test('destination sees selected Desktop mode during load, with rollback on failure and guarded overlapping changes', async () => {
  // Exercise the main-process state getter as a mounting destination would.
  const fs = require('node:fs')
  const vm = require('node:vm')
  const source = fs.readFileSync(require.resolve('../src/main'), 'utf8')
  const transition = source.slice(source.indexOf('function desktopState()'), source.indexOf('// IPC handlers'))
  let mode = 'email'
  let resolveNavigation
  let rejectNavigation
  const trayModes = []
  const destinationModes = []
  const targets = []
  let homeSelections = 0
  const context = {
    isMode: require('../src/window-state').isMode,
    modeUrl,
    BASE_URL: 'https://brinq.io',
    config: { getMode: () => mode, setMode: (value) => { mode = value }, getStartup: () => ({ choice: 'home', pages: [] }) },
    app: { getVersion: () => '1.2.5' },
    updateTrayMenu: () => { trayModes.push(mode) },
    // Mode changes load Home, the main window's permanent base tab, and show it.
    tabWindow: { selectHome: () => { homeSelections++ } },
    homeContents: () => ({ loadURL: (url) => {
      targets.push(url)
      destinationModes.push(context.desktopState().mode)
      return new Promise((resolve, reject) => { resolveNavigation = resolve; rejectNavigation = reject })
    } }),
  }
  vm.createContext(context)
  vm.runInContext(transition, context)
  const failedNavigation = context.switchMode('full')
  assert.equal(context.desktopState().mode, 'full')
  assert.deepEqual(destinationModes, ['full'])
  assert.equal((await context.switchMode('email')).ok, false)
  assert.equal(targets.length, 1)
  rejectNavigation(new Error('Navigation failed'))
  const failed = await failedNavigation
  assert.equal(failed.ok, false)
  assert.equal(failed.state.mode, 'email')
  assert.equal(context.desktopState().mode, 'email')
  assert.deepEqual(trayModes, ['full', 'email'])
  assert.deepEqual(targets, ['https://brinq.io/dashboard?standalone=full'])
  const pending = context.switchMode('full')
  assert.equal(context.desktopState().mode, 'full')
  resolveNavigation()
  const success = await pending
  assert.equal(success.ok, true)
  assert.equal(success.state.mode, 'full')
  assert.equal(mode, 'full')
  assert.deepEqual(trayModes, ['full', 'email', 'full'])
  const mailMode = context.switchMode('email')
  assert.equal(context.desktopState().mode, 'email')
  assert.deepEqual(destinationModes, ['full', 'full', 'email'])
  resolveNavigation()
  assert.equal((await mailMode).state.mode, 'email')
  assert.equal(homeSelections, 3)
})

test('a link that never navigates keeps Home listening, and delivers each payload once', () => {
  // Electron 44.4.5: a mailto:, tel: or download link starts a main-frame
  // navigation that ends with did-stop-loading and no commit; the page stays.
  const queue = createNavigationQueue()
  const page = {}; const sent = []
  const send = (...args) => sent.push(args)
  queue.subscribe('mailto', page, true)
  queue.subscribe('navigate-email', page, true)
  queue.navigationStarted()
  queue.push('navigate-email', 'during')
  queue.drain(page, send)
  assert.deepEqual(sent, [], 'nothing is delivered while a navigation is pending')
  assert.equal(queue.navigationEnded(), true)
  queue.push('mailto', { subject: 'after' })
  queue.drain(page, send)
  queue.drain(page, send)
  assert.deepEqual(sent, [['navigate-email', 'during'], ['mailto', { subject: 'after' }]])
  assert.equal(queue.navigationEnded(), false, 'no navigation is left in progress')
  // A committed navigation replaced the page: its listeners must subscribe again.
  queue.navigationStarted()
  queue.navigationCommitted()
  queue.push('mailto', { subject: 'next page' })
  queue.drain(page, send)
  assert.equal(sent.length, 2)
  const next = {}
  queue.subscribe('mailto', next, true)
  queue.drain(next, send)
  assert.deepEqual(sent.at(-1), ['mailto', { subject: 'next page' }])
  assert.equal(queue.hasPending(), false)
})

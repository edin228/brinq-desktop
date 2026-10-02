const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const { createBrowserSignIn, installBrowserSignIn, REQUEST_LIFETIME_MS } = require('../src/browser-sign-in')
const { createWindowSecurity } = require('../src/window-security')

const BASE = 'https://brinq.io'
const CODE = 'c'.repeat(43)

function signInFixture({ openExternal } = {}) {
  let clock = 1_000
  let seed = 0
  const opened = []
  const signIn = createBrowserSignIn({
    baseUrl: BASE,
    openExternal: openExternal || (async (url) => { opened.push(url) }),
    now: () => clock,
    randomBytes: (size) => Buffer.alloc(size, ++seed),
  })
  const sent = () => new URL(opened.at(-1)).searchParams
  return { signIn, opened, sent, advance: (ms) => { clock += ms } }
}

test('start opens brinq.io with only an S256 challenge and state; the verifier stays local', async () => {
  const f = signInFixture()
  const started = await f.signIn.start()
  assert.deepEqual(started, { ok: true, expiresAt: 1_000 + REQUEST_LIFETIME_MS })
  const url = new URL(f.opened[0])
  assert.equal(`${url.origin}${url.pathname}`, `${BASE}/desktop-sign-in`)
  assert.deepEqual([...url.searchParams.keys()].sort(), ['challenge', 'state'])
  assert.ok(f.signIn.receive({ code: CODE, state: f.sent().get('state') }))
  const { code, verifier } = f.signIn.take()
  assert.equal(code, CODE)
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url'), url.searchParams.get('challenge'))
  assert.ok(!f.opened[0].includes(verifier))
})

test('S256 matches the RFC 7636 Appendix B example', async () => {
  const verifierBytes = Buffer.from([116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173,
    187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121])
  const opened = []
  const signIn = createBrowserSignIn({ baseUrl: BASE, openExternal: async (url) => { opened.push(url) }, randomBytes: () => verifierBytes })
  await signIn.start()
  assert.equal(new URL(opened[0]).searchParams.get('challenge'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
})

test('retries reuse the pending request, and double clicks open the browser once', async () => {
  const f = signInFixture()
  const [first, second] = await Promise.all([f.signIn.start(), f.signIn.start()])
  assert.deepEqual(first, second)
  assert.equal(f.opened.length, 1)
  await f.signIn.start()
  assert.equal(f.opened.length, 2)
  assert.equal(new URL(f.opened[0]).search, new URL(f.opened[1]).search)
  f.advance(REQUEST_LIFETIME_MS)
  await f.signIn.start()
  assert.notEqual(new URL(f.opened[2]).search, new URL(f.opened[0]).search)
})

test('unknown, stale and duplicate callbacks are ignored without disturbing the pending request', async () => {
  const f = signInFixture()
  assert.equal(f.signIn.receive({ code: CODE, state: 's'.repeat(43) }), false)
  await f.signIn.start()
  const state = f.sent().get('state')
  assert.equal(f.signIn.receive({ code: CODE, state: 'x'.repeat(43) }), false)
  assert.equal(f.signIn.receive({ code: CODE, state }), true)
  assert.equal(f.signIn.receive({ code: 'd'.repeat(43), state }), false)
  assert.equal(f.signIn.take().code, CODE)
  assert.equal(f.signIn.take(), null)
})

test('expired requests and expired results report expiry instead of disclosing the verifier', async () => {
  const f = signInFixture()
  await f.signIn.start()
  f.advance(REQUEST_LIFETIME_MS)
  assert.equal(f.signIn.receive({ code: CODE, state: f.sent().get('state') }), true)
  assert.deepEqual(f.signIn.take(), { error: 'expired' })

  await f.signIn.start()
  f.signIn.receive({ code: CODE, state: f.sent().get('state') })
  f.advance(REQUEST_LIFETIME_MS)
  assert.deepEqual(f.signIn.take(), { error: 'expired' })
})

test('cancel clears both the pending request and any stored result', async () => {
  const f = signInFixture()
  await f.signIn.start()
  const state = f.sent().get('state')
  f.signIn.cancel()
  assert.equal(f.signIn.receive({ code: CODE, state }), false)
  await f.signIn.start()
  f.signIn.receive({ code: CODE, state: f.sent().get('state') })
  f.signIn.cancel()
  assert.equal(f.signIn.take(), null)
})

test('browser open failures and cancellation during opening are reported plainly', async () => {
  const failing = signInFixture({ openExternal: async () => { throw new Error('C:\\private\\path') } })
  const failed = await failing.signIn.start()
  assert.equal(failed.ok, false)
  assert.doesNotMatch(failed.error, /private/)

  let release
  const slow = signInFixture({ openExternal: () => new Promise((done) => { release = done }) })
  const starting = slow.signIn.start()
  await Promise.resolve()
  slow.signIn.cancel()
  release()
  assert.deepEqual(await starting, { ok: false, error: 'This sign-in was cancelled.' })
})

// Real window security with fake live windows, so sender checks are the real ones.
function appFixture() {
  const security = createWindowSecurity({ baseUrl: BASE, preloadPath: '/preload.js', openExternal: () => {} })
  const session = { setPermissionCheckHandler() {}, setPermissionRequestHandler() {} }
  const handlers = new Map()
  const opened = []
  const loads = []
  let selected = 0
  function page(url, role = 'main') {
    const wc = new EventEmitter()
    Object.assign(wc, {
      mainFrame: { url, origin: new URL(url).origin, parent: null, detached: false },
      session, isDestroyed: () => false, getURL: () => wc.mainFrame.url,
      setWindowOpenHandler() {},
      loadURL: async (target) => { loads.push(target) },
    })
    const owner = new EventEmitter()
    owner.isDestroyed = () => false
    security.register(wc, role, url, owner)
    return wc
  }
  const home = page(`${BASE}/login`)
  const browserSignIn = installBrowserSignIn({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    security,
    homeContents: () => home,
    selectHome: () => { selected++ },
    baseUrl: BASE,
    openExternal: async (url) => { opened.push(url) },
  })
  browserSignIn.watchHome(home)
  const call = (channel, wc = home, frame = wc.mainFrame) => handlers.get(channel)({ sender: wc, senderFrame: frame })
  const navigate = (wc, url) => {
    wc.mainFrame.url = url
    wc.emit('did-frame-navigate', {}, url, 200, 'OK', true)
  }
  const state = () => new URL(opened.at(-1)).searchParams.get('state')
  return { home, page, call, navigate, browserSignIn, opened, loads, state, get selected() { return selected } }
}

test('a matching callback reloads Home login for completion, and only Home login can take the result', async () => {
  const f = appFixture()
  assert.equal((await f.call('browser-sign-in-start')).ok, true)
  assert.equal(f.browserSignIn.receive({ code: CODE, state: f.state() }), true)
  assert.deepEqual(f.loads, [`${BASE}/login?desktopSignIn=complete`])
  assert.equal(f.selected, 1)
  f.navigate(f.home, `${BASE}/login?desktopSignIn=complete`)

  const tab = f.page(`${BASE}/login`, 'app')
  assert.equal(await f.call('browser-sign-in-take', tab), null)
  assert.equal(await f.call('browser-sign-in-take', f.home, { ...f.home.mainFrame, parent: f.home.mainFrame }), null)
  assert.equal((await f.call('browser-sign-in-take')).code, CODE)
  assert.equal(await f.call('browser-sign-in-take'), null)
})

test('non-Home, non-login, foreign and navigating senders get no browser sign-in authority', async () => {
  const f = appFixture()
  const tab = f.page(`${BASE}/login`, 'app')
  assert.deepEqual(await f.call('browser-sign-in-start', tab), { ok: false, error: 'Unauthorized sender.' })
  f.navigate(f.home, `${BASE}/dashboard`)
  assert.deepEqual(await f.call('browser-sign-in-start'), { ok: false, error: 'Unauthorized sender.' })
  f.navigate(f.home, `${BASE}/login`)
  f.home.emit('did-start-navigation', {}, `${BASE}/login`, false, true)
  assert.deepEqual(await f.call('browser-sign-in-start'), { ok: false, error: 'Unauthorized sender.' })
  assert.equal(f.opened.length, 0)
})

test('a page that changes while the browser opens never receives the start result', async () => {
  const f = appFixture()
  const starting = f.call('browser-sign-in-start')
  f.home.emit('did-start-navigation', {}, `${BASE}/login`, false, true)
  f.navigate(f.home, `${BASE}/login`)
  assert.deepEqual(await starting, { ok: false, error: 'The sign-in page changed. Start again.' })
})

test('leaving login abandons the request, so a late callback cannot replace a password sign-in', async () => {
  const f = appFixture()
  await f.call('browser-sign-in-start')
  const state = f.state()
  f.navigate(f.home, `${BASE}/dashboard`)
  assert.equal(f.browserSignIn.receive({ code: CODE, state }), false)
  assert.deepEqual(f.loads, [])
})

test('a callback while Home is not on login is consumed without loading anything', async () => {
  const f = appFixture()
  await f.call('browser-sign-in-start')
  const state = f.state()
  f.home.mainFrame.url = `${BASE}/dashboard`
  assert.equal(f.browserSignIn.receive({ code: CODE, state }), true)
  assert.deepEqual(f.loads, [])
  f.home.mainFrame.url = `${BASE}/login`
  assert.equal(await f.call('browser-sign-in-take'), null)
})

test('cancel from Home clears the request; an unauthorized cancel cannot', async () => {
  const f = appFixture()
  await f.call('browser-sign-in-start')
  await f.call('browser-sign-in-cancel', f.page(`${BASE}/login`, 'app'))
  assert.equal(f.browserSignIn.receive({ code: CODE, state: f.state() }), true)
  f.navigate(f.home, `${BASE}/login?desktopSignIn=complete`)

  await f.call('browser-sign-in-start')
  const state = f.state()
  await f.call('browser-sign-in-cancel')
  assert.equal(f.browserSignIn.receive({ code: CODE, state }), false)
})

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { installQuitApp, quitApp } = require('../src/quit-app')
const { createWindowSecurity } = require('../src/window-security')

const BASE = 'https://brinq.io'

// Real window security with fake live windows, so sender checks are the real ones.
function fixture() {
  const security = createWindowSecurity({ baseUrl: BASE, preloadPath: '/preload.js', openExternal: () => {} })
  const session = { setPermissionCheckHandler() {}, setPermissionRequestHandler() {} }
  const app = { isQuitting: false, quits: [], exits: 0 }
  // Record whether isQuitting was already set when quit ran, as the tray does.
  app.quit = () => app.quits.push(app.isQuitting)
  app.exit = () => { app.exits++ }
  const handlers = new Map()
  installQuitApp({ ipcMain: { on: (channel, fn) => handlers.set(channel, fn) }, app, security })
  function page(url, role = 'main') {
    const wc = new EventEmitter()
    Object.assign(wc, {
      mainFrame: { url, origin: new URL(url).origin, parent: null, detached: false },
      session, isDestroyed: () => false, getURL: () => wc.mainFrame.url,
      setWindowOpenHandler() {},
    })
    const owner = new EventEmitter()
    owner.isDestroyed = () => false
    security.register(wc, role, url, owner)
    return wc
  }
  const send = (wc, frame = wc.mainFrame) => handlers.get('quit-app')({ sender: wc, senderFrame: frame })
  return { app, page, send, handlers }
}

test('a Brinq page quits through the normal quit, so unsaved-work prompts still run', () => {
  const f = fixture()
  assert.deepEqual([...f.handlers.keys()], ['quit-app'])
  f.send(f.page(`${BASE}/dashboard`))
  // app.quit() lets every window's close and unload guard answer; exit would not.
  assert.deepEqual(f.app.quits, [true])
  assert.equal(f.app.exits, 0)
})

test('only a validated Brinq app page can quit', () => {
  const f = fixture()
  const home = f.page(`${BASE}/dashboard`)
  const unregistered = new EventEmitter()
  Object.assign(unregistered, {
    mainFrame: { url: `${BASE}/dashboard`, origin: BASE, parent: null, detached: false },
    isDestroyed: () => false, getURL: () => `${BASE}/dashboard`,
  })
  f.send(unregistered)
  // A subframe of a real page.
  f.send(home, { url: `${BASE}/embed`, origin: BASE, parent: home.mainFrame, detached: false })
  // A page that navigated off the Brinq origin.
  const away = f.page(`${BASE}/clients`)
  away.mainFrame.url = 'https://evil.test/'
  away.mainFrame.origin = 'https://evil.test'
  f.send(away)
  assert.deepEqual(f.app.quits, [])
})

test('the tray Quit and the page Quit share one path', () => {
  const app = { isQuitting: false, quits: [] }
  app.quit = () => app.quits.push(app.isQuitting)
  quitApp(app)
  assert.deepEqual(app.quits, [true])
})

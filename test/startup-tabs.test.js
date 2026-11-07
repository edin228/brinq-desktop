const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { installStartupTabs, parseStartup, parseSession, validSections, pickTabs, SAVE_DELAY_MS } = require('../src/startup-tabs')
const { createWindowSecurity } = require('../src/window-security')

const BASE = 'https://brinq.io'
const isAppUrl = createWindowSecurity({ baseUrl: BASE, preloadPath: '/p.js', openExternal() {} }).isAppUrl

// Sections as the web app reports them for a producer with every feature on.
const SECTIONS = [
  { key: 'dashboard', label: 'Dashboard', href: '/dashboard', paths: ['/dashboard', '/dashboard-producers'] },
  { key: 'renewals', label: 'Renewals', href: '/renewals/11/2026', paths: ['/renewals', '/clients', '/certs'] },
  { key: 'pipeline', label: 'Pipeline', href: '/pipeline', paths: ['/pipeline', '/opportunities'] },
  { key: 'reports', label: 'Reports', href: '/reports/explore', paths: ['/reports'] },
  { key: 'email', label: 'Email', href: '/emails', paths: ['/emails', '/email'] },
  { key: 'settings', label: 'Settings', href: '/settings', paths: ['/settings'] },
]

// Real window security with fake live pages; a fake tab window records restores.
function fixture({ mode = 'full', startup = { choice: 'home', pages: [] }, session = null } = {}) {
  const security = createWindowSecurity({ baseUrl: BASE, preloadPath: '/preload.js', openExternal() {} })
  const browserSession = { setPermissionCheckHandler() {}, setPermissionRequestHandler() {} }
  const owner = new EventEmitter()
  owner.isDestroyed = () => false
  function page(url, role = 'app') {
    const wc = new EventEmitter()
    Object.assign(wc, {
      mainFrame: { url, origin: new URL(url).origin, parent: null, detached: false },
      session: browserSession, isDestroyed: () => false, getURL: () => wc.mainFrame.url,
      setWindowOpenHandler() {},
    })
    security.register(wc, role, url, owner)
    return wc
  }
  const home = page(`${BASE}/dashboard?standalone=full`, 'main')
  const restores = []
  const labels = []
  const window = {
    home, tabs: [],
    available: () => true,
    restoreTabs(items) {
      restores.push(items)
      const added = items.map((item, index) => ({ id: 10 + window.tabs.length + index, url: item.url }))
      window.tabs.push(...added.map((tab) => ({ url: tab.url })))
      return added
    },
    labelRestored(entries) { labels.push(entries); return { labeled: entries.filter((entry) => entry.title).length, closed: entries.filter((entry) => entry.unavailable).length } },
    getSessionState: () => ({ tabs: window.tabs.map((tab) => ({ url: tab.url })) }),
  }
  const store = { mode, startup, lastSession: session, failSave: false, writes: [] }
  const config = {
    getMode: () => store.mode,
    getStartup: () => parseStartup(store.startup),
    getLastSession: () => parseSession(store.lastSession),
    saveStartup(value, { clearSession = false } = {}) {
      if (store.failSave) throw new Error('disk')
      store.startup = value
      if (clearSession) store.lastSession = null
      store.writes.push(['startup', value, clearSession])
    },
    setLastSession(value) {
      if (store.failSave) throw new Error('disk')
      store.lastSession = value
      store.writes.push(['lastSession', value])
    },
  }
  const app = new EventEmitter()
  app.isQuitting = false
  const timers = []
  const clock = {
    setTimeout: (fn, ms) => { const timer = { fn, ms, live: true }; timers.push(timer); return timer },
    clearTimeout: (timer) => { if (timer) timer.live = false },
    run: () => { for (const timer of timers.splice(0)) if (timer.live) timer.fn() },
  }
  const handlers = new Map()
  const logs = []
  const startupTabs = installStartupTabs({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    app, security, config, tabWindow: () => window, baseUrl: BASE,
    desktopState: () => ({ mode: store.mode, version: '1.4.0', startup: config.getStartup() }),
    timers: clock, log: (category) => logs.push(category),
  })
  const call = (channel, sender, payload, frame = sender.mainFrame) => handlers.get(channel)({ sender, senderFrame: frame }, payload)
  const open = (userId = 'u-1', sender = home, sections = SECTIONS) => call('open-startup-tabs', sender, { userId, sections })
  const quit = () => {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    app.emit('before-quit', event)
    app.isQuitting = true
  }
  return { security, page, home, window, store, config, app, clock, handlers, call, open, quit, restores, labels, logs, startupTabs }
}

test('a saved choice or session that is corrupt means Home only, or no session', () => {
  assert.deepEqual(parseStartup(undefined), { choice: 'home', pages: [] })
  assert.deepEqual(parseStartup({ choice: 'tabs', pages: [] }), { choice: 'home', pages: [] })
  assert.deepEqual(parseStartup({ choice: 'pages', pages: ['email', 'email'] }), { choice: 'home', pages: [] })
  assert.deepEqual(parseStartup({ choice: 'pages', pages: ['email', 'renewals'] }), { choice: 'pages', pages: ['email', 'renewals'] })
  assert.equal(parseSession({ userId: 'u-1', tabs: [{ url: 5 }] }), null)
  assert.equal(parseSession({ userId: '', tabs: [] }), null)
  // A legacy selection and any other key are dropped.
  assert.deepEqual(parseSession({ userId: 'u-1', tabs: [{ url: `${BASE}/emails`, title: 'Inbox' }], selectedIndex: 0 }),
    { userId: 'u-1', tabs: [{ url: `${BASE}/emails` }] })
})

test('sections are rejected whole unless every field is a safe Brinq path', () => {
  assert.equal(validSections(SECTIONS, { baseUrl: BASE, isAppUrl }).length, SECTIONS.length)
  const one = (change) => validSections([{ ...SECTIONS[0], ...change }], { baseUrl: BASE, isAppUrl })
  for (const href of ['https://evil.test/dashboard', '//evil.test/dashboard', 'javascript:alert(1)', 'dashboard', '/\\evil', '/login', '/oauth/callback', '/api/v1/x', '/dash\nboard']) {
    assert.equal(one({ href }), null, href)
  }
  for (const paths of [['/'], ['/dashboard/'], ['/a/../dashboard'], ['/dashboard?x=1'], ['/dashboard', '/dashboard'], ['/rc'], [], Array(9).fill(0).map((_, i) => `/p${i}`)]) {
    assert.equal(one({ paths }), null, JSON.stringify(paths))
  }
  assert.equal(one({ href: '/emails', paths: ['/dashboard'] }), null, 'href outside its own paths')
  assert.equal(one({ key: 'Bad Key' }), null)
  assert.equal(one({ label: '' }), null)
  assert.equal(validSections([SECTIONS[0], SECTIONS[0]], { baseUrl: BASE, isAppUrl }), null, 'duplicate keys')
  assert.equal(validSections(Array(33).fill(0).map((_, i) => ({ ...SECTIONS[0], key: `k${i}` })), { baseUrl: BASE, isAppUrl }), null)
  assert.deepEqual(one({ href: '/dashboard?view=week#top' })[0].url, `${BASE}/dashboard?view=week#top`)
})

test('last time\'s tabs reopen only under the person\'s current sections, without callbacks or repeats', () => {
  const sections = validSections(SECTIONS, { baseUrl: BASE, isAppUrl })
  const saved = [
    `${BASE}/renewals/11/2026`, `${BASE}/clients/42?tab=policies#notes`, `${BASE}/emails?folder=inbox&standalone=full`,
    `${BASE}/emails-evil`, `${BASE}/login?return=/x`, `${BASE}/oauth/callback`, `${BASE}/email/file-viewer?id=1`,
    `${BASE}/forms/1`, 'https://evil.test/clients/1', `${BASE}/clients/42?tab=policies#notes`, `${BASE}/dashboard`,
  ]
  const picked = pickTabs({
    startup: { choice: 'last', pages: [] }, session: { userId: 'u-1', tabs: saved.map((url) => ({ url })) },
    sections, userId: 'u-1', homeUrl: `${BASE}/dashboard?standalone=full`, isAppUrl,
  })
  assert.deepEqual(picked, [
    { url: `${BASE}/renewals/11/2026`, label: 'Renewals' },
    { url: `${BASE}/clients/42?tab=policies#notes`, label: 'Renewals' },
    { url: `${BASE}/emails?folder=inbox`, label: 'Email' },
  ])
  assert.deepEqual(pickTabs({
    startup: { choice: 'last', pages: [] }, session: { userId: 'u-2', tabs: saved.map((url) => ({ url })) },
    sections, userId: 'u-1', homeUrl: `${BASE}/dashboard`, isAppUrl,
  }), [], 'another person\'s session restores nothing')
  const many = Array.from({ length: 12 }, (_, i) => ({ url: `${BASE}/clients/${i + 1}` }))
  assert.equal(pickTabs({ startup: { choice: 'last', pages: [] }, session: { userId: 'u-1', tabs: many }, sections, userId: 'u-1', homeUrl: `${BASE}/dashboard`, isAppUrl }).length, 8)
})

test('chosen pages open in section order, skip Home\'s page and sections the person lost', () => {
  const sections = validSections(SECTIONS, { baseUrl: BASE, isAppUrl })
  const picked = pickTabs({
    startup: { choice: 'pages', pages: ['email', 'dashboard', 'renewals', 'calendar'] }, session: null,
    sections, userId: 'u-1', homeUrl: `${BASE}/dashboard?standalone=full`, isAppUrl,
  })
  assert.deepEqual(picked, [{ url: `${BASE}/renewals/11/2026`, label: 'Renewals' }, { url: `${BASE}/emails`, label: 'Email' }])
})

test('only Home\'s validated page can open startup tabs, once per launch', () => {
  const f = fixture({ startup: { choice: 'pages', pages: ['email'] } })
  const tab = f.page(`${BASE}/clients/1`)
  const popout = f.page(`${BASE}/email/1`)
  for (const sender of [tab, popout]) assert.deepEqual(f.open('u-1', sender), { opened: 0, tabs: [] })
  assert.deepEqual(f.call('open-startup-tabs', f.home, { userId: 'u-1', sections: SECTIONS },
    { url: `${BASE}/embed`, origin: BASE, parent: f.home.mainFrame, detached: false }), { opened: 0, tabs: [] }, 'a subframe')
  const unregistered = new EventEmitter()
  Object.assign(unregistered, { mainFrame: f.home.mainFrame, isDestroyed: () => false, getURL: () => f.home.getURL() })
  assert.deepEqual(f.open('u-1', unregistered), { opened: 0, tabs: [] })
  f.home.emit('did-start-navigation', {}, `${BASE}/x`, false, true)
  assert.deepEqual(f.open(), { opened: 0, tabs: [] }, 'mid-navigation')
  f.home.emit('did-frame-navigate', {}, `${BASE}/dashboard`, 200, 'OK', true)
  // Bad shapes are rejected without using up the launch.
  for (const request of [null, { userId: '', sections: SECTIONS }, { userId: 7, sections: SECTIONS }, { userId: 'u-1', sections: [] }]) {
    assert.deepEqual(f.call('open-startup-tabs', f.home, request), { opened: 0, tabs: [] })
  }
  assert.deepEqual(f.open(), { opened: 1, tabs: [`${BASE}/emails`] })
  assert.deepEqual(f.open(), { opened: 0, tabs: [] }, 'a second call opens nothing')
  assert.equal(f.restores.length, 1)
})

test('Mail Mode and Home only use up the launch and open or save nothing', () => {
  for (const options of [{ mode: 'email', startup: { choice: 'pages', pages: ['email'] } }, { startup: { choice: 'home', pages: ['email'] } }]) {
    const f = fixture({ ...options, session: { userId: 'u-1', tabs: [{ url: `${BASE}/clients/1` }] } })
    assert.deepEqual(f.open(), { opened: 0, tabs: [] })
    f.store.startup = { choice: 'pages', pages: ['email'] }
    f.store.mode = 'full'
    assert.deepEqual(f.open(), { opened: 0, tabs: [] }, 'the launch is used up')
    f.quit()
    assert.deepEqual(f.store.lastSession, { userId: 'u-1', tabs: [{ url: `${BASE}/clients/1` }] })
  }
})

test('the tab list is saved after a pause, addresses only, and only for this launch\'s owner', () => {
  const f = fixture({ startup: { choice: 'last', pages: [] }, session: { userId: 'u-1', tabs: [{ url: `${BASE}/clients/7` }] } })
  // Changes before the web app reports the signed-in person are ignored.
  f.startupTabs.onTabsChanged({ tabs: [] })
  f.clock.run()
  assert.equal(f.store.writes.length, 0)
  assert.deepEqual(f.open(), { opened: 1, tabs: [`${BASE}/clients/7`] })
  assert.deepEqual(f.labels, [])
  f.window.tabs.push({ url: `${BASE}/emails?standalone=full` })
  f.startupTabs.onTabsChanged(f.window.getSessionState())
  f.startupTabs.onTabsChanged(f.window.getSessionState())
  assert.equal(f.store.writes.length, 0, 'waits for the pause')
  f.clock.run()
  assert.deepEqual(f.store.writes, [['lastSession', { userId: 'u-1', tabs: [{ url: `${BASE}/clients/7` }, { url: `${BASE}/emails` }] }]])
  // An unchanged list (a title or loading update) writes nothing.
  f.startupTabs.onTabsChanged(f.window.getSessionState())
  f.clock.run()
  assert.equal(f.store.writes.length, 1)
  assert.equal(SAVE_DELAY_MS, 1000)
  // A different person reported later stops saving for the rest of the launch.
  f.window.tabs.push({ url: `${BASE}/clients/8` })
  f.startupTabs.onTabsChanged(f.window.getSessionState())
  f.open('u-2')
  f.clock.run()
  f.quit()
  assert.equal(f.store.writes.length, 1)
  assert.equal(f.store.lastSession.userId, 'u-1')
})

test('a quit saves the tabs as they are before any closes, once', () => {
  const f = fixture({ startup: { choice: 'last', pages: [] } })
  f.open()
  f.window.tabs.push({ url: `${BASE}/clients/1` }, { url: `${BASE}/clients/2` })
  f.startupTabs.onTabsChanged(f.window.getSessionState())
  // Quit within the pause: the latest list is saved at once.
  f.quit()
  assert.deepEqual(f.store.lastSession.tabs, [{ url: `${BASE}/clients/1` }, { url: `${BASE}/clients/2` }])
  // Tabs close; the quit's second pass saves nothing more.
  f.window.tabs.length = 0
  f.startupTabs.onTabsChanged(f.window.getSessionState())
  f.clock.run()
  f.app.emit('before-quit', { defaultPrevented: false })
  assert.equal(f.store.writes.length, 1)
})

test('after Stay or a stalled update, saving resumes without overwriting the saved tabs', () => {
  const f = fixture({ startup: { choice: 'last', pages: [] } })
  f.open()
  f.window.tabs.push({ url: `${BASE}/clients/1` }, { url: `${BASE}/clients/2` })
  f.quit()
  // The quit closed one tab before Stay.
  f.window.tabs.shift()
  f.startupTabs.resume()
  assert.equal(f.store.writes.length, 1, 'still quitting: no resume')
  f.app.isQuitting = false
  f.startupTabs.resume()
  f.startupTabs.onTabsChanged(f.window.getSessionState())
  f.clock.run()
  assert.equal(f.store.writes.length, 1, 'the surviving list alone is not a change')
  f.window.tabs.push({ url: `${BASE}/emails` })
  f.startupTabs.onTabsChanged(f.window.getSessionState())
  f.clock.run()
  assert.deepEqual(f.store.lastSession.tabs, [{ url: `${BASE}/clients/2` }, { url: `${BASE}/emails` }])
  // A blocked installer prevents the quit: nothing pauses.
  f.app.emit('before-quit', { defaultPrevented: true })
  f.window.tabs.push({ url: `${BASE}/clients/3` })
  f.startupTabs.onTabsChanged(f.window.getSessionState())
  f.clock.run()
  assert.equal(f.store.lastSession.tabs.length, 3)
})

test('a quit before the web app reports, or signed out, keeps the saved session', () => {
  const saved = { userId: 'u-1', tabs: [{ url: `${BASE}/clients/1` }] }
  const f = fixture({ startup: { choice: 'last', pages: [] }, session: saved })
  f.startupTabs.onTabsChanged({ tabs: [] })
  f.quit()
  f.clock.run()
  assert.deepEqual(f.store.lastSession, saved)
  assert.equal(f.store.writes.length, 0)
})

test('choosing another option erases the saved session; choosing last time again starts fresh', () => {
  const f = fixture({ startup: { choice: 'last', pages: [] }, session: { userId: 'u-1', tabs: [{ url: `${BASE}/clients/1` }] } })
  f.open()
  f.window.tabs.push({ url: `${BASE}/emails` })
  f.startupTabs.onTabsChanged(f.window.getSessionState())
  const result = f.call('set-startup', f.page(`${BASE}/settings?section=desktop`), { choice: 'pages', pages: ['email'] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.state.startup, { choice: 'pages', pages: ['email'] })
  assert.equal(f.store.lastSession, null)
  f.clock.run()
  assert.equal(f.store.lastSession, null, 'the queued save was cancelled')
  f.call('set-startup', f.home, { choice: 'last', pages: ['email'] })
  assert.equal(f.restores.length, 1, 'choosing opens nothing now')
  f.clock.run()
  assert.deepEqual(f.store.lastSession, { userId: 'u-1', tabs: [{ url: `${BASE}/clients/1` }, { url: `${BASE}/emails` }] })
})

test('a startup choice is validated, explains the 8-page limit, and a failed save keeps the old one', () => {
  const f = fixture({ startup: { choice: 'pages', pages: ['email'] } })
  const settings = f.page(`${BASE}/settings?section=desktop`)
  const nine = Array.from({ length: 9 }, (_, i) => `page-${i}`)
  const over = f.call('set-startup', settings, { choice: 'pages', pages: nine })
  assert.equal(over.ok, false)
  assert.match(over.error, /Up to 8 pages.*9 are chosen.*Deselect a page/)
  for (const value of [null, { choice: 'tabs', pages: [] }, { choice: 'pages', pages: ['Email'] }, { choice: 'pages', pages: ['a', 'a'] }]) {
    assert.equal(f.call('set-startup', settings, value).ok, false)
  }
  f.store.failSave = true
  const failed = f.call('set-startup', settings, { choice: 'home', pages: [] })
  assert.deepEqual([failed.ok, failed.error, failed.state.startup], [false, "Brinq Desktop couldn't save that startup choice. Reopen Settings and try again.", { choice: 'pages', pages: ['email'] }])
  assert.deepEqual(f.logs, ['startup-save-failed'], 'a fixed category, no addresses')
  const away = f.page(`${BASE}/clients`)
  away.mainFrame.url = 'https://evil.test/'
  away.mainFrame.origin = 'https://evil.test'
  assert.deepEqual(f.call('set-startup', away, { choice: 'home', pages: [] }), { ok: false, error: 'Unauthorized sender.' })
})

test('a session that fails to save is kept as it was and logged by category only', () => {
  const saved = { userId: 'u-1', tabs: [{ url: `${BASE}/clients/1` }] }
  const f = fixture({ startup: { choice: 'last', pages: [] }, session: saved })
  f.open()
  f.store.failSave = true
  f.window.tabs.push({ url: `${BASE}/emails` })
  f.startupTabs.onTabsChanged(f.window.getSessionState())
  f.clock.run()
  f.quit()
  assert.deepEqual(f.store.lastSession, saved)
  assert.deepEqual(f.logs, ['session-save-failed', 'session-save-failed'])
})

test('labels come only from the restoring Home document, for its restored tabs, before quitting', () => {
  const f = fixture({ startup: { choice: 'pages', pages: ['renewals', 'email'] } })
  const label = (labels, sender = f.home) => f.call('label-startup-tabs', sender, labels)
  assert.deepEqual(label([]), { labeled: 0, closed: 0 }, 'before any restore')
  f.open()
  const renewals = `${BASE}/renewals/11/2026`
  const email = `${BASE}/emails`
  assert.deepEqual(label([]), { labeled: 0, closed: 0 }, 'empty does nothing')
  assert.deepEqual(f.labels, [])
  const long = 'x'.repeat(1000)
  assert.deepEqual(label([{ url: renewals, title: `brinq | ${long}` }, { url: email, unavailable: true }]), { labeled: 1, closed: 1 })
  assert.deepEqual(f.labels.at(-1), [{ url: renewals, title: `brinq | ${long}` }, { url: email, unavailable: true }])
  const rejected = [
    [{ url: `${BASE}/clients/1`, title: 'Not restored' }],
    [{ url: renewals, title: 5 }],
    [{ url: renewals, title: 'A' }, { url: renewals, title: 'B' }],
    [{ url: renewals, unavailable: true, title: 'Both' }],
    Array.from({ length: 9 }, () => ({ url: renewals, title: 'A' })),
  ]
  for (const labels of rejected) assert.deepEqual(label(labels), { labeled: 0, closed: 0 }, JSON.stringify(labels).slice(0, 80))
  assert.deepEqual(label([{ url: renewals, title: 'A' }], f.page(`${BASE}/clients/1`)), { labeled: 0, closed: 0 }, 'a tab page')
  // Home loads a new document: the old generation's labels are refused.
  f.home.emit('did-start-navigation', {}, `${BASE}/dashboard`, false, true)
  f.home.emit('did-frame-navigate', {}, `${BASE}/dashboard`, 200, 'OK', true)
  assert.deepEqual(label([{ url: renewals, title: 'A' }]), { labeled: 0, closed: 0 }, 'a later Home document')
  assert.equal(f.labels.length, 1)
})

test('labels stop after another person reports or a quit starts', () => {
  for (const stop of ['user', 'quit']) {
    const f = fixture({ startup: { choice: 'pages', pages: ['email'] } })
    f.open()
    if (stop === 'user') f.open('u-2')
    else f.quit()
    assert.deepEqual(f.call('label-startup-tabs', f.home, [{ url: `${BASE}/emails`, title: 'Inbox' }]), { labeled: 0, closed: 0 }, stop)
    assert.equal(f.labels.length, 0)
  }
})

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createTabWindow, THEME_COLORS } = require('../src/tab-window')
const { createWindowSecurity } = require('../src/window-security')

const BASE = 'http://localhost:3004'
const SHELL = 'file:///app/src/shell/shell.html'

// Fake Electron objects record what the tab window asks of them. Closing a
// page runs its unload guard (`veto`) the way Electron does: the page emits
// will-prevent-unload and is destroyed only if a listener lets it go.
function fakeContents(session, url = '') {
  const wc = new EventEmitter()
  const frame = { url, origin: BASE, parent: null, detached: false }
  Object.assign(wc, {
    session, mainFrame: frame, destroyed: false, loads: [], sent: [], closes: [], focused: 0,
    reloads: 0, hardReloads: 0, zoom: 0, devtools: 0, veto: false,
    isDestroyed() { return this.destroyed },
    getURL: () => frame.url,
    setWindowOpenHandler(fn) { this.popup = fn },
    loadURL(target, options) {
      this.loads.push([target, options])
      frame.url = target
      try { frame.origin = new URL(target).origin } catch {}
      return Promise.resolve()
    },
    send(...args) { this.sent.push(args) },
    focus() { this.focused++ },
    reload() { this.reloads++ },
    reloadIgnoringCache() { this.hardReloads++ },
    toggleDevTools() { this.devtools++ },
    getZoomLevel() { return this.zoom },
    setZoomLevel(level) { this.zoom = level },
    close(options) {
      this.closes.push(options)
      if (this.veto && options?.waitForBeforeUnload) {
        let leave = false
        this.emit('will-prevent-unload', { preventDefault() { leave = true } })
        if (!leave) return
      }
      this.destroy()
    },
    destroy() {
      if (this.destroyed) return
      this.destroyed = true
      this.emit('destroyed')
    },
  })
  return wc
}

function fixture({ platform = 'win32', theme = 'light', choice = 1 } = {}) {
  const session = { setPermissionCheckHandler() {}, setPermissionRequestHandler() {} }
  const security = createWindowSecurity({ baseUrl: BASE, preloadPath: '/preload.js', openExternal() {} })
  const queue = []
  const flush = () => { while (queue.length) queue.shift()() }
  const clock = {
    now: 1000,
    timers: [],
    advance(ms) {
      clock.now += ms
      const due = clock.timers.filter(([at]) => at <= clock.now)
      clock.timers = clock.timers.filter(([at]) => at > clock.now)
      for (const [, fn] of due) fn()
    },
  }
  const windows = []
  const dialogs = []
  const homes = []
  const themes = []
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super()
      this.options = options
      this.webContents = fakeContents(session)
      this.children = []
      this.contentView = {
        addChildView: (view) => this.children.push(view),
        removeChildView: (view) => { this.children = this.children.filter((child) => child !== view) },
      }
      this.destroyed = false
      this.visible = false
      this.titles = []
      this.overlays = []
      windows.push(this)
    }
    isDestroyed() { return this.destroyed }
    isVisible() { return this.visible }
    show() { this.visible = true }
    focus() { this.focusedCount = (this.focusedCount || 0) + 1 }
    getContentSize() { return [1200, 800] }
    setTitle(title) { this.titles.push(title) }
    setBackgroundColor(color) { this.background = color }
    setTitleBarOverlay(options) { this.overlays.push(options) }
    loadURL(url, options) { return this.webContents.loadURL(url, options) }
    close() { this.destroyed = true; this.emit('closed') }
  }
  class WebContentsView {
    constructor({ webContents, webPreferences } = {}) {
      this.webContents = webContents || fakeContents(session)
      this.webPreferences = webPreferences
      this.visible = true
    }
    setBounds(bounds) { this.bounds = bounds }
    setVisible(visible) { this.visible = visible }
    setBackgroundColor(color) { this.background = color }
  }
  const dialog = { showMessageBoxSync: (owner, options) => { dialogs.push([owner, options]); return choice } }
  const tabs = createTabWindow({
    electron: { BrowserWindow, WebContentsView, dialog },
    security, bounds: { width: 1200, height: 800 }, icon: '/icon.ico',
    preloadPath: '/preload.js', shellPreloadPath: '/shell-preload.js', shellUrl: SHELL,
    theme, platform,
    newTabUrl: (home) => home.getURL() || `${BASE}/dashboard?standalone=full`,
    onTheme: (value) => themes.push(value),
    onHome: (contents, url) => {
      homes.push([contents, url])
      contents.loadURL(url || `${BASE}/dashboard?standalone=full`)
    },
    schedule: (fn) => queue.push(fn),
    now: () => clock.now,
    setTimer: (fn, ms) => clock.timers.push([clock.now + ms, fn]),
  })
  const host = windows[0]
  const strip = host.webContents
  strip.mainFrame.url = SHELL
  strip.mainFrame.origin = 'file://'
  flush()
  const state = () => strip.sent.filter(([channel]) => channel === 'tabs:state').at(-1)?.[1]
  const stripEvent = (overrides = {}) => ({ sender: strip, senderFrame: strip.mainFrame, ...overrides })
  const viewOf = (contents) => host.children.find((view) => view.webContents === contents)
  const open = (url, { background = true, opener = tabs.home, guest = null } = {}) => {
    const contents = tabs.openTab({
      opener, url, referrer: { url: opener.getURL(), policy: 'default' }, background,
      options: guest ? { webContents: guest } : { webPreferences: { preload: '/preload.js', openerSandboxFlags: 8, nodeIntegration: true } },
    })
    flush()
    return contents
  }
  return { tabs, host, strip, security, session, windows, dialogs, homes, themes, flush, state, stripEvent, viewOf, open, fakeContents, queue, clock }
}

function tabIds(f) { return f.state().tabs.map((tab) => tab.id) }

test('the window hosts a local strip and Home, a registered page below the strip', () => {
  const f = fixture({ theme: 'dark' })
  assert.equal(f.host.options.titleBarStyle, 'hidden')
  assert.deepEqual(f.host.options.titleBarOverlay, { ...THEME_COLORS.dark, height: 40 })
  assert.equal(f.host.options.backgroundColor, THEME_COLORS.dark.color)
  assert.equal(f.host.options.webPreferences.preload, '/shell-preload.js')
  assert.equal(f.host.options.webPreferences.sandbox, true)
  assert.deepEqual(f.strip.loads.map(([url]) => url), [SHELL])
  assert.equal(f.homes.length, 1)
  assert.equal(f.homes[0][0], f.tabs.home)
  const view = f.viewOf(f.tabs.home)
  assert.deepEqual(view.bounds, { x: 0, y: 40, width: 1200, height: 760 })
  assert.equal(view.visible, true)
  assert.equal(f.security.validateSender({ sender: f.tabs.home, senderFrame: f.tabs.home.mainFrame }, ['main']), true)
  assert.deepEqual(f.state().tabs.map(({ id, home }) => [id, home]), [[1, true]])
  assert.equal(f.state().theme, 'dark')
  assert.equal(fixture({ platform: 'darwin' }).host.options.titleBarOverlay, undefined)
})

test('background opens load once and never steal selection; foreground opens select and focus', () => {
  const f = fixture()
  const url = `${BASE}/clients/42?view=policies`
  const tab = f.open(url)
  assert.deepEqual(tab.loads, [[url, { httpReferrer: { url: f.tabs.home.getURL(), policy: 'default' } }]])
  assert.equal(f.state().selectedId, 1)
  assert.equal(f.viewOf(tab).visible, false)
  assert.equal(tab.focused, 0)
  // The opener's sandbox flags are kept; the app preferences are not loosened.
  assert.equal(f.viewOf(tab).webPreferences.openerSandboxFlags, 8)
  assert.equal(f.viewOf(tab).webPreferences.nodeIntegration, false)
  assert.equal(f.viewOf(tab).webPreferences.sandbox, true)
  assert.equal(f.security.validateSender({ sender: tab, senderFrame: tab.mainFrame }), true)
  const guest = f.fakeContents(f.session, `${BASE}/clients/7`)
  const adopted = f.open(`${BASE}/clients/7`, { background: false, guest })
  assert.equal(adopted, guest)
  assert.deepEqual(guest.loads, [])
  assert.equal(f.viewOf(guest).visible, true)
  assert.equal(f.viewOf(tab).visible, false)
  assert.equal(guest.focused, 1)
  assert.equal(f.state().tabs.length, 3)
})

test('tabs opened from Home stay beside it; opens from other windows append and raise the host', () => {
  const f = fixture()
  const label = (contents, title) => { contents.emit('page-title-updated', {}, title); f.flush() }
  const other = f.open(`${BASE}/clients/1`)
  label(other, 'Other')
  const child = f.open(`${BASE}/clients/2`, { opener: other })
  label(child, 'Child')
  const fromHome = f.open(`${BASE}/clients/3`)
  label(fromHome, 'From Home')
  assert.deepEqual(f.state().tabs.map((tab) => tab.label).slice(1), ['Other', 'Child', 'From Home'])
  const popout = f.fakeContents(f.session, `${BASE}/email/1`)
  const popoutWindow = new EventEmitter()
  popoutWindow.isDestroyed = () => false
  f.security.register(popout, 'app', undefined, popoutWindow)
  f.host.visible = false
  label(f.open(`${BASE}/clients/4`, { opener: popout }), 'From pop-out')
  assert.equal(f.state().tabs.at(-1).label, 'From pop-out')
  assert.equal(f.host.visible, false, 'background opens do not raise the window')
  f.open(`${BASE}/clients/5`, { opener: popout, background: false })
  assert.equal(f.host.visible, true)
  assert.equal(f.host.focusedCount, 1)
})

test('an open after the window closed still gets an ordinary window', () => {
  const f = fixture()
  f.host.close()
  const contents = f.tabs.openTab({ opener: f.tabs.home, url: `${BASE}/clients/9`, options: { webPreferences: {} }, referrer: { url: '', policy: 'default' }, background: true })
  const fallback = f.windows.at(-1)
  assert.notEqual(fallback, f.host)
  assert.equal(contents, fallback.webContents)
  assert.deepEqual(contents.loads.map(([url]) => url), [`${BASE}/clients/9`])
})

test('closing honors unload guards and removes a tab only once its page is destroyed', () => {
  const f = fixture({ choice: 1 })
  const a = f.open(`${BASE}/clients/1`)
  const b = f.open(`${BASE}/clients/2`)
  const [, idA, idB] = tabIds(f)
  f.tabs.select(idA)
  f.flush()
  assert.equal(f.tabs.closeTab(1), false, 'Home cannot close')
  a.veto = true
  assert.equal(f.tabs.closeTab(idA), true)
  assert.deepEqual(a.closes, [{ waitForBeforeUnload: true }])
  assert.equal(f.dialogs.length, 1)
  assert.equal(f.dialogs[0][0], f.host)
  assert.equal(f.dialogs[0][1].message, 'Leave this page?')
  assert.equal(f.dialogs[0][1].cancelId, 1)
  f.flush()
  assert.deepEqual(tabIds(f), [1, idA, idB], 'Stay keeps the tab')
  assert.equal(f.state().selectedId, idA)
  a.veto = false
  f.clock.advance(250)
  assert.equal(f.tabs.closeTab(idA), true, 'a stayed tab can be closed again')
  f.flush()
  assert.deepEqual(tabIds(f), [1, idB])
  assert.equal(f.state().selectedId, idB, 'selection moves to the right neighbor')
  assert.equal(f.viewOf(a), undefined)
  assert.equal(f.security.validateSender({ sender: a, senderFrame: a.mainFrame }), false)
  b.destroy()
  f.flush()
  assert.deepEqual(tabIds(f), [1])
  assert.equal(f.state().selectedId, 1)
  assert.equal(f.tabs.closeTab(idB), false)
})

test('Leave in the unload prompt lets the page go; repeated requests prompt once', () => {
  const f = fixture({ choice: 0 })
  const tab = f.open(`${BASE}/clients/1`)
  const id = tabIds(f)[1]
  const requests = []
  const close = tab.close.bind(tab)
  // Chromium runs one unload at a time: queue requests and answer the first.
  tab.close = (options) => { requests.push(options) }
  assert.equal(f.tabs.closeTab(id), true)
  assert.equal(f.tabs.closeTab(id), true)
  tab.veto = true
  close(requests[0])
  f.flush()
  assert.equal(f.dialogs.length, 1)
  assert.deepEqual(tabIds(f), [1])
})

test('a close right after Stay waits for Chromium instead of being dropped', () => {
  const f = fixture({ choice: 1 })
  const tab = f.open(`${BASE}/clients/1`)
  const id = tabIds(f)[1]
  tab.veto = true
  f.tabs.closeTab(id)
  assert.equal(f.dialogs.length, 1)
  f.clock.advance(10)
  tab.veto = false
  assert.equal(f.tabs.closeTab(id), true)
  assert.equal(tab.closes.length, 1, 'the retry waits for the canceled unload to finish')
  f.clock.advance(239)
  assert.equal(tab.closes.length, 1)
  f.clock.advance(1)
  assert.equal(tab.closes.length, 2)
  f.flush()
  assert.deepEqual(tabIds(f), [1])
  const later = f.open(`${BASE}/clients/2`)
  f.tabs.closeTab(tabIds(f)[1])
  assert.equal(later.closes.length, 1, 'tabs without a recent Stay close at once')
})

test('quit closes tabs one at a time with Home last and stops at Stay', async () => {
  const f = fixture({ choice: 1 })
  const a = f.open(`${BASE}/clients/1`)
  const b = f.open(`${BASE}/clients/2`)
  const order = []
  for (const [name, contents] of [['home', f.tabs.home], ['a', a], ['b', b]]) contents.on('destroyed', () => order.push(name))
  b.veto = true
  f.host.visible = false
  const first = f.tabs.closeAllForQuit()
  assert.equal(f.tabs.closeAllForQuit(), first, 'a second quit joins the first')
  assert.equal(await first, false)
  assert.deepEqual(order, ['a'])
  assert.equal(f.host.visible, true, 'the prompt shows the hidden window')
  f.flush()
  assert.equal(f.state().selectedId, tabIds(f)[1], 'the vetoing tab is selected')
  b.veto = false
  const retry = f.tabs.closeAllForQuit()
  f.clock.advance(250)
  assert.equal(await retry, true)
  assert.deepEqual(order, ['a', 'b', 'home'])
  assert.equal(f.tabs.hasOpenTabs(), false)
  assert.equal(f.homes.length, 1, 'Home is not rebuilt during quit')
  f.tabs.ensureHome()
  f.flush()
  assert.equal(f.homes.length, 2, 'a stopped quit can bring Home back')
  assert.deepEqual(tabIds(f), [1])
})

test('Home is rebuilt on its last page if it goes away outside quit', () => {
  const f = fixture()
  f.tabs.home.emit('did-navigate', {}, `${BASE}/emails?standalone=email`)
  const first = f.tabs.home
  first.destroy()
  f.flush()
  assert.equal(f.homes.length, 2)
  assert.notEqual(f.tabs.home, first)
  assert.equal(f.homes[1][1], `${BASE}/emails?standalone=email`)
  assert.equal(f.state().selectedId, 1)
})

test('a failed or crashed tab shows the panel and retries its last approved page once at a time', async () => {
  const f = fixture()
  const tab = f.open(`${BASE}/clients/1`)
  const id = tabIds(f)[1]
  f.tabs.select(id)
  tab.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', `${BASE}/clients/1/frame`, false)
  tab.emit('did-fail-load', {}, -3, 'ABORTED', `${BASE}/clients/1`, true)
  f.flush()
  assert.equal(f.state().tabs[1].failed, null)
  tab.emit('did-fail-load', {}, -106, 'INTERNET_DISCONNECTED', `${BASE}/clients/1`, true)
  f.flush()
  assert.equal(f.state().tabs[1].failed, 'load')
  assert.equal(f.viewOf(tab).visible, false)
  const loads = tab.loads.length
  const stripCommand = (command) => f.tabs.stripCommand(f.stripEvent(), command, id)
  assert.equal(stripCommand('retry'), true)
  stripCommand('retry')
  f.flush()
  assert.equal(tab.loads.length, loads + 1)
  assert.equal(tab.loads.at(-1)[0], `${BASE}/clients/1`)
  assert.equal(f.state().tabs[1].failed, null)
  assert.equal(f.viewOf(tab).visible, true)
  await new Promise((resolve) => setImmediate(resolve))
  tab.emit('render-process-gone', {}, { reason: 'crashed' })
  f.flush()
  assert.equal(f.state().tabs[1].failed, 'crash')
  f.tabs.dispatch('reload')
  f.flush()
  assert.equal(tab.reloads, 0, 'refresh on a failed tab retries its page')
  assert.equal(f.state().tabs[1].failed, null)
  // Home failures belong to the recovery window, not the panel.
  f.tabs.home.emit('did-fail-load', {}, -106, 'INTERNET_DISCONNECTED', `${BASE}/dashboard`, true)
  f.flush()
  assert.equal(f.state().tabs[0].failed, null)
})

test('the selected tab owns the header theme; background reports wait and invalid ones are ignored', () => {
  const f = fixture({ theme: 'light' })
  const tab = f.open(`${BASE}/clients/1`)
  const id = tabIds(f)[1]
  f.tabs.reportTheme(tab, 'dark')
  f.flush()
  assert.equal(f.state().theme, 'light')
  assert.deepEqual(f.host.overlays, [])
  f.tabs.reportTheme(f.tabs.home, 'light')
  assert.deepEqual(f.themes, [])
  f.tabs.select(id)
  f.flush()
  assert.equal(f.state().theme, 'dark')
  assert.deepEqual(f.host.overlays, [{ ...THEME_COLORS.dark, height: 40 }])
  assert.equal(f.host.background, THEME_COLORS.dark.color)
  assert.deepEqual(f.themes, ['dark'])
  assert.deepEqual(tab.sent.filter(([channel]) => channel === 'theme-request').length, 1)
  tab.emit('did-finish-load')
  assert.deepEqual(tab.sent.filter(([channel]) => channel === 'theme-request').length, 2)
  f.tabs.reportTheme(tab, 'purple')
  f.tabs.reportTheme(f.fakeContents(f.session), 'light')
  f.tabs.reportTheme(tab, 'dark')
  assert.deepEqual(f.themes, ['dark'])
  assert.equal(f.host.overlays.length, 1)
})

test('strip commands come only from the strip page and name known tabs', () => {
  const f = fixture()
  f.open(`${BASE}/clients/1`)
  const id = tabIds(f)[1]
  const denied = [
    f.stripEvent({ sender: f.tabs.home }),
    f.stripEvent({ senderFrame: { ...f.strip.mainFrame } }),
    f.stripEvent({ senderFrame: { ...f.strip.mainFrame, parent: {} } }),
    f.stripEvent({ senderFrame: null }),
  ]
  for (const event of denied) {
    assert.equal(f.tabs.stripCommand(event, 'select', id), false)
    assert.equal(f.tabs.stripState(event), null)
  }
  f.strip.mainFrame.url = `${BASE}/evil`
  assert.equal(f.tabs.stripCommand(f.stripEvent(), 'select', id), false)
  f.strip.mainFrame.url = SHELL
  for (const bad of ['2', 2.5, -1, 999, null, NaN]) assert.equal(f.tabs.stripCommand(f.stripEvent(), 'select', bad), false)
  assert.equal(f.tabs.stripCommand(f.stripEvent(), 'close', 1), false)
  assert.equal(f.tabs.stripCommand(f.stripEvent(), 'navigate', id), false)
  assert.equal(f.tabs.stripCommand(f.stripEvent(), 'select', id, { focus: false }), true)
  f.flush()
  assert.equal(f.state().selectedId, id)
  assert.deepEqual(f.tabs.stripState(f.stripEvent()).selectedId, id)
  f.host.close()
  assert.equal(f.tabs.stripCommand(f.stripEvent(), 'home'), false)
})

test('shortcuts from any tab or the strip act on the selected tab', () => {
  const f = fixture()
  const tab = f.open(`${BASE}/clients/1`)
  const press = (contents, key, extra = {}) => {
    let prevented = false
    contents.emit('before-input-event', { preventDefault() { prevented = true } }, { type: 'keyDown', key, code: '', control: true, ...extra })
    f.flush()
    return prevented
  }
  f.tabs.home.mainFrame.url = `${BASE}/clients/7?view=files`
  f.tabs.home.emit('did-navigate', {}, f.tabs.home.mainFrame.url)
  assert.equal(press(f.tabs.home, 't'), true)
  const created = f.viewOf(f.host.children.at(-1).webContents).webContents
  assert.deepEqual(created.loads.map(([url]) => url), [`${BASE}/clients/7?view=files`])
  assert.equal(f.state().selectedId, tabIds(f).at(-1))
  assert.equal(press(f.strip, '1', { code: 'Digit1' }), true)
  assert.equal(f.state().selectedId, 1)
  assert.equal(press(f.tabs.home, '2', { code: 'Digit2' }), true)
  assert.equal(press(f.tabs.home, 'r'), true)
  assert.equal(tab.reloads, 1)
  press(tab, '=')
  press(tab, '=')
  assert.equal(tab.zoom, 1)
  press(tab, '0')
  assert.equal(tab.zoom, 0)
  assert.equal(press(tab, 'c'), false, 'copy stays native')
  assert.equal(press(tab, 'w'), true)
  assert.equal(tab.closes.length, 1)
})

test('dialog owners and update broadcasts include tabs', () => {
  const f = fixture()
  const tab = f.open(`${BASE}/clients/1`)
  assert.equal(f.tabs.windowFor(tab), f.host)
  assert.equal(f.tabs.windowFor(f.tabs.home), f.host)
  assert.equal(f.tabs.windowFor(f.strip), null)
  assert.deepEqual(f.security.appContents(), [f.tabs.home, tab])
})

test('title, loading and route changes coalesce into one strip update', () => {
  const f = fixture()
  const tab = f.open(`${BASE}/clients/1`)
  const before = f.strip.sent.length
  tab.emit('did-start-loading')
  tab.emit('page-title-updated', {}, 'brinq | Law Office of Torres & Brenner')
  tab.emit('did-navigate-in-page', {}, `${BASE}/clients/1?view=files`, true)
  tab.emit('did-navigate-in-page', {}, 'https://evil.test/', true)
  assert.equal(f.queue.length, 1)
  f.flush()
  assert.equal(f.strip.sent.length, before + 1)
  const entry = f.state().tabs[1]
  assert.deepEqual([entry.label, entry.kind, entry.loading], ['Law Office of Torres & Brenner', 'client', true])
  f.tabs.select(entry.id)
  f.flush()
  assert.equal(f.host.titles.at(-1), 'Law Office of Torres & Brenner')
  let prevented = false
  f.strip.emit('page-title-updated', { preventDefault() { prevented = true } }, 'Brinq')
  assert.equal(prevented, true)
})

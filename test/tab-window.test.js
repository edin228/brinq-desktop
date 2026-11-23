const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createTabWindow, THEME_COLORS } = require('../src/tab-window')
const { createWindowSecurity } = require('../src/window-security')
const { createTabWindows, SHOW_FALLBACK_MS } = require('../src/tab-windows')

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
    isFocused() { return false },
    reload() { this.reloads++ },
    reloadIgnoringCache() { this.hardReloads++ },
    toggleDevTools() { this.devtools++ },
    getZoomLevel() { return this.zoom },
    setZoomLevel(level) { this.zoom = level },
    close(options) {
      this.closes.push(options)
      // A page still deciding: no answer until the test gives one.
      if (this.hang) return
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

function fixture({ platform = 'win32', theme = 'light', choice = 1, updateView, onUpdateCommand, onTabsChanged, registry = false } = {}) {
  const session = { setPermissionCheckHandler() {}, setPermissionRequestHandler() {} }
  const security = createWindowSecurity({ baseUrl: BASE, preloadPath: '/preload.js', openExternal() {} })
  const queue = []
  const flush = () => { while (queue.length) queue.shift()() }
  const app = { quitting: false, quitRequests: 0, stopped: 0 }
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
    isFocused() { return !this.blurred }
    isMinimized() { return !!this.minimized }
    minimize() { this.minimized = true; this.emit('minimize') }
    restore() { this.minimized = false }
    show() { this.visible = true }
    hide() { this.visible = false; this.emit('hide') }
    focus() { this.focusedCount = (this.focusedCount || 0) + 1 }
    getContentSize() { return [1200, 800] }
    getBounds() { return this.bounds || { x: 100, y: 100, width: 1200, height: 800 } }
    getContentBounds() { return this.contentBounds || { x: 100, y: 100, width: 1200, height: 800 } }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed') } }
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
  // Each popped-up menu keeps its template and where it opened.
  const menus = []
  const Menu = {
    buildFromTemplate: (template) => ({ popup: (options) => menus.push({ template, options }) }),
  }
  // Copy and open settle like Electron's; `fail` makes them reject.
  const copied = []
  const external = []
  const native = { fail: false }
  const settle = () => {
    if (native.fail === 'throw') throw new Error('unavailable')
    return native.fail ? Promise.reject(new Error('unavailable')) : Promise.resolve()
  }
  const clipboard = { writeText: (text) => { copied.push(text); return settle() } }
  // Every window shares the fakes; `extra` makes a secondary window.
  const makeWindow = (extra = {}) => createTabWindow({
    electron: { BrowserWindow, WebContentsView, dialog, Menu, clipboard },
    security, bounds: { width: 1200, height: 800 }, icon: '/icon.ico',
    preloadPath: '/preload.js', shellPreloadPath: '/shell-preload.js', shellUrl: SHELL,
    openExternal: (url) => { external.push(url); return settle() },
    theme, platform,
    // main.js always asks Home's page, whichever window the + was in.
    newTabUrl: (home) => home?.getURL() || `${BASE}/dashboard?standalone=full`,
    onTheme: (value) => themes.push(value),
    onHome: (contents, url) => {
      homes.push([contents, url])
      contents.loadURL(url || `${BASE}/dashboard?standalone=full`)
    },
    schedule: (fn) => queue.push(fn),
    now: () => clock.now,
    setTimer: (fn, ms) => clock.timers.push([clock.now + ms, fn]),
    isQuitting: () => app.quitting,
    requestQuit: () => { app.quitRequests++ },
    onQuitStopped: () => { app.stopped++; app.quitting = false },
    updateView, onUpdateCommand, onTabsChanged,
    ...extra,
  })
  // With `registry`, windows are made the way main.js makes them.
  const sessions = []
  const pointer = { at: null, busy: new Set() }
  const tabWindows = registry ? createTabWindows({
    create: (options) => makeWindow(options),
    placement: (source, open) => ({ ...source, x: source.x + 32, y: source.y + 32, open: open.length }),
    onTabsChanged: (value) => sessions.push(value),
    setTimer: (fn, ms) => clock.timers.push([clock.now + ms, fn]),
    isQuitting: () => app.quitting,
    // Drops: the test sets the pointer and which windows have a Save As open.
    cursorPoint: () => pointer.at,
    placeAt: (source, point) => ({ x: point.x - 120, y: point.y - 20, width: source.width, height: source.height }),
    canReceive: (window) => !pointer.busy.has(window),
  }) : null
  const tabs = registry ? tabWindows.addPrimary({ bounds: { width: 1200, height: 800 }, theme }) : makeWindow()
  const host = windows[0]
  // The strip is a child view; the window's own page stays empty.
  const strip = tabs.strip
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
  return { tabs, host, strip, security, session, windows, dialogs, homes, themes, flush, state, stripEvent, viewOf, open, fakeContents, queue, clock, app, menus, copied, external, native, makeWindow, BrowserWindow, tabWindows, sessions, pointer }
}

function tabIds(f) { return f.state().tabs.map((tab) => tab.id) }

// The tab menu of any tab window, as its own strip opens it.
function tabMenuOf(f, tabWindow, id) {
  const before = f.menus.length
  const shown = tabWindow.stripCommand(
    { sender: tabWindow.strip, senderFrame: tabWindow.strip.mainFrame }, 'menu', id, { x: 10, y: 10 })
  const menu = f.menus.length > before ? f.menus.at(-1) : null
  return { shown, menu, newWindow: menu?.template.find((item) => item.label === 'Open in new window') }
}

test('the window hosts a local strip and Home, a registered page below the strip', () => {
  const f = fixture({ theme: 'dark' })
  assert.equal(f.host.options.titleBarStyle, 'hidden')
  assert.deepEqual(f.host.options.titleBarOverlay, { ...THEME_COLORS.dark, height: 40 })
  assert.equal(f.host.options.backgroundColor, THEME_COLORS.dark.color)
  // The strip is a sandboxed child view across the top, below no tab page;
  // the window's own page stays empty.
  assert.equal(f.host.options.webPreferences.preload, undefined)
  assert.equal(f.host.options.webPreferences.sandbox, true)
  assert.deepEqual(f.host.webContents.loads, [])
  const stripView = f.viewOf(f.strip)
  assert.equal(f.host.children[0], stripView, 'the strip is the first child view')
  assert.equal(stripView.webPreferences.preload, '/shell-preload.js')
  assert.equal(stripView.webPreferences.sandbox, true)
  assert.equal(stripView.webPreferences.nodeIntegration, false)
  assert.deepEqual(stripView.bounds, { x: 0, y: 0, width: 1200, height: 40 })
  assert.equal(stripView.background, THEME_COLORS.dark.color)
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
  assert.equal(f.dialogs[0][1].message, 'Discard unsaved changes?')
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
  f.app.quitting = true
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

test('closing the window hides it; quitting closes every tab, then quits again', async () => {
  const f = fixture({ choice: 1 })
  const tab = f.open(`${BASE}/clients/1`)
  f.host.visible = true
  let prevented = false
  f.host.emit('close', { preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  assert.equal(f.host.visible, false, 'close hides to the tray')
  assert.equal(tab.isDestroyed(), false, 'hiding keeps every tab')
  f.app.quitting = true
  prevented = false
  f.host.emit('close', { preventDefault() { prevented = true } })
  assert.equal(prevented, true, 'the window waits for its tabs')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(tab.isDestroyed(), true)
  assert.equal(f.tabs.home.isDestroyed(), true)
  assert.equal(f.app.quitRequests, 1)
  prevented = false
  f.host.emit('close', { preventDefault() { prevented = true } })
  assert.equal(prevented, false, 'with no tabs left the window closes')
})

test('Stay during quit, or a quit stopped by another window, keeps the tabs', async () => {
  const f = fixture({ choice: 1 })
  const dirty = f.open(`${BASE}/clients/1`)
  dirty.veto = true
  f.app.quitting = true
  f.host.emit('close', { preventDefault() {} })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.app.stopped, 1)
  assert.equal(f.app.quitRequests, 0)
  assert.equal(dirty.isDestroyed(), false)

  const g = fixture()
  const first = g.open(`${BASE}/clients/1`)
  const second = g.open(`${BASE}/clients/2`)
  // An email pop-out vetoes the same quit while the first tab closes.
  first.on('destroyed', () => { g.app.quitting = false })
  g.app.quitting = true
  g.host.emit('close', { preventDefault() {} })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(first.isDestroyed(), true)
  assert.equal(second.isDestroyed(), false, 'remaining tabs are kept')
  assert.equal(g.tabs.home.isDestroyed(), false)
  assert.equal(g.app.stopped, 1)
  assert.equal(g.app.quitRequests, 0)

  // A pop-out's Stay can land while Home, the last page, is closing. The
  // loop finished, but the quit was stopped: it must not quit again (which
  // would ask the pop-out twice), and a stopped quit can bring Home back.
  const h = fixture()
  const other = h.open(`${BASE}/clients/1`)
  h.tabs.home.on('destroyed', () => { h.app.quitting = false })
  h.app.quitting = true
  h.host.emit('close', { preventDefault() {} })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(other.isDestroyed(), true)
  assert.equal(h.tabs.home.isDestroyed(), true)
  assert.equal(h.app.quitRequests, 0)
  assert.equal(h.app.stopped, 1)
  h.tabs.ensureHome()
  assert.equal(h.tabs.home.isDestroyed(), false)
})

test('closing from the strip keeps keyboard focus in the strip', () => {
  const f = fixture()
  const a = f.open(`${BASE}/clients/1`)
  const b = f.open(`${BASE}/clients/2`)
  const [, idA] = tabIds(f)
  f.tabs.select(idA)
  const before = b.focused
  f.tabs.stripCommand(f.stripEvent(), 'close', idA)
  f.flush()
  assert.equal(a.isDestroyed(), true)
  assert.equal(f.state().selectedId, tabIds(f)[1])
  assert.equal(b.focused, before, 'the next tab is selected without taking focus')
  f.tabs.closeTab(tabIds(f)[1])
  f.flush()
  assert.equal(f.tabs.home.focused > 0, true, 'a shortcut close focuses the next page')
})

test('tabs move by drag command or Ctrl+Shift+PageUp/PageDown; Home never moves', () => {
  const f = fixture()
  const label = (contents, title) => { contents.emit('page-title-updated', {}, title); f.flush() }
  label(f.open(`${BASE}/clients/1`), 'A')
  label(f.open(`${BASE}/clients/2`), 'B')
  label(f.open(`${BASE}/clients/3`), 'C')
  const labels = () => f.state().tabs.slice(1).map((tab) => tab.label)
  const idOf = (name) => f.state().tabs.find((tab) => tab.label === name).id
  assert.equal(f.tabs.stripCommand(f.stripEvent(), 'move', idOf('C'), { position: 1 }), true)
  f.flush()
  assert.deepEqual(labels(), ['C', 'A', 'B'])
  for (const bad of [{ position: '1' }, { position: 1.5 }, {}, null]) {
    assert.equal(f.tabs.stripCommand(f.stripEvent(), 'move', idOf('A'), bad), false)
  }
  assert.equal(f.tabs.stripCommand(f.stripEvent(), 'move', 1, { position: 3 }), false, 'Home stays first')
  assert.equal(f.tabs.stripCommand(f.stripEvent({ sender: f.tabs.home }), 'move', idOf('A'), { position: 3 }), false)
  f.tabs.select(idOf('C'))
  f.flush()
  const press = (key) => f.strip.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key, code: '', control: true, shift: true })
  press('PageDown')
  f.flush()
  assert.deepEqual(labels(), ['A', 'C', 'B'])
  press('PageUp')
  press('PageUp')
  f.flush()
  assert.deepEqual(labels(), ['C', 'A', 'B'], 'a tab cannot move before Home')
  assert.equal(f.state().selectedId, idOf('C'), 'moving keeps the selection')
  f.tabs.selectHome()
  press('PageDown')
  f.flush()
  assert.equal(f.state().tabs[0].home, true, 'Home does not move')
})

test('a link label names the next tab its page opens for that exact URL, once', () => {
  const f = fixture()
  f.tabs.home.mainFrame.url = `${BASE}/renewals`
  const event = { sender: f.tabs.home, senderFrame: f.tabs.home.mainFrame }
  const labelOf = (contents) => f.state().tabs.find((tab) => f.viewOf(contents) && tab.id === tabIds(f)[f.host.children.filter((view) => view.webContents !== f.strip).indexOf(f.viewOf(contents))])?.label
  const url = `${BASE}/clients/42?view=policies`
  assert.equal(f.tabs.linkLabel(event, { href: url, label: '  Acme\n Holdings ' }), true)
  const tab = f.open(url)
  assert.equal(labelOf(tab), 'Acme Holdings')
  tab.emit('did-navigate', {}, url)
  tab.emit('page-title-updated', {}, 'brinq')
  f.flush()
  assert.equal(labelOf(tab), 'Acme Holdings', 'a brand-only title keeps the link name')
  tab.emit('page-title-updated', {}, 'brinq | Acme Holdings, LLC')
  f.flush()
  assert.equal(labelOf(tab), 'Acme Holdings, LLC')
  tab.emit('page-title-updated', {}, 'brinq')
  f.flush()
  assert.equal(labelOf(tab), 'Client', 'once the page named itself, the link name is gone')
  assert.equal(f.host.titles.includes('Acme Holdings'), false, 'a background tab does not retitle the window')
  const second = f.open(url)
  assert.equal(labelOf(second), 'Client', 'the label was used once')
})

test('link labels expire, are replaced, stay with their page and need the exact URL', () => {
  const f = fixture()
  f.tabs.home.mainFrame.url = `${BASE}/renewals`
  const home = { sender: f.tabs.home, senderFrame: f.tabs.home.mainFrame }
  const labels = () => f.state().tabs.slice(1).map((tab) => tab.label)
  const url = `${BASE}/clients/42?view=policies`
  f.tabs.linkLabel(home, { href: url, label: 'Old' })
  f.clock.advance(2000)
  f.open(url)
  f.tabs.linkLabel(home, { href: url, label: 'First' })
  f.tabs.linkLabel(home, { href: url, label: 'Second' })
  f.open(url)
  f.tabs.linkLabel(home, { href: url, label: 'Mismatch' })
  f.open(`${BASE}/clients/43?view=policies`)
  f.open(url)
  assert.deepEqual(labels(), ['Client', 'Second', 'Client', 'Client'])
  const other = f.open(`${BASE}/renewals`)
  const fromTab = { sender: other, senderFrame: other.mainFrame }
  f.tabs.linkLabel(fromTab, { href: url, label: 'From tab' })
  f.open(url)
  assert.equal(labels().includes('From tab'), false, 'another page cannot use it')
  f.open(url, { opener: other })
  // A tab opened from another tab sits right after it.
  assert.equal(labels().filter((label) => label === 'From tab').length, 1)
  f.tabs.linkLabel(home, { href: url, label: 'Before navigation' })
  f.tabs.home.emit('did-start-navigation', {}, `${BASE}/emails`, false, true)
  f.tabs.home.emit('did-frame-navigate', {}, `${BASE}/emails`, 200, 'OK', true)
  f.open(url)
  assert.equal(labels().includes('Before navigation'), false, 'navigating the opener drops its label')
})

test('link labels are dropped when the tab goes to a different page', () => {
  const f = fixture()
  const home = { sender: f.tabs.home, senderFrame: f.tabs.home.mainFrame }
  const url = `${BASE}/clients/42?view=policies`
  f.tabs.linkLabel(home, { href: url, label: 'Acme Holdings' })
  const tab = f.open(url)
  const label = () => f.state().tabs.at(-1).label
  tab.emit('did-navigate', {}, url)
  f.flush()
  assert.equal(label(), 'Acme Holdings', 'the first load of the same URL keeps it')
  tab.emit('did-navigate-in-page', {}, `${BASE}/clients/42?view=files`, true)
  f.flush()
  assert.equal(label(), 'Client')
})

test('link labels come only from validated app pages with app URLs and text', () => {
  const f = fixture()
  const home = { sender: f.tabs.home, senderFrame: f.tabs.home.mainFrame }
  const url = `${BASE}/clients/42`
  for (const [event, payload] of [
    [{ sender: f.strip, senderFrame: f.strip.mainFrame }, { href: url, label: 'Acme' }],
    [{ ...home, senderFrame: { ...f.tabs.home.mainFrame } }, { href: url, label: 'Acme' }],
    [home, null], [home, [url, 'Acme']], [home, 'Acme'],
    [home, { href: 'https://evil.test/clients/42', label: 'Acme' }],
    [home, { href: 'http://user@localhost:3004/clients/42', label: 'Acme' }],
    [home, { href: 42, label: 'Acme' }],
    [home, { href: url, label: '   ' }], [home, { href: url, label: 7 }],
    [home, { href: url, label: 'a'.repeat(121) }],
  ]) assert.equal(f.tabs.linkLabel(event, payload), false, JSON.stringify(payload))
  f.open(url)
  assert.equal(f.state().tabs.at(-1).label, 'Client')
  f.host.close()
  assert.equal(f.tabs.linkLabel(home, { href: url, label: 'Acme' }), false)
})

test('the synchronous link-label reply is always sent: true only when stored', () => {
  const vm = require('node:vm')
  const fs = require('node:fs')
  const source = fs.readFileSync(require.resolve('../src/main'), 'utf8')
  const handler = source.slice(source.indexOf("ipcMain.on('link-label'"), source.indexOf("ipcMain.on('tabs:command'"))
  const handlers = new Map()
  const context = { ipcMain: { on: (channel, fn) => handlers.set(channel, fn) }, tabWindows: null }
  vm.createContext(context)
  vm.runInContext(handler, context)
  const reply = (tabWindow) => {
    context.tabWindows = tabWindow
    const event = {}
    handlers.get('link-label')(event, { href: 'x', label: 'y' })
    return event.returnValue
  }
  assert.equal(reply(null), false)
  assert.equal(reply({ linkLabel: () => true }), true)
  assert.equal(reply({ linkLabel: () => false }), false)
  assert.equal(reply({ linkLabel: () => { throw new Error('boom') } }), false)
})

// The tab menu as the strip opens it: one call per right-click or Menu key.
function tabMenu(f, id, point = { x: 120, y: 20 }) {
  const before = f.menus.length
  const shown = f.tabs.stripCommand(f.stripEvent(), 'menu', id, point)
  const menu = f.menus.length > before ? f.menus.at(-1) : null
  return {
    shown, menu,
    // The link items; the window item is checked on its own.
    items: menu?.template.slice(0, 2).map(({ label, enabled }) => [label, enabled]),
    copy: () => menu.template[0].click(),
    open: () => menu.template[1].click(),
    newWindow: menu?.template.find((item) => item.label === 'Open in new window'),
  }
}

test('the tab menu copies or opens the page the tab shows now, as a browser link', async () => {
  const f = fixture()
  // A client tab opened from an in-app link that carried the desktop mode,
  // then moved to a call recording without a full navigation.
  const tab = f.open(`${BASE}/clients/42?standalone=full`)
  const id = tabIds(f)[1]
  const recording = `${BASE}/clients/42/calls/rec_9?standalone=full&t=95#transcript`
  tab.mainFrame.url = recording
  tab.emit('did-navigate-in-page', {}, recording, true)
  const menu = tabMenu(f, id, { x: 312, y: 27 })
  assert.equal(menu.shown, true)
  assert.deepEqual(menu.items, [['Copy link', true], ['Open in browser', true]])
  const { callback, ...where } = menu.menu.options
  assert.deepEqual(where, { window: f.host, x: 312, y: 27, sourceType: 'mouse' })
  assert.equal(typeof callback, 'function')
  menu.copy()
  assert.deepEqual(f.copied, [`${BASE}/clients/42/calls/rec_9?t=95#transcript`])
  assert.deepEqual(f.external, [])
  menu.open()
  assert.deepEqual(f.external, [`${BASE}/clients/42/calls/rec_9?t=95#transcript`])
  f.flush()
  assert.equal(f.state().selectedId, 1, 'the menu does not select the tab')

  // Home, in either mode.
  tabMenu(f, 1).copy()
  assert.equal(f.copied.at(-1), `${BASE}/dashboard`)
  f.tabs.home.loadURL(`${BASE}/emails?standalone=email`)
  f.tabs.home.emit('did-navigate', {}, `${BASE}/emails?standalone=email`)
  tabMenu(f, 1).open()
  assert.equal(f.external.at(-1), `${BASE}/emails`)
  // A clipboard or browser that refuses is not an unhandled rejection.
  for (const fail of [true, 'throw']) {
    f.native.fail = fail
    tabMenu(f, 1).copy()
    tabMenu(f, 1).open()
  }
  await new Promise((resolve) => setImmediate(resolve))
})

test('a clicked tab menu gives focus back to the page; a keyboard one leaves it on the tab', () => {
  const f = fixture()
  const tab = f.open(`${BASE}/clients/1`, { background: false })
  const id = tabIds(f)[1]
  const focused = tab.focused
  // Right-click on another tab: the selected page gets focus back.
  tabMenu(f, 1).menu.options.callback()
  assert.equal(tab.focused, focused + 1)
  const keyboard = tabMenu(f, id, { x: 96, y: 36, keyboard: true }).menu.options
  assert.equal(keyboard.sourceType, 'keyboard')
  keyboard.callback()
  assert.equal(tab.focused, focused + 1)
  // Not when the user has moved to another app, or the page failed.
  f.host.blurred = true
  tabMenu(f, id).menu.options.callback()
  f.host.blurred = false
  tab.emit('did-fail-load', {}, -106, 'INTERNET_DISCONNECTED', `${BASE}/clients/1`, true)
  tabMenu(f, id).menu.options.callback()
  assert.equal(tab.focused, focused + 1)
})

test('the tab menu offers a link only for an approved app page', () => {
  const f = fixture()
  const tab = f.open(`${BASE}/clients/1`)
  const id = tabIds(f)[1]
  const disabled = [['Copy link', false], ['Open in browser', false]]
  // Before the page commits, the link is the approved page it is loading.
  tab.mainFrame.url = ''
  tabMenu(f, id).copy()
  assert.deepEqual(f.copied, [`${BASE}/clients/1`])
  // A failed or crashed tab shows the strip's panel, not a page.
  tab.emit('did-fail-load', {}, -106, 'INTERNET_DISCONNECTED', `${BASE}/clients/1`, true)
  assert.deepEqual(tabMenu(f, id).items, disabled)
  f.tabs.stripCommand(f.stripEvent(), 'retry', id)
  assert.deepEqual(tabMenu(f, id).items, [['Copy link', true], ['Open in browser', true]])
  tab.emit('render-process-gone', {}, { reason: 'crashed' })
  assert.deepEqual(tabMenu(f, id).items, disabled)
  // Home before its first page has no link.
  f.tabs.home.mainFrame.url = 'about:blank'
  assert.deepEqual(tabMenu(f, 1).items, disabled)
  f.tabs.home.mainFrame.url = 'chrome-error://chromewebdata/'
  assert.deepEqual(tabMenu(f, 1).items, disabled)
  assert.deepEqual(f.copied, [`${BASE}/clients/1`])
  assert.deepEqual(f.external, [])
})

test('tab menus come only from the strip, for known tabs, at whole points inside the strip', () => {
  const f = fixture()
  f.open(`${BASE}/clients/1`)
  const id = tabIds(f)[1]
  const denied = [
    f.stripEvent({ sender: f.tabs.home }),
    f.stripEvent({ senderFrame: { ...f.strip.mainFrame } }),
    f.stripEvent({ senderFrame: { ...f.strip.mainFrame, parent: {} } }),
    f.stripEvent({ senderFrame: null }),
  ]
  for (const event of denied) assert.equal(f.tabs.stripCommand(event, 'menu', id, { x: 10, y: 10 }), false)
  for (const bad of ['2', 2.5, -1, 999, null, NaN]) assert.equal(tabMenu(f, bad).shown, false)
  const points = [undefined, null, {}, { x: 10 }, { x: 1.5, y: 10 }, { x: 10, y: 0.5 }, { x: '10', y: 10 },
    { x: NaN, y: 10 }, { x: -1, y: 10 }, { x: 1201, y: 10 }, { x: 10, y: -1 }, { x: 10, y: 41 }, { x: 10, y: 800 }]
  for (const point of points) assert.equal(f.tabs.stripCommand(f.stripEvent(), 'menu', id, point), false, String(JSON.stringify(point)))
  assert.equal(f.menus.length, 0)
  for (const point of [{ x: 0, y: 0 }, { x: 1200, y: 40 }]) assert.equal(tabMenu(f, id, point).shown, true)
  // The link is main's own: anything else the strip sends is ignored.
  tabMenu(f, id, { x: 5, y: 5, url: 'https://evil.example/' }).copy()
  assert.deepEqual(f.copied, [`${BASE}/clients/1`])
  f.host.close()
  assert.equal(tabMenu(f, id).shown, false)
})

test('the header gets the update view and may send only the two fixed update commands', () => {
  let view = null
  const commands = []
  const f = fixture({ updateView: () => view, onUpdateCommand: (command) => commands.push(command) })
  assert.equal(f.state().update, null)
  view = { view: 'ready' }
  f.tabs.refreshUpdate()
  f.flush()
  assert.deepEqual(f.state().update, { view: 'ready' })
  // No tab id needed; anything passed along is ignored.
  assert.equal(f.tabs.stripCommand(f.stripEvent(), 'restart-update'), true)
  assert.equal(f.tabs.stripCommand(f.stripEvent(), 'retry-update', 999, { url: 'https://evil.example' }), true)
  assert.deepEqual(commands, ['restart-update', 'retry-update'])
  // Only the strip page itself may send them.
  const denied = [
    f.stripEvent({ sender: f.tabs.home }),
    f.stripEvent({ senderFrame: { ...f.strip.mainFrame, parent: {} } }),
    f.stripEvent({ senderFrame: null }),
  ]
  for (const event of denied) assert.equal(f.tabs.stripCommand(event, 'restart-update'), false)
  f.strip.mainFrame.url = `${BASE}/evil`
  assert.equal(f.tabs.stripCommand(f.stripEvent(), 'restart-update'), false)
  f.strip.mainFrame.url = SHELL
  assert.equal(f.tabs.stripCommand(f.stripEvent(), 'install-update'), false)
  f.host.close()
  assert.equal(f.tabs.stripCommand(f.stripEvent(), 'restart-update'), false)
  assert.deepEqual(commands, ['restart-update', 'retry-update'])
})

test('F6 and Shift+F6 move focus between the page and the header', () => {
  const f = fixture()
  const tab = f.open(`${BASE}/clients/1`, { background: false })
  const press = (contents, extra = {}) => {
    let prevented = false
    contents.emit('before-input-event', { preventDefault() { prevented = true } }, { type: 'keyDown', key: 'F6', code: 'F6', ...extra })
    return prevented
  }
  const requests = () => f.strip.sent.filter(([channel]) => channel === 'tabs:focus').map(([, mode]) => mode)
  const focusRequests = () => requests().length
  assert.equal(press(tab), true)
  assert.equal(f.strip.focused, 1)
  assert.equal(focusRequests(), 1)
  const before = tab.focused
  assert.equal(press(f.strip), true)
  assert.equal(tab.focused, before + 1, 'from the header, back to the selected page')
  assert.equal(press(tab, { shift: true }), true)
  assert.equal(focusRequests(), 2)
  assert.equal(press(f.tabs.home, { isAutoRepeat: true }), false, 'a held key moves once')
  assert.equal(press(tab, { control: true }), false, 'Ctrl+F6 is left alone')
  assert.deepEqual(requests(), ['header', 'header'])
  // A failed tab's panel lives in the strip: F6 there moves focus within it.
  tab.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', `${BASE}/clients/1`, true)
  f.flush()
  const pageFocus = tab.focused
  assert.equal(press(f.strip), true)
  assert.equal(tab.focused, pageFocus, 'the failed page is not focused')
  assert.deepEqual(requests().at(-1), 'toggle')
})

test('an abandoned quit settles its stuck close loop, so the next quit asks every page again', async () => {
  const f = fixture()
  const hung = f.open(`${BASE}/clients/1`)
  // A page that never answers its unsaved-work check.
  hung.close = function (options) { this.closes.push(options) }
  f.app.quitting = true
  f.host.emit('close', { preventDefault() {} })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(hung.closes.length, 1)
  const stuck = f.tabs.closeAllForQuit()
  // The watchdog gives up: the update owner stops quitting and abandons.
  f.app.quitting = false
  f.tabs.abandonQuit()
  assert.equal(await stuck, false)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.app.quitRequests, 0)
  assert.equal(hung.isDestroyed(), false)
  // A new attempt sends a new close request instead of joining the old loop.
  f.app.quitting = true
  f.host.emit('close', { preventDefault() {} })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(hung.closes.length, 2)
  f.tabs.abandonQuit()
})

// Startup tabs: restored tabs are added unloaded and load when first selected.
function restore(f, urls) {
  const added = f.tabs.restoreTabs(urls.map((url, index) => ({ url, label: `Section ${index + 1}` })))
  f.flush()
  // Restored views are the last ones added, in order.
  const views = f.host.children.slice(-added.length)
  return { added, contents: views.map((view) => view.webContents) }
}

test('restored tabs wait unloaded and unselected, then load once when selected', () => {
  const f = fixture()
  const { added, contents } = restore(f, [`${BASE}/emails`, `${BASE}/clients/7`])
  assert.deepEqual(added.map((tab) => tab.url), [`${BASE}/emails`, `${BASE}/clients/7`])
  assert.deepEqual(contents.map((wc) => wc.loads.length), [0, 0], 'nothing loads at restore')
  assert.equal(f.state().selectedId, 1, 'Home stays selected')
  const [email, client] = f.state().tabs.slice(1)
  assert.deepEqual([email.label, email.loading, client.label, client.loading], ['Section 1', false, 'Section 2', false])
  assert.equal(f.tabs.stripCommand(f.stripEvent(), 'select', email.id, { focus: true }), true)
  f.tabs.stripCommand(f.stripEvent(), 'select', email.id, { focus: true })
  assert.deepEqual(contents[0].loads.map(([url]) => url), [`${BASE}/emails`], 'selecting loads exactly once')
  f.flush()
  assert.equal(f.state().tabs[1].loading, true)
  // Ctrl+Tab onto the other restored tab loads it too.
  f.tabs.dispatch('next')
  assert.deepEqual(contents[1].loads.map(([url]) => url), [`${BASE}/clients/7`])
})

test('restoring never moves a broker who already left Home, and skips non-app addresses', () => {
  const f = fixture()
  const opened = f.open(`${BASE}/clients/1`, { background: false })
  const selected = f.state().selectedId
  const added = f.tabs.restoreTabs([{ url: 'https://evil.example/x', label: 'X' }, { url: `${BASE}/emails`, label: 'Email' }])
  f.flush()
  assert.deepEqual(added.map((tab) => tab.url), [`${BASE}/emails`])
  assert.equal(f.state().selectedId, selected)
  assert.equal(opened.loads.length, 1)
})

test('a restored tab closes without a prompt, and quitting never loads one', async () => {
  const f = fixture({ choice: 1 })
  const loaded = f.open(`${BASE}/clients/1`, { background: false })
  const { contents } = restore(f, [`${BASE}/emails`, `${BASE}/clients/7`])
  for (const wc of contents) wc.veto = true
  // Closing the selected loaded tab moves selection onto a restored tab during quit.
  f.app.quitting = true
  assert.equal(await f.tabs.closeAllForQuit(), true)
  assert.equal(loaded.isDestroyed(), true)
  assert.deepEqual(contents.map((wc) => wc.loads.length), [0, 0], 'quit loads no restored page')
  assert.deepEqual(contents.map((wc) => wc.closes), [[undefined], [undefined]], 'closed without waiting for an unload prompt')
  assert.equal(f.dialogs.length, 0)
})

test('a restored tab selected while quitting loads once the quit stops or is abandoned', async () => {
  const f = fixture()
  const { added, contents } = restore(f, [`${BASE}/emails`, `${BASE}/clients/7`])
  f.app.quitting = true
  f.tabs.select(added[0].id)
  assert.equal(contents[0].loads.length, 0)
  f.app.quitting = false
  f.tabs.select(added[0].id)
  assert.equal(contents[0].loads.length, 1, 'a normal select after Stay loads it')

  // A stuck quit that is abandoned resumes the selected restored tab.
  const hung = f.open(`${BASE}/clients/9`)
  hung.close = function (options) { this.closes.push(options) }
  f.app.quitting = true
  const stuck = f.tabs.closeAllForQuit()
  f.tabs.select(added[1].id)
  assert.equal(contents[1].loads.length, 0)
  f.app.quitting = false
  f.tabs.abandonQuit()
  assert.equal(await stuck, false)
  assert.equal(contents[1].loads.length, 1)
})

test('the tab list reports addresses in strip order, including restored tabs, never titles or selection', () => {
  const reports = []
  const f = fixture({ onTabsChanged: (state) => reports.push(state) })
  const opened = f.open(`${BASE}/clients/1`)
  opened.emit('page-title-updated', {}, 'brinq | Acme Holdings')
  const { added } = restore(f, [`${BASE}/emails`])
  f.flush()
  const expected = { tabs: [{ url: `${BASE}/clients/1` }, { url: `${BASE}/emails` }] }
  assert.deepEqual(reports.at(-1), expected)
  assert.deepEqual(f.tabs.getSessionState(), expected, 'the synchronous snapshot matches')
  f.tabs.stripCommand(f.stripEvent(), 'move', added[0].id, { position: 1 })
  f.flush()
  assert.deepEqual(f.tabs.getSessionState().tabs.map((tab) => tab.url), [`${BASE}/emails`, `${BASE}/clients/1`])
  f.tabs.closeTab(added[0].id)
  f.flush()
  assert.deepEqual(reports.at(-1), { tabs: [{ url: `${BASE}/clients/1` }] })
})

test('labels name only restored tabs that have not loaded; unavailable ones close without a prompt', () => {
  const f = fixture()
  const normal = f.open(`${BASE}/clients/2`)
  const urls = [`${BASE}/clients/7`, `${BASE}/emails/x`, `${BASE}/campaigns/c`]
  const { added, contents } = restore(f, urls)
  contents[1].veto = true
  f.tabs.select(added[2].id)
  const result = f.tabs.labelRestored([
    { url: urls[0], title: 'brinq | Acme Holdings' },
    { url: urls[1], unavailable: true },
    { url: urls[2], title: 'brinq | Spring renewals' },
    { url: `${BASE}/clients/2`, title: 'brinq | Not a restored tab' },
    { url: `${BASE}/clients/8`, title: 'brinq | Unknown' },
  ])
  f.flush()
  assert.deepEqual(result, { labeled: 1, closed: 1 })
  const labels = Object.fromEntries(f.state().tabs.map((tab) => [tab.id, tab.label]))
  assert.equal(labels[added[0].id], 'Acme Holdings')
  assert.equal(added[1].id in labels, false, 'the unavailable tab is gone')
  assert.deepEqual(contents[1].closes, [undefined])
  assert.equal(labels[added[2].id], 'Section 3', 'a loaded tab keeps its own naming')
  assert.equal(normal.loads.length, 1)
  f.app.quitting = true
  assert.deepEqual(f.tabs.labelRestored([{ url: urls[0], title: 'brinq | Later' }]), { labeled: 0, closed: 0 })
})

test('copy link on a restored tab gives the address it was restored with', async () => {
  const f = fixture()
  const { added } = restore(f, [`${BASE}/clients/7?standalone=full`])
  assert.equal(f.tabs.stripCommand(f.stripEvent(), 'menu', added[0].id, { x: 10, y: 10 }), true)
  const copy = f.menus.at(-1).template.find((item) => item.label === 'Copy link')
  assert.equal(copy.enabled, true)
  copy.click()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(f.copied, [`${BASE}/clients/7`])
})

test('a restored tab that fails to attach is undone; Home and earlier tabs stay', () => {
  const reports = []
  const f = fixture({ onTabsChanged: (state) => reports.push(state) })
  const register = f.security.register
  let calls = 0
  f.security.register = (...args) => {
    if (++calls === 2) throw new Error('attach failed')
    return register(...args)
  }
  const added = f.tabs.restoreTabs([`${BASE}/emails`, `${BASE}/clients/7`, `${BASE}/clients/8`].map((url) => ({ url, label: 'Section' })))
  f.flush()
  assert.deepEqual(added.map((tab) => tab.url), [`${BASE}/emails`], 'stops at the failure')
  assert.deepEqual(tabIds(f), [1, added[0].id], 'no orphan in the strip')
  assert.deepEqual(f.tabs.getSessionState(), { tabs: [{ url: `${BASE}/emails` }] })
  assert.equal(f.host.children.length, 3, 'the failed view was removed (strip, Home, one tab)')
  assert.deepEqual(reports.at(-1), { tabs: [{ url: `${BASE}/emails` }] })
})

// --- Several windows: Open in new window ----------------------------------

const KEY_NEW_WINDOW = { type: 'keyDown', key: 'N', code: 'KeyN', control: true, shift: true }
const press = (contents, input) => {
  let prevented = false
  contents.emit('before-input-event', { preventDefault() { prevented = true } }, input)
  return prevented
}
// The strip of any tab window, as the shell page sends from it.
const stripOf = (tabWindow) => tabWindow.strip
const eventFrom = (tabWindow) => ({ sender: stripOf(tabWindow), senderFrame: stripOf(tabWindow).mainFrame })
const stateOf = (tabWindow) => stripOf(tabWindow).sent.filter(([channel]) => channel === 'tabs:state').at(-1)?.[1]
const valid = (f, contents) => f.security.validateSender({ sender: contents, senderFrame: contents.mainFrame })

function moveFixture() {
  const f = fixture({ registry: true })
  const a = f.open(`${BASE}/clients/1`)
  const b = f.open(`${BASE}/emails?folder=inbox`)
  b.emit('page-title-updated', {}, 'Inbox')
  f.flush()
  return { f, a, b, ids: tabIds(f) }
}

test('open in new window moves the live page into a new window with its own strip, without reloading', () => {
  const { f, a, b, ids } = moveFixture()
  f.tabs.select(ids[2])
  f.flush()
  const loads = b.loads.length
  const listeners = b.listenerCount('before-input-event')
  assert.equal(f.tabWindows.moveToNewWindow(f.tabs, ids[2]), true)
  f.flush()
  const [primary, second] = f.tabWindows.all()
  assert.equal(primary, f.tabs)
  // Same page, not reloaded, now under the new window's strip.
  assert.equal(b.loads.length, loads)
  assert.equal(b.isDestroyed(), false)
  assert.equal(f.viewOf(b), undefined)
  assert.equal(second.window.children.some((view) => view.webContents === b), true)
  assert.equal(b.listenerCount('before-input-event'), listeners, 'the old window left no handlers behind')
  // The new strip shows the tab, selected, with no Home; the main strip lost it.
  const moved = stateOf(second)
  assert.equal(moved.hasHome, false)
  assert.deepEqual(moved.tabs.map(({ label, home }) => [label, home]), [['Inbox', false]])
  assert.equal(moved.selectedId, moved.tabs[0].id)
  assert.equal(second.window.titles.at(-1), 'Inbox')
  assert.deepEqual(f.state().tabs.map(({ id }) => id), [1, ids[1]])
  assert.equal(f.state().hasHome, true)
  // The main window selects a neighbour without taking focus from the new one.
  assert.equal(f.state().selectedId, ids[1])
  assert.equal(f.viewOf(a).visible, true)
  // Same theme and title-bar overlay as the window it came from.
  assert.deepEqual(second.window.options.titleBarOverlay, { ...THEME_COLORS.light, height: 40 })
  assert.equal(second.window.options.webPreferences.sandbox, true)
  // Shown once its strip has loaded, or after the fallback.
  assert.equal(second.window.visible, false)
  second.strip.emit('did-finish-load')
  assert.equal(second.window.visible, true)
  f.clock.advance(SHOW_FALLBACK_MS)
  // The page's title and loading now reach only its new window.
  b.emit('page-title-updated', {}, 'Inbox (3)')
  f.flush()
  assert.equal(stateOf(second).tabs[0].label, 'Inbox (3)')
  assert.equal(f.state().tabs.some((tab) => tab.label === 'Inbox (3)'), false)
})

test('a moved page keeps its authority until its new window closes, not its old one', () => {
  const { f, b, ids } = moveFixture()
  f.tabWindows.moveToNewWindow(f.tabs, ids[2])
  f.flush()
  const second = f.tabWindows.all()[1]
  assert.equal(valid(f, b), true)
  // The page's unsaved-work prompt belongs to its new window.
  b.veto = true
  second.closeTab(stateOf(second).tabs[0].id)
  assert.equal(f.dialogs.at(-1)[0], second.window)
  b.veto = false
  // Closing the window it came from does not take its authority.
  f.host.destroy()
  assert.equal(valid(f, b), true)
  second.window.destroy()
  assert.equal(valid(f, b), false)
})

test('Home, a closing tab, the only tab of a secondary window and a busy page stay put', () => {
  const { f, a, ids } = moveFixture()
  assert.equal(f.tabs.movable(1), false)
  assert.equal(f.tabWindows.moveToNewWindow(f.tabs, 1), false)
  assert.equal(tabMenu(f, 1).newWindow.enabled, false)
  // Ctrl+Shift+N on Home does nothing, but the key is still taken.
  assert.equal(press(f.tabs.home, KEY_NEW_WINDOW), true)
  assert.equal(f.tabWindows.all().length, 1)
  // A closing tab.
  a.veto = true
  f.tabs.closeTab(ids[1])
  assert.equal(f.tabs.movable(ids[1]), true, 'Stay ended the close')
  // A quit in progress.
  f.app.quitting = true
  assert.equal(f.tabs.movable(ids[1]), false)
  f.app.quitting = false
  // The only tab of a secondary window: moving it would only replace its window.
  f.tabWindows.moveToNewWindow(f.tabs, ids[2])
  f.flush()
  const second = f.tabWindows.all()[1]
  const only = stateOf(second).tabs[0].id
  assert.equal(second.movable(only, { newWindow: true }), false)
  assert.equal(second.movable(only), true, 'it can still join another window')
  assert.equal(f.tabWindows.moveToNewWindow(second, only), false)
  assert.equal(tabMenuOf(f, second, only).newWindow.enabled, false)
  assert.equal(f.tabWindows.all().length, 2)
  // A page main reports busy (a Save As dialog open) waits for it.
  let busy = true
  const other = f.makeWindow({ primary: false, canMove: (contents) => !(busy && contents === a) })
  other.adoptTab(f.tabs.detachTab(ids[1]))
  const extra = f.open(`${BASE}/clients/8`)
  other.adoptTab(f.tabs.detachTab(tabIds(f)[1]))
  f.flush()
  const [aId, extraId] = stateOf(other).tabs.map(({ id }) => id)
  assert.equal(other.isTab(extra), true)
  assert.equal(other.movable(aId, { newWindow: true }), false)
  assert.equal(tabMenuOf(f, other, aId).newWindow.enabled, false)
  assert.equal(other.movable(extraId, { newWindow: true }), true)
  busy = false
  assert.equal(other.movable(aId, { newWindow: true }), true)
})

test('the tab menu and Ctrl+Shift+N both move the selected tab', () => {
  const { f, a, b, ids } = moveFixture()
  const item = tabMenu(f, ids[1]).newWindow
  assert.equal(item.enabled, true)
  assert.equal(item.accelerator, 'CmdOrCtrl+Shift+N')
  assert.equal(item.registerAccelerator, false)
  item.click()
  f.flush()
  assert.equal(f.tabWindows.all().length, 2)
  assert.equal(f.tabWindows.isTab(a), true)
  assert.equal(f.tabs.isTab(a), false)
  // The shortcut acts on the selected tab of the window it was pressed in.
  f.tabs.select(ids[2])
  assert.equal(press(b, KEY_NEW_WINDOW), true)
  f.flush()
  assert.equal(f.tabWindows.all().length, 3)
  assert.equal(f.tabs.isTab(b), false)
  assert.deepEqual(f.state().tabs.map(({ id }) => id), [1])
  // A menu left open while its tab moved does nothing.
  const c = f.open(`${BASE}/clients/9`)
  const stale = tabMenu(f, tabIds(f)[1]).newWindow
  f.tabWindows.moveToNewWindow(f.tabs, tabIds(f)[1])
  stale.click()
  f.flush()
  assert.equal(f.tabWindows.all().length, 4)
  assert.equal(f.tabWindows.isTab(c), true)
})

test('a secondary window closes when its last tab closes or moves away', () => {
  const { f, a, b, ids } = moveFixture()
  f.tabWindows.moveToNewWindow(f.tabs, ids[1])
  f.flush()
  const second = f.tabWindows.all()[1]
  // Move the second tab into it by hand, then split them again.
  const moved = f.tabs.detachTab(ids[2])
  second.adoptTab(moved)
  f.flush()
  assert.deepEqual(stateOf(second).tabs.map(({ label }) => label), ['Client', 'Inbox'])
  f.tabWindows.moveToNewWindow(second, stateOf(second).tabs[1].id)
  f.flush()
  const third = f.tabWindows.all()[2]
  assert.equal(third.isTab(b), true)
  // Closing the last tab closes its window.
  a.destroy()
  f.flush()
  assert.equal(second.window.isDestroyed(), true)
  assert.deepEqual(f.tabWindows.all(), [f.tabs, third])
  // Moving its last tab into another window does too.
  f.tabs.adoptTab(third.detachTab(stateOf(third).tabs[0].id))
  third.closeIfEmpty()
  assert.equal(third.window.isDestroyed(), true)
  assert.equal(f.tabs.isTab(b), true)
  assert.deepEqual(f.tabWindows.all(), [f.tabs])
})

test('a failed move puts the tab back where it was, as it was', () => {
  const { f, b, ids } = moveFixture()
  f.tabs.select(ids[2])
  f.flush()
  const before = tabIds(f)
  // The new window cannot take the page (it went away first).
  const original = f.makeWindow
  const failing = f.tabWindows
  let created = null
  const registry = createTabWindows({
    create: (options) => {
      created = original(options)
      created.adoptTab = () => { throw new Error('boom') }
      return created
    },
  })
  assert.ok(failing)
  // Use the main window as the source through a second registry.
  assert.equal(registry.moveToNewWindow(f.tabs, ids[2]), false)
  f.flush()
  assert.equal(created.window.isDestroyed(), true)
  assert.equal(b.isDestroyed(), false)
  assert.equal(f.tabs.isTab(b), true)
  assert.equal(tabIds(f).length, before.length)
  assert.equal(f.state().tabs.at(-1).label, 'Inbox', 'back in its place')
  assert.equal(f.state().selectedId, tabIds(f).at(-1), 'and selected again')
  assert.equal(valid(f, b), true)
  assert.equal(f.viewOf(b).visible, true)
})

test('each strip commands only its own window, and new tabs open in their opener\'s window', () => {
  const { f, a, b, ids } = moveFixture()
  f.tabWindows.moveToNewWindow(f.tabs, ids[2])
  f.flush()
  const second = f.tabWindows.all()[1]
  const movedId = stateOf(second).tabs[0].id
  // Ids are per window: the main strip cannot reach the moved tab.
  assert.equal(f.tabWindows.stripCommand(f.stripEvent(), 'close', 999), false)
  assert.equal(f.tabWindows.stripState(eventFrom(second)).tabs.length, 1)
  assert.equal(f.tabWindows.stripCommand(eventFrom(second), 'home'), false)
  assert.equal(f.tabWindows.stripCommand({ sender: b, senderFrame: b.mainFrame }, 'new'), false)
  assert.equal(f.tabWindows.stripState({ sender: a, senderFrame: a.mainFrame }), null)
  // A tab opened from the moved page joins it; one from Home stays in main.
  const child = f.tabWindows.openTab({ opener: b, url: `${BASE}/emails/7`, background: true, options: {} })
  f.flush()
  assert.equal(second.isTab(child), true)
  assert.equal(f.tabs.isTab(child), false)
  const fromHome = f.tabWindows.openTab({ opener: f.tabs.home, url: `${BASE}/clients/5`, background: true, options: {} })
  assert.equal(f.tabs.isTab(fromHome), true)
  // Theme reports repaint the window that owns the page.
  f.tabWindows.reportTheme(b, 'dark')
  f.flush()
  assert.equal(stateOf(second).theme, 'dark')
  assert.equal(f.state().theme, 'light')
  // The + button in a secondary window opens Home's page there.
  f.tabWindows.stripCommand(eventFrom(second), 'new')
  f.flush()
  assert.equal(stateOf(second).tabs.length, 3)
  // Positions count Home as 0 in every window: dropping at 1 is first.
  const last = stateOf(second).tabs.at(-1).id
  assert.equal(f.tabWindows.stripCommand(eventFrom(second), 'move', last, { position: 1 }), true)
  f.flush()
  assert.equal(stateOf(second).tabs[0].id, last)
  assert.ok(movedId)
  // Dialogs for a tab page belong to its window.
  assert.equal(f.tabWindows.windowFor(b), second.window)
  assert.equal(f.tabWindows.windowFor(a), f.host)
  // The updater's view reaches every strip.
  const sent = stripOf(second).sent.length
  f.tabWindows.refreshUpdate()
  f.flush()
  assert.ok(stripOf(second).sent.length > sent)
})

test('a link label waits in the window that opens its tab, and leaves with a moved page', () => {
  const { f, b, ids } = moveFixture()
  const url = `${BASE}/emails/42`
  const event = { sender: b, senderFrame: b.mainFrame }
  assert.equal(f.tabWindows.linkLabel(event, { href: url, label: 'Quote request' }), true)
  // The page moves before it opens anything: the label goes with nothing.
  f.tabWindows.moveToNewWindow(f.tabs, ids[2])
  f.flush()
  const second = f.tabWindows.all()[1]
  const opened = f.tabWindows.openTab({ opener: b, url, background: true, options: {} })
  f.flush()
  assert.equal(second.isTab(opened), true)
  assert.equal(stateOf(second).tabs.at(-1).label, 'Email')
  // A label sent from its new window names its next tab there.
  assert.equal(f.tabWindows.linkLabel(event, { href: `${BASE}/emails/43`, label: 'Renewal' }), true)
  f.tabWindows.openTab({ opener: b, url: `${BASE}/emails/43`, background: true, options: {} })
  f.flush()
  assert.equal(stateOf(second).tabs.at(-1).label, 'Renewal')
  assert.equal(b.listenerCount('did-start-navigation') >= 1, true)
})

test('startup tabs see every window\'s tabs, main first; restored labels reach a moved tab', () => {
  const { f, ids } = moveFixture()
  const restored = f.tabs.restoreTabs([{ url: `${BASE}/clients/77` }])
  f.flush()
  f.tabWindows.moveToNewWindow(f.tabs, ids[1])
  f.flush()
  assert.deepEqual(f.tabWindows.getSessionState().tabs.map(({ url }) => url),
    [`${BASE}/emails?folder=inbox`, `${BASE}/clients/77`, `${BASE}/clients/1`])
  assert.deepEqual(f.sessions.at(-1).tabs.map(({ url }) => url), f.tabWindows.getSessionState().tabs.map(({ url }) => url))
  // A restored tab moved before it ever loaded loads once, in its new window.
  const restoredId = restored[0].id
  f.tabWindows.moveToNewWindow(f.tabs, restoredId)
  f.flush()
  const third = f.tabWindows.all()[2]
  assert.equal(third.tabCount(), 1)
  assert.equal(f.tabWindows.labelRestored([{ url: `${BASE}/clients/77`, title: 'Acme' }]).labeled, 0, 'it loaded on selection')
  assert.equal(f.tabWindows.home, f.tabs.home)
})

test('the strip covers the window only while the selected tab shows the failure panel', () => {
  const f = fixture()
  const tab = f.open(`${BASE}/clients/1`, { background: false })
  const stripView = f.viewOf(f.strip)
  assert.deepEqual(stripView.bounds, { x: 0, y: 0, width: 1200, height: 40 })
  tab.emit('did-fail-load', {}, -106, 'INTERNET_DISCONNECTED', `${BASE}/clients/1`, true)
  assert.equal(f.viewOf(tab).visible, false)
  assert.deepEqual(stripView.bounds, { x: 0, y: 0, width: 1200, height: 800 })
  // Home selected: the strip is a bar again, and Home shows.
  f.tabs.selectHome()
  assert.deepEqual(stripView.bounds, { x: 0, y: 0, width: 1200, height: 40 })
  assert.equal(f.viewOf(f.tabs.home).visible, true)
  f.tabs.select(tabIds(f)[1])
  assert.equal(stripView.bounds.height, 800)
  f.tabs.stripCommand(f.stripEvent(), 'retry', tabIds(f)[1])
  assert.equal(stripView.bounds.height, 40)
  assert.equal(f.viewOf(tab).visible, true)
})

// --- Several windows: one close path (S) ------------------------------------

const tick = () => new Promise((resolve) => setImmediate(resolve))
const closeEvent = () => {
  const event = { prevented: false, preventDefault() { event.prevented = true } }
  return event
}
// Main with Home and one tab, and a secondary window holding two tabs.
function twoWindows(options = {}) {
  const f = fixture({ registry: true, ...options })
  const mainTab = f.open(`${BASE}/clients/1`)
  const a = f.open(`${BASE}/emails?folder=inbox`)
  const b = f.open(`${BASE}/clients/2`)
  f.tabWindows.moveToNewWindow(f.tabs, tabIds(f)[2])
  f.flush()
  const second = f.tabWindows.all()[1]
  second.adoptTab(f.tabs.detachTab(tabIds(f)[2]), { select: false })
  f.flush()
  return { f, mainTab, a, b, second }
}

test('a secondary window\'s close button gives its tabs back to the main window, live', () => {
  const { f, a, b, second } = twoWindows()
  assert.deepEqual(stateOf(second).tabs.map(({ label }) => label), ['Email', 'Client'])
  const loads = a.loads.length + b.loads.length
  f.host.visible = false
  const event = closeEvent()
  second.window.emit('close', event)
  f.flush()
  assert.equal(event.prevented, true, 'the window waits until its tabs have moved')
  assert.equal(second.window.isDestroyed(), true)
  assert.deepEqual(f.tabWindows.all(), [f.tabs])
  // After the main window's own tabs, in order; the tab that was selected
  // there is selected here, and the main window comes forward.
  assert.deepEqual(f.state().tabs.map(({ label }) => label), ['Brinq', 'Client', 'Email', 'Client'])
  assert.equal(f.tabs.isTab(a) && f.tabs.isTab(b), true)
  assert.equal(f.state().selectedId, tabIds(f)[2])
  assert.equal(f.host.visible, true)
  assert.equal(a.loads.length + b.loads.length, loads, 'nothing reloaded')
  assert.equal(f.dialogs.length, 0, 'nothing asked')
  assert.equal(valid(f, a), true)
})

test('while any page\'s close is unanswered, no tab moves in any window, close button included', () => {
  const { f, a, b, second } = twoWindows()
  a.hang = true
  second.closeTab(stateOf(second).tabs[0].id)
  assert.equal(f.tabs.movable(tabIds(f)[1]), false)
  assert.equal(f.tabWindows.moveToNewWindow(f.tabs, tabIds(f)[1]), false)
  assert.equal(tabMenu(f, tabIds(f)[1]).newWindow.enabled, false)
  const held = closeEvent()
  second.window.emit('close', held)
  f.flush()
  assert.equal(held.prevented, true)
  assert.equal(second.isTab(b) && second.isTab(a), true, 'nothing moved')
  // The page lets go; its window still has the other tab, which the next
  // close moves back.
  a.destroy()
  f.flush()
  assert.equal(f.tabs.movable(tabIds(f)[1]), true)
  second.window.emit('close', closeEvent())
  f.flush()
  assert.equal(f.tabs.isTab(b), true)
  assert.equal(second.window.isDestroyed(), true)
})

test('during a quit no tab moves and no new window opens', () => {
  const { f } = moveFixture()
  f.app.quitting = true
  assert.equal(f.tabs.movable(tabIds(f)[1]), false)
  assert.equal(f.tabWindows.moveToNewWindow(f.tabs, tabIds(f)[1]), false)
  assert.equal(f.tabWindows.quitting(), true)
  assert.equal(f.tabWindows.all().length, 1)
})

test('a move that fails leaves the source exactly as it was: no neighbour loads', () => {
  const f = fixture({ registry: true })
  const live = f.open(`${BASE}/clients/1`)
  const [restored] = f.tabs.restoreTabs([{ url: `${BASE}/clients/2` }])
  f.flush()
  // The live tab is selected, the restored one after it waits unloaded.
  f.tabs.select(tabIds(f)[1])
  f.flush()
  const restoredPage = [...f.host.children].map((view) => view.webContents).find((wc) => !wc.loads.length && wc !== f.strip)
  const registry = createTabWindows({
    create: (options) => {
      const made = f.makeWindow(options)
      made.adoptTab = () => { throw new Error('boom') }
      return made
    },
  })
  assert.equal(registry.moveToNewWindow(f.tabs, tabIds(f)[1]), false)
  f.flush()
  assert.equal(restoredPage.loads.length, 0, 'the restored neighbour was never selected')
  assert.equal(f.tabs.isTab(live), true)
  assert.equal(f.state().selectedId, tabIds(f)[1])
  assert.ok(restored)
})

test('Brinq does not quit while another window has tabs; given back, it quits from the main window as before', async () => {
  const { f, a, b, second } = twoWindows({ choice: 0 })
  assert.equal(f.tabWindows.blocksQuit(), true)
  // Closing the other window gives its tabs back; then nothing blocks.
  second.window.emit('close', closeEvent())
  f.flush()
  assert.equal(f.tabWindows.blocksQuit(), false)
  a.veto = true
  b.veto = true
  f.app.quitting = true
  f.host.emit('close', closeEvent())
  await tick()
  f.flush()
  assert.equal(a.isDestroyed() && b.isDestroyed() && f.tabs.home.isDestroyed(), true)
  assert.deepEqual(f.dialogs.map(([owner]) => owner), [f.host, f.host], 'one prompt per page, in the main window')
  assert.equal(f.app.quitRequests, 1)
})

test('an empty secondary window never blocks a quit, and a secondary window never runs a close loop', () => {
  const { f, a, b, second } = twoWindows()
  f.app.quitting = true
  const held = closeEvent()
  second.window.emit('close', held)
  assert.equal(held.prevented, true, 'with tabs it waits (the quit guard refuses such a quit first)')
  assert.equal(a.closes.length + b.closes.length, 0, 'and asks no page')
  f.app.quitting = false
  a.destroy()
  b.destroy()
  f.flush()
  assert.equal(second.window.isDestroyed(), true)
  assert.equal(f.tabWindows.blocksQuit(), false)
})

test('during a quit, + and Ctrl+T open nothing and the link menu cannot open a tab', () => {
  const { f } = moveFixture()
  const before = tabIds(f).length
  f.app.quitting = true
  f.tabWindows.stripCommand(f.stripEvent(), 'new')
  press(f.tabs.home, { type: 'keyDown', key: 't', code: 'KeyT', control: true })
  f.flush()
  assert.equal(tabIds(f).length, before)
  assert.equal(f.tabWindows.canOpenTab(), false)
  f.app.quitting = false
  assert.equal(f.tabWindows.canOpenTab(), true)
})

test('a window activated by the system gives keyboard focus back to the strip or the selected page', () => {
  const { f, a, ids } = moveFixture()
  f.tabs.select(ids[1])
  f.flush()
  const focused = a.focused
  // Windows focused the window's own, empty page.
  f.host.webContents.isFocused = () => true
  f.host.emit('focus')
  f.flush()
  assert.equal(a.focused, focused + 1)
  // The strip had focus last: it gets it back.
  let stripFocus = 0
  f.strip.focus = () => { stripFocus++ }
  f.strip.emit('focus')
  f.host.emit('focus')
  f.flush()
  assert.equal(stripFocus, 1)
  // Focus already in a child view: nothing changes.
  f.host.webContents.isFocused = () => false
  f.host.emit('focus')
  f.flush()
  assert.equal(stripFocus, 1)
  assert.equal(a.focused, focused + 1)
})

test('keyboard reordering works in a window without Home', () => {
  const { f, second } = twoWindows()
  const [first, last] = stateOf(second).tabs.map(({ id }) => id)
  second.select(first)
  second.dispatch('move-right')
  f.flush()
  assert.deepEqual(stateOf(second).tabs.map(({ id }) => id), [last, first])
  second.dispatch('move-left')
  f.flush()
  assert.deepEqual(stateOf(second).tabs.map(({ id }) => id), [first, last])
  second.dispatch('move-left')
  f.flush()
  assert.deepEqual(stateOf(second).tabs.map(({ id }) => id), [first, last], 'already first')
})

test('a failed move keeps the tab\'s id and its place among the tabs it opened', () => {
  const f = fixture({ registry: true })
  const parent = f.open(`${BASE}/clients/1`)
  const parentId = tabIds(f)[1]
  f.open(`${BASE}/clients/1/a`, { opener: parent })
  const registry = createTabWindows({
    create: (options) => {
      const made = f.makeWindow(options)
      made.adoptTab = () => { throw new Error('boom') }
      return made
    },
  })
  assert.equal(registry.moveToNewWindow(f.tabs, parentId), false)
  f.flush()
  assert.equal(tabIds(f)[1], parentId, 'same id, same place')
  // A new link from the parent still lands after its earlier child.
  f.open(`${BASE}/clients/1/b`, { opener: parent })
  f.flush()
  assert.deepEqual(f.tabs.getSessionState().tabs.map(({ url }) => url),
    [`${BASE}/clients/1`, `${BASE}/clients/1/a`, `${BASE}/clients/1/b`])
  assert.equal(valid(f, parent), true)
  assert.equal(f.viewOf(parent).webContents, parent)
})

// Dragging a tab out of its strip. Main and a secondary window side by side,
// both shown, strips loaded; main has Home and one tab, the secondary two.
function dropWindows() {
  const w = twoWindows()
  const { f, second } = w
  f.host.contentBounds = { x: 0, y: 0, width: 1200, height: 800 }
  second.window.contentBounds = { x: 1300, y: 0, width: 1200, height: 800 }
  f.host.show()
  second.window.show()
  f.strip.emit('did-finish-load')
  second.strip.emit('did-finish-load')
  return w
}
// A drag of tab `id` in `from`'s strip, let go with the pointer at `at`:
// a press main saw, the strip's drag start, then its drag end.
function dragOut(f, from, id, at, { press = true } = {}) {
  if (press) from.strip.emit('input-event', {}, { type: 'mouseDown', button: 'left' })
  const started = from.stripCommand(eventFrom(from), 'drag-start', id)
  f.pointer.at = at
  const ended = from.stripCommand(eventFrom(from), 'drag-end', id)
  return { started, ended }
}
const slotAsked = (tabWindow) => tabWindow.strip.sent.filter(([channel]) => channel === 'tabs:slot').at(-1)?.[1]
const answerSlot = (tabWindow, index, order = tabWindow.tabIds(), requestId = slotAsked(tabWindow)?.requestId) =>
  tabWindow.stripCommand(eventFrom(tabWindow), 'slot', undefined, { requestId, index, order })
const settled = () => new Promise((resolve) => setImmediate(resolve))
const labels = (tabWindow) => stateOf(tabWindow).tabs.map(({ label }) => label)

test('a tab dragged onto another window\'s strip joins it where that strip says, live', async () => {
  const { f, mainTab, second } = dropWindows()
  const loads = mainTab.loads.length
  const id = tabIds(f)[1]
  assert.deepEqual(dragOut(f, f.tabs, id, { x: 1300 + 250, y: 12 }), { started: true, ended: true })
  // The target strip is asked where, at its own x, before anything moves.
  assert.equal(slotAsked(second).x, 250)
  assert.equal(f.tabs.isTab(mainTab), true)
  assert.equal(answerSlot(second, 1), true)
  await settled()
  f.flush()
  assert.equal(second.isTab(mainTab), true)
  assert.equal(f.tabs.isTab(mainTab), false)
  assert.deepEqual(labels(second), ['Email', 'Client', 'Client'])
  assert.equal(stateOf(second).tabs[1].id, stateOf(second).selectedId, 'selected where it landed')
  assert.equal(mainTab.loads.length, loads, 'not reloaded')
  assert.equal(second.window.focusedCount > 0, true)
  assert.equal(valid(f, mainTab), true)
  assert.deepEqual(tabIds(f), [1])
})

test('the only tab of a secondary window can be dropped into the main strip; its window closes', async () => {
  const { f, a, b, second } = dropWindows()
  second.closeTab(stateOf(second).tabs[1].id)
  f.flush()
  assert.equal(second.tabCount(), 1)
  dragOut(f, second, stateOf(second).tabs[0].id, { x: 300, y: 20 })
  answerSlot(f.tabs, 0)
  await settled()
  f.flush()
  assert.equal(f.tabs.isTab(a), true)
  assert.deepEqual(f.state().tabs.map(({ label }) => label), ['Brinq', 'Email', 'Client'])
  assert.equal(second.window.isDestroyed(), true)
  assert.equal(b.isDestroyed(), true)
})

test('a tab let go away from any strip opens in a new window there; a secondary\'s only tab snaps back', async () => {
  const { f, mainTab, second } = dropWindows()
  const id = tabIds(f)[1]
  // Over the main window's own page: a new window, under the pointer.
  dragOut(f, f.tabs, id, { x: 600, y: 400 })
  f.flush()
  const third = f.tabWindows.all()[2]
  assert.equal(third.isTab(mainTab), true)
  assert.deepEqual(third.window.options.x, 480)
  assert.deepEqual(third.window.options.y, 380)
  // No slot was asked of anyone.
  assert.equal(slotAsked(f.tabs), undefined)
  // Its only tab dropped on the desktop: refused, nothing opens.
  third.window.contentBounds = { x: 0, y: 900, width: 800, height: 600 }
  third.window.show()
  dragOut(f, third, stateOf(third).tabs[0].id, { x: 3000, y: 50 })
  f.flush()
  assert.equal(f.tabWindows.all().length, 3)
  assert.equal(third.isTab(mainTab), true)
  // Over its own strip: nothing happens either.
  dragOut(f, second, stateOf(second).tabs[0].id, { x: 1300 + 200, y: 10 })
  f.flush()
  assert.equal(slotAsked(second), undefined)
  assert.equal(second.tabCount(), 2)
})

test('the window in front takes the drop: a covered strip never does', async () => {
  const { f, second } = dropWindows()
  // The secondary window overlaps the main one; its strip lies over main's page.
  second.window.contentBounds = { x: 100, y: 100, width: 1200, height: 800 }
  const id = tabIds(f)[1]
  const point = { x: 300, y: 110 }
  // Main focused last: its page is in front there, so the tab opens a window.
  second.window.emit('focus')
  f.host.emit('focus')
  dragOut(f, f.tabs, id, point)
  f.flush()
  assert.equal(slotAsked(second), undefined)
  assert.equal(f.tabWindows.all().length, 3)
  // The secondary window in front: its strip is asked.
  const third = f.tabWindows.all()[2]
  third.window.contentBounds = { x: 2000, y: 2000, width: 10, height: 10 }
  second.window.emit('focus')
  dragOut(f, third, stateOf(third).tabs[0].id, point)
  assert.equal(slotAsked(second).x, 200)
})

test('a drop counts only inside a press main saw, for the strip document and tab it started with', async () => {
  const { f, mainTab, second } = dropWindows()
  const id = tabIds(f)[1]
  const into = { x: 1300 + 250, y: 12 }
  // No press seen: no drag session, so the release does nothing.
  assert.deepEqual(dragOut(f, f.tabs, id, into, { press: false }), { started: false, ended: false })
  // A release with no drag start at all.
  f.pointer.at = into
  assert.equal(f.tabs.stripCommand(eventFrom(f.tabs), 'drag-end', id), false)
  // A press, then a mouse up before the drag started.
  f.strip.emit('input-event', {}, { type: 'mouseDown' })
  f.strip.emit('input-event', {}, { type: 'mouseUp' })
  assert.equal(f.tabs.stripCommand(eventFrom(f.tabs), 'drag-start', id), false)
  // The strip reloaded during the drag.
  f.strip.emit('input-event', {}, { type: 'mouseDown' })
  assert.equal(f.tabs.stripCommand(eventFrom(f.tabs), 'drag-start', id), true)
  f.strip.emit('did-start-loading')
  assert.equal(f.tabs.stripCommand(eventFrom(f.tabs), 'drag-end', id), false)
  // Cancelled, or another strip's sender, or Home.
  f.strip.emit('input-event', {}, { type: 'mouseDown' })
  f.tabs.stripCommand(eventFrom(f.tabs), 'drag-start', id)
  f.tabs.stripCommand(eventFrom(f.tabs), 'drag-cancel', id)
  assert.equal(f.tabs.stripCommand(eventFrom(f.tabs), 'drag-end', id), false)
  assert.equal(f.tabs.stripCommand(eventFrom(second), 'drag-start', id), false)
  f.strip.emit('input-event', {}, { type: 'mouseDown' })
  assert.equal(f.tabs.stripCommand(eventFrom(f.tabs), 'drag-start', 1), false)
  // Too long: the session is forgotten.
  f.strip.emit('input-event', {}, { type: 'mouseDown' })
  f.tabs.stripCommand(eventFrom(f.tabs), 'drag-start', id)
  f.clock.advance(60000)
  assert.equal(f.tabs.stripCommand(eventFrom(f.tabs), 'drag-end', id), false)
  assert.equal(slotAsked(second), undefined)
  assert.equal(f.tabs.isTab(mainTab), true)
})

test('a slot answer counts once, in time, from the target strip it was asked of, against its tab order', async () => {
  const { f, mainTab, second } = dropWindows()
  const id = tabIds(f)[1]
  const into = { x: 1300 + 250, y: 12 }
  const stays = async () => { await settled(); f.flush(); assert.equal(f.tabs.isTab(mainTab), true) }
  // Not over its tabs.
  dragOut(f, f.tabs, id, into)
  answerSlot(second, null)
  await stays()
  // Another request's id, then too late.
  dragOut(f, f.tabs, id, into)
  answerSlot(second, 0, second.tabIds(), slotAsked(second).requestId + 1)
  f.clock.advance(400)
  answerSlot(second, 0, second.tabIds(), slotAsked(second).requestId)
  await stays()
  // Against an order the window no longer has.
  dragOut(f, f.tabs, id, into)
  answerSlot(second, 0, [...second.tabIds()].reverse())
  await stays()
  // From the main strip instead of the target's.
  dragOut(f, f.tabs, id, into)
  const asked = slotAsked(second)
  assert.equal(f.tabs.stripCommand(eventFrom(f.tabs), 'slot', undefined, { requestId: asked.requestId, index: 0, order: second.tabIds() }), false)
  // The target strip reloads before it answers.
  second.strip.emit('did-start-loading')
  answerSlot(second, 0)
  await stays()
  // An index outside its tabs.
  second.strip.emit('did-finish-load')
  dragOut(f, f.tabs, id, into)
  answerSlot(second, 5)
  await stays()
  assert.equal(second.tabCount(), 2)
})

test('while a drop waits for its answer, a quit, a close, a Save As or a hidden target stops it', async () => {
  const { f, mainTab, a, second } = dropWindows()
  const id = tabIds(f)[1]
  const into = { x: 1300 + 250, y: 12 }
  const attempt = async (during) => {
    dragOut(f, f.tabs, id, into)
    during()
    answerSlot(second, 0)
    await settled()
    f.flush()
    assert.equal(f.tabs.isTab(mainTab), true)
  }
  await attempt(() => { f.app.quitting = true })
  f.app.quitting = false
  await attempt(() => { a.hang = true; second.closeTab(stateOf(second).tabs[0].id) })
  a.hang = false
  a.destroy()
  f.flush()
  await attempt(() => f.pointer.busy.add(second.window))
  f.pointer.busy.clear()
  await attempt(() => second.window.minimize())
  // A minimized or hidden window is never asked at all.
  assert.equal(second.window.isMinimized(), true)
  const asked = second.strip.sent.filter(([channel]) => channel === 'tabs:slot').length
  dragOut(f, f.tabs, id, into)
  assert.equal(second.strip.sent.filter(([channel]) => channel === 'tabs:slot').length, asked)
  // A Save As on the target: not asked either.
  second.window.restore()
  f.pointer.busy.add(second.window)
  dragOut(f, f.tabs, id, into)
  assert.equal(second.strip.sent.filter(([channel]) => channel === 'tabs:slot').length, asked)
})

const { HOME_ID, createTabList, tabKind, pageTitle, tabLabel, linkLabelText, shortcutAction } = require('./tabs')
const { confirmLeave } = require('./unload-guard')

// Owns the main window: a local tab strip in the window's own page and one
// WebContentsView per Brinq tab below it. Home is the permanent base tab.
const STRIP_HEIGHT = 40
// Native overlay colors match the web theme's layer-0 and regular text.
const THEME_COLORS = {
  dark: { color: '#1a1a1a', symbolColor: '#f4f4f4' },
  light: { color: '#eeeef2', symbolColor: '#0d0d0d' },
}
const isTheme = (value) => value === 'dark' || value === 'light'
// After the user chooses Stay, Chromium ignores a new close request until the
// page acknowledges the canceled unload. Measured on Electron 44 (Linux): an
// immediate retry was dropped, one 100 ms later succeeded. Later requests
// wait out this margin instead of being lost.
const UNLOAD_SETTLE_MS = 250
// A link label names the tab its gesture opens. The label arrives by
// synchronous IPC before the open request (measured gap: about 1 ms in
// Electron 44); 2 s is a generous, reversible margin before it goes stale.
const LINK_LABEL_MS = 2000
const canonicalUrl = (value) => { try { return new URL(value).href } catch { return null } }

function createTabWindow({
  electron: { BrowserWindow, WebContentsView, dialog },
  security, bounds, icon, preloadPath, shellPreloadPath, shellUrl,
  theme: savedTheme = 'light', platform = process.platform,
  newTabUrl, onTheme = () => {}, onHome = () => {}, schedule = setImmediate,
  now = Date.now, setTimer = setTimeout,
  // Quit wiring: whether the app is quitting, how to quit again once every
  // tab closed, and what to do when an unsaved-work prompt stops the quit.
  isQuitting = () => false, requestQuit = () => {}, onQuitStopped = () => {},
}) {
  const appPreferences = () => ({
    preload: preloadPath, contextIsolation: true, nodeIntegration: false,
    sandbox: true, webviewTag: false,
  })
  let theme = isTheme(savedTheme) ? savedTheme : 'light'
  const overlay = () => ({ ...THEME_COLORS[theme], height: STRIP_HEIGHT })
  const host = new BrowserWindow({
    ...bounds,
    icon,
    show: false,
    title: 'Brinq',
    autoHideMenuBar: true,
    backgroundColor: THEME_COLORS[theme].color,
    titleBarStyle: 'hidden',
    ...(platform === 'darwin' ? {} : { titleBarOverlay: overlay() }),
    webPreferences: {
      preload: shellPreloadPath, contextIsolation: true, nodeIntegration: false,
      sandbox: true, webviewTag: false,
    },
  })
  const strip = host.webContents
  const list = createTabList()
  const entries = new Map()
  const byContents = new Map()
  let pushScheduled = false
  let disposed = false
  let quitting = null
  // One pending link label per opener page: its latest gesture.
  const linkLabels = new Map()
  const watchedOpeners = new WeakSet()

  const alive = () => !disposed && !host.isDestroyed()
  const entryFor = (contents) => byContents.get(contents)
  const selectedEntry = () => entries.get(list.selected())

  function snapshot() {
    return {
      platform,
      theme,
      selectedId: list.selected(),
      tabs: list.ids().filter((id) => entries.has(id)).map((id) => {
        const entry = entries.get(id)
        return {
          id, home: id === HOME_ID, label: tabLabel(entry.title, entry.url, entry.provisional),
          kind: tabKind(entry.url), loading: entry.loading, failed: entry.failed,
        }
      }),
    }
  }

  // Coalesce bursts of title/loading events into one strip update.
  function push() {
    if (pushScheduled || !alive()) return
    pushScheduled = true
    schedule(() => {
      pushScheduled = false
      if (!alive() || strip.isDestroyed()) return
      strip.send('tabs:state', snapshot())
      const selected = selectedEntry()
      host.setTitle(selected ? tabLabel(selected.title, selected.url, selected.provisional) : 'Brinq')
    })
  }

  function layout() {
    if (!alive()) return
    const [width, height] = host.getContentSize()
    const area = { x: 0, y: STRIP_HEIGHT, width, height: Math.max(0, height - STRIP_HEIGHT) }
    for (const entry of entries.values()) entry.view.setBounds(area)
  }

  function showSelected() {
    for (const entry of entries.values()) {
      entry.view.setVisible(entry.id === list.selected() && !entry.failed)
    }
  }

  function applyTheme(next) {
    if (!isTheme(next) || !alive() || next === theme) return
    theme = next
    host.setBackgroundColor(THEME_COLORS[theme].color)
    if (platform !== 'darwin') host.setTitleBarOverlay(overlay())
    for (const entry of entries.values()) entry.view.setBackgroundColor(THEME_COLORS[theme].color)
    push()
    onTheme(theme)
  }

  function select(id, { focus = true } = {}) {
    const entry = entries.get(id)
    if (!alive() || !entry || !list.select(id)) return false
    showSelected()
    // The selected tab owns the header theme; ask for a fresh report.
    if (isTheme(entry.theme)) applyTheme(entry.theme)
    requestTheme(entry)
    if (focus && !entry.failed) entry.contents.focus()
    push()
    return true
  }

  function requestTheme(entry) {
    if (!entry.contents.isDestroyed()) entry.contents.send('theme-request')
  }

  function confirmTabLeave(entry) {
    if (alive()) {
      if (!host.isVisible()) host.show()
      if (list.selected() !== entry.id) select(entry.id)
    }
    return confirmLeave(dialog, alive() ? host : undefined)
  }

  function dispatch(action, contents = selectedEntry()?.contents) {
    if (!alive()) return
    const entry = entryFor(contents) || selectedEntry()
    if (action === 'new') return newTab()
    if (action === 'close') return entry && closeTab(entry.id)
    if (action === 'move-left' || action === 'move-right') {
      const id = list.selected()
      const position = list.ids().indexOf(id) + (action === 'move-left' ? -1 : 1)
      return moveTab(id, position)
    }
    if (action === 'next') return select(list.next())
    if (action === 'previous') return select(list.previous())
    if (action.startsWith('select-')) {
      const id = list.idAtPosition(Number(action.slice(7)))
      return id !== undefined && select(id)
    }
    const target = selectedEntry()
    if (!target || target.contents.isDestroyed()) return
    const contentsOf = target.contents
    if (action === 'reload') return reload(target, false)
    if (action === 'reload-hard') return reload(target, true)
    if (action === 'devtools') return contentsOf.toggleDevTools()
    if (action === 'zoom-in') return contentsOf.setZoomLevel(Math.min(contentsOf.getZoomLevel() + 0.5, 9))
    if (action === 'zoom-out') return contentsOf.setZoomLevel(Math.max(contentsOf.getZoomLevel() - 0.5, -8))
    if (action === 'zoom-reset') return contentsOf.setZoomLevel(0)
  }

  function onInput(event, input) {
    const action = shortcutAction(input, platform)
    if (!action) return
    event.preventDefault()
    dispatch(action)
  }

  function reload(entry, hard) {
    if (entry.failed && entry.url) return retry(entry.id)
    if (hard) entry.contents.reloadIgnoringCache()
    else entry.contents.reload()
  }

  // A failed or crashed tab shows the strip's explanation panel until a retry
  // loads its last approved page again. Only one retry runs at a time.
  function retry(id) {
    const entry = entries.get(id)
    if (!entry || !entry.failed || entry.retrying || !entry.url || id === HOME_ID) return
    entry.retrying = true
    entry.failed = null
    entry.loading = true
    showSelected()
    push()
    entry.contents.loadURL(entry.url).catch(() => {}).finally(() => { entry.retrying = false })
  }

  function forget(entry) {
    if (!entries.has(entry.id)) return
    entries.delete(entry.id)
    byContents.delete(entry.contents)
    const wasSelected = list.selected() === entry.id
    list.remove(entry.id)
    if (alive()) {
      host.contentView.removeChildView(entry.view)
      // Home is permanent: if its page goes away outside quit, rebuild it.
      if (entry.id === HOME_ID) lastHomeUrl = entry.url
      if (entry.id === HOME_ID && !quitting) createHome(entry.url)
      else if (wasSelected && entries.has(list.selected())) select(list.selected(), { focus: entry.focusAfterClose !== false })
      else push()
    }
    entry.settle?.(true)
  }

  function attach(entry) {
    const { contents, view } = entry
    entries.set(entry.id, entry)
    byContents.set(contents, entry)
    view.setBackgroundColor(THEME_COLORS[theme].color)
    // Size before hiding: a view hidden before its first bounds renders its
    // page at 0x0, so background tabs would never lay out.
    host.contentView.addChildView(view)
    layout()
    view.setVisible(false)
    contents.on('before-input-event', onInput)
    contents.on('page-title-updated', (_event, title) => {
      entry.title = title
      // The page named itself; the link's name is no longer needed.
      if (pageTitle(title)) entry.provisional = null
      push()
    })
    const committed = (url) => {
      // A different page than the link named: drop the link's name.
      if (entry.provisional && canonicalUrl(url) !== entry.provisionalUrl) entry.provisional = null
      if (security.isAppUrl(url)) entry.url = url
      push()
    }
    contents.on('did-navigate', (_event, url) => committed(url))
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) committed(url) })
    contents.on('did-start-loading', () => { entry.loading = true; push() })
    contents.on('did-stop-loading', () => { entry.loading = false; push() })
    contents.on('did-finish-load', () => requestTheme(entry))
    contents.on('will-prevent-unload', (event) => {
      if (confirmTabLeave(entry)) {
        event.preventDefault()
        return
      }
      entry.closing = false
      entry.stayedAt = now()
      entry.settle?.(false)
    })
    if (entry.id !== HOME_ID) {
      contents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
        if (!isMainFrame || code === -3 || entry.closing) return
        if (url && security.isAppUrl(url)) entry.url = url
        entry.failed = 'load'
        entry.loading = false
        showSelected()
        push()
      })
      contents.on('render-process-gone', () => {
        if (entry.closing) return
        entry.failed = 'crash'
        entry.loading = false
        showSelected()
        push()
      })
    }
    contents.once('destroyed', () => forget(entry))
    security.register(contents, entry.id === HOME_ID ? 'main' : 'app', undefined, host)
  }

  function addTab({ contents: guest = null, webPreferences, url, afterId, background, id: fixedId, provisional = null }) {
    const view = guest
      ? new WebContentsView({ webContents: guest })
      // Keep inherited sandbox flags, but never loosen the app preferences.
      : new WebContentsView({ webPreferences: { ...webPreferences, ...appPreferences() } })
    const id = fixedId ?? list.add({ afterId })
    const entry = {
      id, view, contents: view.webContents, url, title: '', loading: !guest, failed: null,
      theme: null, closing: false, retrying: false, stayedAt: 0,
      // The opening link's name, shown until the page has its own title.
      provisional: provisional?.label ?? null, provisionalUrl: provisional?.url ?? null,
    }
    attach(entry)
    if (!background) select(id)
    else push()
    return entry
  }

  // Called by window security for an eligible open from any app page.
  function openTab({ opener, url, options = {}, referrer, background }) {
    if (!alive()) {
      // The window closed between the open decision and creation: keep the
      // page in an ordinary window rather than dropping it.
      const window = new BrowserWindow({ ...options, width: 1100, height: 700, autoHideMenuBar: true })
      security.register(window.webContents, 'app', undefined, window)
      if (!options.webContents) window.loadURL(url, { httpReferrer: referrer }).catch(() => {})
      return window.webContents
    }
    const openerEntry = entryFor(opener)
    const provisional = takeLinkLabel(opener, url)
    const entry = addTab({
      contents: options.webContents || null,
      webPreferences: options.webPreferences,
      url,
      afterId: openerEntry ? openerEntry.id : null,
      background,
      provisional,
    })
    if (!options.webContents) entry.contents.loadURL(url, { httpReferrer: referrer }).catch(() => {})
    if (!background && !openerEntry) { host.show(); host.focus() }
    return entry.contents
  }

  // Stores the name of the link a page is opening in a new tab. Called
  // synchronously by the page, so it must only validate and store.
  function linkLabel(event, payload) {
    if (!alive() || !security.validateSender(event)) return false
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
    const { href, label } = payload
    if (typeof href !== 'string' || !security.isAppUrl(href)) return false
    const text = linkLabelText(label)
    if (!text) return false
    const opener = event.sender
    watchOpener(opener)
    const slot = {
      href: canonicalUrl(href), label: text, at: now(),
      stillAuthorized: security.captureSender(event),
    }
    linkLabels.set(opener, slot)
    // A gesture that opened nothing leaves no label behind.
    setTimer(() => { if (linkLabels.get(opener) === slot) linkLabels.delete(opener) }, LINK_LABEL_MS)
    return true
  }

  function watchOpener(opener) {
    if (watchedOpeners.has(opener)) return
    watchedOpeners.add(opener)
    const forget = () => linkLabels.delete(opener)
    opener.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) forget() })
    opener.on('did-navigate-in-page', (_event, _url, isMainFrame) => { if (isMainFrame) forget() })
    opener.once('destroyed', forget)
  }

  // The next tab this opener opens takes its pending label, once, and only
  // for the exact URL the label named while the page is unchanged.
  function takeLinkLabel(opener, url) {
    const slot = linkLabels.get(opener)
    linkLabels.delete(opener)
    if (!slot || now() - slot.at >= LINK_LABEL_MS || !slot.stillAuthorized()) return null
    return slot.href === canonicalUrl(url) ? { label: slot.label, url: slot.href } : null
  }

  function newTab() {
    if (!alive()) return
    const url = newTabUrl(entries.get(HOME_ID)?.contents)
    const entry = addTab({ url, afterId: null, background: false })
    entry.contents.loadURL(url).catch(() => {})
  }

  // Closing honors the page's unsaved-work guard; the tab is removed only
  // once its page is actually destroyed. Repeated requests are harmless:
  // Chromium runs one unload at a time.
  function requestClose(entry) {
    entry.closing = true
    const wait = entry.stayedAt ? entry.stayedAt + UNLOAD_SETTLE_MS - now() : 0
    const close = () => {
      if (!entry.contents.isDestroyed()) entry.contents.close({ waitForBeforeUnload: true })
    }
    if (wait > 0) setTimer(close, wait)
    else close()
  }

  // A close from the strip keeps keyboard focus in the strip.
  function closeTab(id, { focus = true } = {}) {
    const entry = entries.get(id)
    if (!entry || id === HOME_ID) return false
    entry.focusAfterClose = focus
    requestClose(entry)
    return true
  }

  // Reorders a tab; Home keeps the first position.
  function moveTab(id, position) {
    if (!list.move(id, position)) return false
    push()
    return true
  }

  function closeAndWait(entry) {
    return new Promise((resolve) => {
      entry.settle = (closed) => { entry.settle = null; resolve(closed) }
      if (entry.contents.isDestroyed()) return forget(entry)
      requestClose(entry)
    })
  }

  // Quit closes every tab, Home last, one at a time so each unsaved-work
  // prompt is answered in context. Resolves false if the user chose Stay.
  function closeAllForQuit() {
    if (quitting) return quitting
    quitting = (async () => {
      const order = [...list.ids().filter((id) => id !== HOME_ID), HOME_ID]
      for (const id of order) {
        // Another window (an email pop-out) may have stopped the quit; keep
        // the remaining tabs rather than closing them for nothing.
        if (!isQuitting()) return false
        const entry = entries.get(id)
        if (entry && !(await closeAndWait(entry))) return false
      }
      return true
    })().finally(() => { quitting = null })
    return quitting
  }

  function reportTheme(contents, value) {
    const entry = entryFor(contents)
    if (!entry || !isTheme(value)) return
    entry.theme = value
    if (entry.id === list.selected()) applyTheme(value)
  }

  function validStripSender(event) {
    try {
      const frame = event.senderFrame
      return alive() && event.sender === strip && !strip.isDestroyed() && !!frame &&
        frame === strip.mainFrame && !frame.detached && frame.parent === null &&
        frame.url === shellUrl && strip.getURL() === shellUrl
    } catch { return false }
  }

  function stripCommand(event, command, id, options) {
    if (!validStripSender(event)) return false
    if (command === 'new') return newTab(), true
    if (command === 'home') return select(HOME_ID, { focus: options?.focus === true })
    if (command === 'reload') return dispatch('reload'), true
    if (!Number.isSafeInteger(id) || !entries.has(id)) return false
    if (command === 'select') return select(id, { focus: options?.focus === true })
    if (command === 'close') return closeTab(id, { focus: false })
    if (command === 'retry') return retry(id), true
    if (command === 'move') return Number.isSafeInteger(options?.position) && moveTab(id, options.position)
    return false
  }

  function stripState(event) {
    return validStripSender(event) ? snapshot() : null
  }

  // The strip is a fixed local page: it never navigates or opens windows.
  strip.setWindowOpenHandler(() => ({ action: 'deny' }))
  strip.on('will-navigate', (event) => event.preventDefault())
  strip.on('will-redirect', (event) => event.preventDefault())
  strip.on('before-input-event', onInput)
  // Keep the selected tab's name as the window title.
  strip.on('page-title-updated', (event) => event.preventDefault())
  const reloadStrip = () => { if (alive()) strip.loadURL(shellUrl).catch(() => {}) }
  strip.on('render-process-gone', () => schedule(reloadStrip))
  strip.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && url === shellUrl) schedule(reloadStrip)
  })
  // Closing the window hides it to the tray and keeps every tab. Quitting
  // closes the tabs first, Home last, then quits again with no tabs left.
  host.on('close', (event) => {
    if (!isQuitting()) {
      event.preventDefault()
      host.hide()
      return
    }
    if (entries.size === 0) return
    event.preventDefault()
    closeAllForQuit().then((closed) => {
      if (closed) requestQuit()
      else onQuitStopped()
    })
  })

  for (const name of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']) {
    host.on(name, layout)
  }

  let home = null
  let lastHomeUrl = null
  function createHome(url = null) {
    home = addTab({ id: HOME_ID, webPreferences: appPreferences(), url, background: true })
    showSelected()
    onHome(home.contents, url)
  }
  createHome()
  strip.loadURL(shellUrl).catch(() => {})

  function dispose() {
    if (disposed) return
    linkLabels.clear()
    for (const entry of entries.values()) {
      if (!entry.contents.isDestroyed()) entry.contents.close()
    }
    disposed = true
  }
  host.once('closed', dispose)

  return {
    window: host,
    get home() { return home.contents },
    available: alive,
    openTab,
    newTab,
    select,
    selectHome: () => select(HOME_ID),
    // After a stopped quit closed Home, bring it back on its last page.
    ensureHome() { if (alive() && !entries.has(HOME_ID)) createHome(lastHomeUrl) },
    dispatch,
    closeTab,
    closeAllForQuit,
    linkLabel,
    reportTheme,
    stripCommand,
    stripState,
    // Dialog owner for a tab page; null when the page is not a tab.
    windowFor: (contents) => (entryFor(contents) && alive() ? host : null),
    isTab: (contents) => !!entryFor(contents),
    hasOpenTabs: () => entries.size > 0,
  }
}

module.exports = { createTabWindow, STRIP_HEIGHT, THEME_COLORS }

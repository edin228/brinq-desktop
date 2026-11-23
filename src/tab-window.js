const { HOME_ID, createTabList, tabKind, pageTitle, tabLabel, linkLabelText, shareableUrl, shortcutAction } = require('./tabs')
const { confirmLeave } = require('./unload-guard')

// Owns one Brinq window: a local tab strip and one WebContentsView per Brinq
// tab below it, all child views; the window's own page stays empty. In the main (primary) window Home
// is the permanent base tab; a secondary window holds only tabs moved to it
// and closes when its last tab goes.
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
  electron: { BrowserWindow, WebContentsView, dialog, Menu, clipboard },
  security, bounds, icon, preloadPath, shellPreloadPath, shellUrl, openExternal,
  theme: savedTheme = 'light', platform = process.platform,
  newTabUrl, onTheme = () => {}, onHome = () => {}, schedule = setImmediate,
  now = Date.now, setTimer = setTimeout,
  // Quit wiring: whether the app is quitting, how to quit again once every
  // tab closed, and what to do when an unsaved-work prompt stops the quit.
  isQuitting = () => false, requestQuit = () => {}, onQuitStopped = () => {},
  // The header's update action: main's small view of the updater, and the
  // two fixed commands the strip may send for it.
  updateView = () => null, onUpdateCommand = () => {},
  // Startup tabs: receives the tab list (addresses only) after each change.
  onTabsChanged = () => {},
  // Several windows: only the primary window has Home. onNewWindow(id) asks
  // to move a tab of this window into a new window; canMove(contents) says
  // whether main has something open for that page (a Save As dialog).
  primary = true, onNewWindow = () => false, canMove = () => true,
  // A secondary window's close button gives its tabs back to the main
  // window (onCloseWindow). Brinq does not quit while a secondary window
  // has tabs (main.js), so only the main window's quit loop closes tabs.
  onCloseWindow = () => {},
  // True while any page in any window waits for its close to be answered:
  // no tab moves then, so a late answer never lands on a moved tab.
  movesHeld = () => false,
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
    // This page never loads (see the strip below).
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false },
  })
  // A tab page moved here from another window is drawn beneath anything the
  // window already shows (measured on Electron 44.4.5: its own page, or any
  // child view over the same area). So nothing shares the page area: the
  // strip is a child view across the top, made full height only while the
  // selected tab shows the failure panel (that tab's view is hidden then).
  const stripView = new WebContentsView({
    webPreferences: {
      preload: shellPreloadPath, contextIsolation: true, nodeIntegration: false,
      sandbox: true, webviewTag: false,
    },
  })
  stripView.setBackgroundColor(THEME_COLORS[theme].color)
  host.contentView.addChildView(stripView)
  const strip = stripView.webContents
  const list = createTabList({ home: primary })
  const entries = new Map()
  const byContents = new Map()
  let pushScheduled = false
  let disposed = false
  let quitting = null
  // Each quit's close loop; abandonQuit() retires the current one.
  let quitAttempt = 0
  // One pending link label per opener page: its latest gesture. Each watched
  // opener maps to the removal of its listeners.
  const linkLabels = new Map()
  const watchedOpeners = new Map()

  const alive = () => !disposed && !host.isDestroyed()
  const entryFor = (contents) => byContents.get(contents)
  const selectedEntry = () => entries.get(list.selected())

  function snapshot() {
    return {
      platform,
      theme,
      hasHome: primary,
      selectedId: list.selected() ?? null,
      tabs: list.ids().filter((id) => entries.has(id)).map((id) => {
        const entry = entries.get(id)
        return {
          id, home: id === HOME_ID, label: tabLabel(entry.title, entry.url, entry.provisional),
          kind: tabKind(entry.url), loading: entry.loading, failed: entry.failed,
        }
      }),
      update: updateView(),
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
      try { onTabsChanged(sessionState()) } catch {}
    })
  }

  // The tabs after Home, in strip order, by their last approved address. A
  // restored tab that was never opened keeps the address it was restored with.
  function sessionState() {
    return {
      tabs: list.ids().filter((id) => id !== HOME_ID && entries.has(id))
        .map((id) => entries.get(id).url)
        .filter((url) => typeof url === 'string' && security.isAppUrl(url))
        .map((url) => ({ url })),
    }
  }

  // Quitting closes every tab; it must never load a restored page on the way.
  const quitBlocked = () => !!quitting || isQuitting()

  // A restored tab loads the first time it is selected, reloaded or retried.
  function loadPending(entry) {
    if (!entry.pending || quitBlocked() || entry.closing || entry.contents.isDestroyed()) return false
    entry.pending = false
    entry.loading = true
    showSelected()
    push()
    // A failed load reaches the existing failed-tab panel through did-fail-load.
    entry.contents.loadURL(entry.url).catch(() => {})
    return true
  }

  // After a stopped or abandoned quit, a selected restored tab loads as usual.
  function resumeSelected() {
    const entry = selectedEntry()
    if (entry?.pending && alive()) loadPending(entry)
  }

  function layoutStrip() {
    if (!alive()) return
    const [width, height] = host.getContentSize()
    const panel = !!selectedEntry()?.failed
    stripView.setBounds({ x: 0, y: 0, width, height: panel ? height : STRIP_HEIGHT })
  }

  function layout() {
    if (!alive()) return
    const [width, height] = host.getContentSize()
    const area = { x: 0, y: STRIP_HEIGHT, width, height: Math.max(0, height - STRIP_HEIGHT) }
    for (const entry of entries.values()) entry.view.setBounds(area)
    layoutStrip()
  }

  function showSelected() {
    // Hide before the strip grows over a failed tab; show after it shrinks.
    for (const entry of entries.values()) {
      if (entry.id !== list.selected() || entry.failed) entry.view.setVisible(false)
    }
    layoutStrip()
    const selected = selectedEntry()
    if (selected && !selected.failed) selected.view.setVisible(true)
  }

  function applyTheme(next) {
    if (!isTheme(next) || !alive() || next === theme) return
    theme = next
    host.setBackgroundColor(THEME_COLORS[theme].color)
    stripView.setBackgroundColor(THEME_COLORS[theme].color)
    if (platform !== 'darwin') host.setTitleBarOverlay(overlay())
    for (const entry of entries.values()) entry.view.setBackgroundColor(THEME_COLORS[theme].color)
    push()
    onTheme(theme)
  }

  function select(id, { focus = true } = {}) {
    const entry = entries.get(id)
    if (!alive() || !entry || !list.select(id)) return false
    showSelected()
    loadPending(entry)
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
    if (action === 'new-window') {
      const target = selectedEntry()
      return !!target && movable(target, { newWindow: true }) && onNewWindow(target.id)
    }
    if (action === 'move-left' || action === 'move-right') {
      const id = list.selected()
      // Positions count Home as 0 in every window (see tabs.js).
      const position = list.ids().indexOf(id) + (primary ? 0 : 1) + (action === 'move-left' ? -1 : 1)
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

  // `from` is the page or strip the key was pressed in.
  function onInput(event, input, from) {
    const action = shortcutAction(input, platform)
    if (!action) return
    event.preventDefault()
    if (action === 'switch-pane') switchPane(from)
    else dispatch(action)
  }

  // F6 and Shift+F6 move keyboard focus between the page and the header:
  // they are separate pages, so Tab alone cannot cross between them. A
  // failed tab shows its panel in the strip, so the strip moves focus itself.
  function switchPane(from) {
    if (!alive()) return
    const entry = selectedEntry()
    if (from === strip && entry && !entry.failed && !entry.contents.isDestroyed()) {
      entry.contents.focus()
      return
    }
    strip.focus()
    strip.send('tabs:focus', from === strip ? 'toggle' : 'header')
  }

  function reload(entry, hard) {
    if (entry.pending) return loadPending(entry)
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
    // Its last tab closed: a secondary window goes too.
    if (!primary && entries.size === 0) schedule(closeIfEmpty)
  }

  // `adopted`: the page moved here from another window. It keeps its
  // security registration, which now belongs to this window.
  function attach(entry, { adopted = false } = {}) {
    const { contents, view } = entry
    entries.set(entry.id, entry)
    byContents.set(contents, entry)
    view.setBackgroundColor(THEME_COLORS[theme].color)
    // Size before hiding: a view hidden before its first bounds renders its
    // page at 0x0, so background tabs would never lay out.
    host.contentView.addChildView(view)
    layout()
    view.setVisible(false)
    entry.unbind = bind(entry)
    if (adopted) {
      if (!security.reassign(contents, host)) throw new Error('The tab page is no longer registered.')
    } else security.register(contents, entry.id === HOME_ID ? 'main' : 'app', undefined, host)
  }

  // This window's handlers for one tab page. Returns their removal, so a tab
  // that moves to another window leaves nothing bound to this one.
  function bind(entry) {
    const { contents } = entry
    const removals = []
    const on = (name, listener) => {
      contents.on(name, listener)
      removals.push(() => contents.removeListener(name, listener))
    }
    on('before-input-event', (event, input) => onInput(event, input, contents))
    on('focus', () => { stripHadFocus = false })
    on('page-title-updated', (_event, title) => {
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
    on('did-navigate', (_event, url) => committed(url))
    on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) committed(url) })
    on('did-start-loading', () => { entry.loading = true; push() })
    on('did-stop-loading', () => { entry.loading = false; push() })
    on('did-finish-load', () => requestTheme(entry))
    on('will-prevent-unload', (event) => {
      if (confirmTabLeave(entry)) {
        event.preventDefault()
        return
      }
      entry.closing = false
      entry.stayedAt = now()
      entry.settle?.(false)
    })
    if (entry.id !== HOME_ID) {
      on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
        if (!isMainFrame || code === -3 || entry.closing) return
        if (url && security.isAppUrl(url)) entry.url = url
        entry.failed = 'load'
        entry.loading = false
        showSelected()
        push()
      })
      on('render-process-gone', () => {
        if (entry.closing) return
        entry.failed = 'crash'
        entry.loading = false
        showSelected()
        push()
      })
    }
    // Emitted once; a plain listener so a move can remove it.
    on('destroyed', () => forget(entry))
    return () => { for (const remove of removals.splice(0)) remove() }
  }

  // Undoes attach without closing the page: the view, the maps, the list and
  // this window's handlers. The caller decides what happens to the page.
  // `keepInList`: a staged move keeps the tab's place (and its opener run)
  // until it commits, so undoing it restores the tab exactly.
  function unattach(entry, { keepInList = false } = {}) {
    entries.delete(entry.id)
    byContents.delete(entry.contents)
    if (entry.id !== HOME_ID && !keepInList) list.remove(entry.id)
    try { entry.unbind?.() } catch {}
    entry.unbind = null
    try { host.contentView.removeChildView(entry.view) } catch {}
  }

  function addTab({ contents: guest = null, webPreferences, url, afterId, background, id: fixedId, provisional = null, lazy = false }) {
    const view = guest
      ? new WebContentsView({ webContents: guest })
      // Keep inherited sandbox flags, but never loosen the app preferences.
      : new WebContentsView({ webPreferences: { ...webPreferences, ...appPreferences() } })
    const id = fixedId ?? list.add({ afterId })
    const entry = {
      id, view, contents: view.webContents, url, title: '', loading: !guest && !lazy, failed: null,
      theme: null, closing: false, retrying: false, stayedAt: 0,
      // A restored tab waits, unloaded, until it is first selected.
      pending: lazy, restored: false,
      // The opening link's name, shown until the page has its own title.
      provisional: provisional?.label ?? null, provisionalUrl: provisional?.url ?? null,
    }
    try {
      attach(entry)
    } catch (error) {
      // A view that failed to attach must not linger in the strip or the
      // session list: undo every step attach may have taken.
      unattach(entry)
      try { if (!entry.contents.isDestroyed()) entry.contents.close() } catch {}
      push()
      throw error
    }
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
    const forget = () => linkLabels.delete(opener)
    const started = (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) forget() }
    const inPage = (_event, _url, isMainFrame) => { if (isMainFrame) forget() }
    const destroyed = () => unwatchOpener(opener)
    opener.on('did-start-navigation', started)
    opener.on('did-navigate-in-page', inPage)
    opener.on('destroyed', destroyed)
    watchedOpeners.set(opener, () => {
      opener.removeListener('did-start-navigation', started)
      opener.removeListener('did-navigate-in-page', inPage)
      opener.removeListener('destroyed', destroyed)
    })
  }

  // Drops an opener's pending label and this window's listeners on it.
  function unwatchOpener(opener) {
    linkLabels.delete(opener)
    const remove = watchedOpeners.get(opener)
    watchedOpeners.delete(opener)
    try { remove?.() } catch {}
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
    // A quit is closing tabs: + and Ctrl+T wait until it ends.
    if (!alive() || quitBlocked()) return
    const url = newTabUrl(entries.get(HOME_ID)?.contents)
    const entry = addTab({ url, afterId: null, background: false })
    entry.contents.loadURL(url).catch(() => {})
  }

  // Closing honors the page's unsaved-work guard; the tab is removed only
  // once its page is actually destroyed. Repeated requests are harmless:
  // Chromium runs one unload at a time.
  function requestClose(entry) {
    entry.closing = true
    // A tab that never loaded has no page and no unsaved work to ask about.
    if (entry.pending) {
      if (!entry.contents.isDestroyed()) entry.contents.close()
      return
    }
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

  // A tab can move to another window when it is an ordinary tab with a live
  // page that is not closing, reloading after a failure or showing a native
  // dialog, outside a quit. Into a new window, not the only tab of a
  // secondary window: that would only replace its window.
  function movable(entry, { newWindow = false } = {}) {
    return !!entry && alive() && entry.id !== HOME_ID && entries.get(entry.id) === entry &&
      !entry.closing && !entry.retrying && !quitBlocked() && !entry.contents.isDestroyed() &&
      !(newWindow && !primary && entries.size < 2) && canMove(entry.contents) && !movesHeld()
  }

  // Takes a tab out of this window without closing its page. Returns what
  // adoptTab needs, or null when the tab cannot move. Never settles a close
  // and never rebuilds Home: the page is still open, elsewhere.
  //
  // Staged: nothing a person could notice happens until `commit()` (the
  // move succeeded). Until then the tab keeps its id and place in this
  // window's list, and `undo()` puts it back exactly as it was.
  // `merging`: a secondary window is giving its tabs back to the main
  // window (its close button), which also takes its only tab.
  function detachTab(id, { merging = false } = {}) {
    const entry = entries.get(id)
    const ok = merging
      ? !!entry && alive() && entry.id !== HOME_ID && !entry.closing && !entry.contents.isDestroyed() &&
        !quitBlocked() && canMove(entry.contents)
      : movable(entry)
    if (!ok) return null
    const selected = list.selected() === id
    unattach(entry, { keepInList: true })
    return {
      selected,
      commit() {
        list.remove(id)
        unwatchOpener(entry.contents)
        if (!alive()) return
        if (selected && entries.has(list.selected())) select(list.selected(), { focus: false })
        else { showSelected(); push() }
      },
      // Throws if this window can no longer show the tab.
      undo() {
        if (!alive() || entry.contents.isDestroyed()) {
          list.remove(id)
          throw new Error('The window that had the tab is gone.')
        }
        try {
          attach(entry, { adopted: true })
        } catch (error) {
          unattach(entry)
          throw error
        }
        showSelected()
        push()
      },
      record: {
        view: entry.view, contents: entry.contents, url: entry.url, title: entry.title,
        loading: entry.loading, failed: entry.failed, theme: entry.theme, stayedAt: entry.stayedAt,
        pending: entry.pending, restored: entry.restored,
        provisional: entry.provisional, provisionalUrl: entry.provisionalUrl,
      },
    }
  }

  // Adds a page detached from another window as a new tab with an id of
  // this window, after its tabs. Throws, leaving this window as it was, if
  // the page cannot be attached here.
  function adoptTab(moved, { select: selectIt = true } = {}) {
    if (!alive() || quitBlocked() || !moved?.record || moved.record.contents.isDestroyed()) {
      throw new Error('This window cannot take the tab.')
    }
    const record = moved.record
    const id = list.add()
    const entry = { ...record, id, closing: false, retrying: false }
    try {
      attach(entry, { adopted: true })
    } catch (error) {
      unattach(entry)
      push()
      throw error
    }
    if (selectIt) select(id)
    else { showSelected(); push() }
    return id
  }

  // A secondary window with no tabs left closes.
  function closeIfEmpty() {
    if (!primary && alive() && entries.size === 0) host.close()
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
    const attempt = ++quitAttempt
    const current = (async () => {
      const order = [...list.ids().filter((id) => id !== HOME_ID), HOME_ID]
      for (const id of order) {
        // Another window (an email pop-out) may have stopped the quit, or
        // it was abandoned; keep the remaining tabs rather than closing them
        // for nothing.
        if (!isQuitting() || attempt !== quitAttempt) return false
        const entry = entries.get(id)
        if (entry && !(await closeAndWait(entry))) return false
      }
      return attempt === quitAttempt
    })().finally(() => { if (quitting === current) quitting = null })
    quitting = current
    return quitting
  }

  // A page that never answers its unsaved-work check holds the close loop.
  // Give up on it, so the next quit or update asks every page again.
  function abandonQuit() {
    if (!quitting) return
    quitAttempt++
    quitting = null
    for (const entry of entries.values()) entry.settle?.(false)
    if (!isQuitting()) resumeSelected()
  }

  // Startup tabs: adds each saved or chosen page after the existing tabs,
  // unloaded and unselected. Returns the tabs actually added.
  function restoreTabs(items) {
    const added = []
    if (!alive() || quitBlocked() || !Array.isArray(items)) return added
    for (const item of items) {
      if (!item || typeof item.url !== 'string' || !security.isAppUrl(item.url)) continue
      try {
        const entry = addTab({
          url: item.url, webPreferences: appPreferences(), afterId: null, background: true, lazy: true,
          provisional: { label: typeof item.label === 'string' ? item.label : null, url: canonicalUrl(item.url) },
        })
        entry.restored = true
        added.push({ id: entry.id, url: item.url })
      } catch {
        // addTab undid the failed tab; keep Home and the tabs already added.
        break
      }
    }
    return added
  }

  // Startup tabs: names restored tabs that are still unloaded with titles the
  // page resolved, or closes those the person can no longer open. A loaded
  // tab keeps its page's own title.
  function labelRestored(labels) {
    const result = { labeled: 0, closed: 0 }
    if (!alive() || quitBlocked() || !Array.isArray(labels)) return result
    for (const label of labels) {
      const target = label && canonicalUrl(label.url)
      if (!target) continue
      const entry = [...entries.values()].find((candidate) =>
        candidate.restored && candidate.pending && !candidate.closing && canonicalUrl(candidate.url) === target)
      if (!entry) continue
      if (label.unavailable === true) {
        if (closeTab(entry.id, { focus: false })) result.closed++
        continue
      }
      const title = typeof label.title === 'string' ? pageTitle(label.title) : ''
      if (!title) continue
      entry.provisional = title
      result.labeled++
    }
    push()
    return result
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

  // A tab's page as a browser link: its current address, which follows
  // in-page navigation, else its last approved one. A failed tab has none.
  function shareLink(entry) {
    if (entry.failed || entry.contents.isDestroyed()) return null
    const current = entry.contents.getURL()
    return shareableUrl(security.isAppUrl(current) ? current : entry.url, security.isAppUrl)
  }

  // The tab menu opens at a point in the strip; the link comes from main's
  // own state, never from the strip.
  function showTabMenu(id, x, y, keyboard) {
    const [width] = host.getContentSize()
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) ||
      x < 0 || x > width || y < 0 || y > STRIP_HEIGHT) return false
    const link = shareLink(entries.get(id))
    const quietly = (action) => () => { try { Promise.resolve(action()).catch(() => {}) } catch {} }
    const entry = entries.get(id)
    Menu.buildFromTemplate([
      { label: 'Copy link', enabled: !!link, click: quietly(() => clipboard.writeText(link)) },
      { label: 'Open in browser', enabled: !!link, click: quietly(() => openExternal(link)) },
      { type: 'separator' },
      // The shortcut is handled with the other tab keys; the menu only shows it.
      {
        label: 'Open in new window', accelerator: 'CmdOrCtrl+Shift+N', registerAccelerator: false,
        enabled: movable(entry, { newWindow: true }),
        // Checked again on click: the tab may have changed while the menu was open.
        click: quietly(() => { if (entries.get(id) === entry && movable(entry, { newWindow: true })) onNewWindow(id) }),
      },
    ]).popup({
      window: host, x, y, sourceType: keyboard ? 'keyboard' : 'mouse',
      // A click left the strip focused: give focus back to the page, as a
      // left-click would. A keyboard user stays on the tab they chose.
      callback: () => {
        const entry = selectedEntry()
        if (!keyboard && alive() && host.isFocused() && entry && !entry.failed && !entry.contents.isDestroyed()) entry.contents.focus()
      },
    })
    return true
  }

  function stripCommand(event, command, id, options) {
    if (!validStripSender(event)) return false
    if (command === 'new') return newTab(), true
    if (command === 'home') return primary && select(HOME_ID, { focus: options?.focus === true })
    if (command === 'reload') return dispatch('reload'), true
    if (command === 'restart-update' || command === 'retry-update') return onUpdateCommand(command), true
    if (!Number.isSafeInteger(id) || !entries.has(id)) return false
    if (command === 'select') return select(id, { focus: options?.focus === true })
    if (command === 'close') return closeTab(id, { focus: false })
    if (command === 'retry') return retry(id), true
    if (command === 'move') return Number.isSafeInteger(options?.position) && moveTab(id, options.position)
    if (command === 'menu') return showTabMenu(id, options?.x, options?.y, options?.keyboard === true)
    return false
  }

  function stripState(event) {
    return validStripSender(event) ? snapshot() : null
  }

  // The strip is a fixed local page: it never navigates or opens windows.
  strip.setWindowOpenHandler(() => ({ action: 'deny' }))
  strip.on('will-navigate', (event) => event.preventDefault())
  strip.on('will-redirect', (event) => event.preventDefault())
  strip.on('before-input-event', (event, input) => onInput(event, input, strip))
  // Windows gives keyboard focus to a window's own page when it is
  // activated (Alt+Tab, the taskbar, the tray). That page is empty here, so
  // focus goes back where it was: the strip, or the selected page.
  let stripHadFocus = false
  strip.on('focus', () => { stripHadFocus = true })
  host.on('focus', () => schedule(() => {
    if (!alive() || !host.webContents.isFocused()) return
    const entry = selectedEntry()
    if (stripHadFocus || !entry || entry.failed || entry.contents.isDestroyed()) strip.focus()
    else entry.contents.focus()
  }))
  // Keep the selected tab's name as the window title: the strip page's own
  // title must not replace it, also when it loads after the first tab.
  strip.on('page-title-updated', (event) => event.preventDefault())
  host.on('page-title-updated', (event) => event.preventDefault())
  const reloadStrip = () => { if (alive()) strip.loadURL(shellUrl).catch(() => {}) }
  strip.on('render-process-gone', () => schedule(reloadStrip))
  strip.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && url === shellUrl) schedule(reloadStrip)
  })
  // Closing the window hides it to the tray and keeps every tab. Quitting
  // closes the tabs first, Home last, then quits again with no tabs left.
  host.on('close', (event) => {
    // A secondary window with no tabs left just closes. With tabs, its
    // close button gives them back to the main window; in a quit the main
    // window takes them itself, and this window closes once empty.
    if (!primary) {
      if (entries.size === 0) return
      event.preventDefault()
      if (!isQuitting()) onCloseWindow()
      return
    }
    if (!isQuitting()) {
      event.preventDefault()
      host.hide()
      return
    }
    if (entries.size === 0) return
    event.preventDefault()
    // Another window may stop the quit while the last page closes; then the
    // loop finished but must not quit again.
    closeAllForQuit().then((closed) => {
      if (closed && isQuitting()) requestQuit()
      else {
        onQuitStopped()
        if (!isQuitting()) resumeSelected()
      }
    })
  })

  for (const name of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']) {
    host.on(name, layout)
  }

  let home = null
  let lastHomeUrl = null
  function createHome(url = null) {
    if (!primary) return
    home = addTab({ id: HOME_ID, webPreferences: appPreferences(), url, background: true })
    showSelected()
    onHome(home.contents, url)
  }
  createHome()
  // The window shows once its strip has loaded (its own page never does, so
  // it never reports ready-to-show).
  const readyCallbacks = []
  let ready = false
  const markReady = () => {
    if (ready) return
    ready = true
    for (const callback of readyCallbacks.splice(0)) { try { callback() } catch {} }
  }
  strip.once('did-finish-load', markReady)
  strip.once('did-fail-load', markReady)
  layoutStrip()
  strip.loadURL(shellUrl).catch(() => {})

  function dispose() {
    if (disposed) return
    for (const opener of [...watchedOpeners.keys()]) unwatchOpener(opener)
    linkLabels.clear()
    for (const entry of entries.values()) {
      if (!entry.contents.isDestroyed()) entry.contents.close()
    }
    readyCallbacks.length = 0
    if (!strip.isDestroyed()) strip.close()
    disposed = true
  }
  host.once('closed', dispose)

  return {
    window: host,
    // The strip's page: the only sender of strip commands for this window.
    strip,
    primary,
    // Calls back once the strip has loaded (at once if it already has).
    onceReady(callback) { if (ready) callback(); else readyCallbacks.push(callback) },
    get home() { return home?.contents ?? null },
    available: alive,
    openTab,
    newTab,
    select,
    selectHome: () => select(HOME_ID),
    // After a stopped quit closed Home, bring it back on its last page.
    ensureHome() { if (primary && alive() && !entries.has(HOME_ID)) createHome(lastHomeUrl) },
    dispatch,
    closeTab,
    closeAllForQuit,
    abandonQuit,
    linkLabel,
    reportTheme,
    stripCommand,
    stripState,
    // The updater changed: send the header its new view.
    refreshUpdate: push,
    // Dialog owner for a tab page; null when the page is not a tab.
    windowFor: (contents) => (entryFor(contents) && alive() ? host : null),
    isTab: (contents) => !!entryFor(contents),
    hasOpenTabs: () => entries.size > 0,
    restoreTabs,
    labelRestored,
    getSessionState: sessionState,
    // Several windows.
    movable: (id, options) => movable(entries.get(id), options),
    detachTab,
    adoptTab,
    closeIfEmpty,
    // Keyboard focus to the selected page, unless it shows the failed panel.
    focusSelected() {
      const entry = selectedEntry()
      if (alive() && entry && !entry.failed && !entry.contents.isDestroyed()) entry.contents.focus()
    },
    tabCount: () => entries.size,
    tabIds: () => list.ids().filter((id) => entries.has(id) && id !== HOME_ID),
    selectedId: () => list.selected(),
    // Tabs whose close was asked for and has not been answered yet.
    closingIds: () => [...entries.values()].filter((entry) => entry.closing).map((entry) => entry.id),
    theme: () => theme,
    unwatchOpener,
  }
}

module.exports = { createTabWindow, STRIP_HEIGHT, THEME_COLORS }

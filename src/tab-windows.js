// The Brinq windows that hold tabs: the main (primary) window with Home, and
// secondary windows that tabs were moved to. Routes each request to the
// window that owns its sender, and moves a live tab between windows.
//
// `create(options)` builds one tab window (createTabWindow with main's
// shared settings); the options this registry passes are `primary`,
// `bounds`, `theme`, `onNewWindow` and `onTabsChanged`.
// A new window shows when its strip first paints, or after this at most.
const SHOW_FALLBACK_MS = 1000

function createTabWindows({
  create, placement = () => undefined, onTabsChanged = () => {}, onWindowClosed = () => {},
  setTimer = setTimeout,
}) {
  // In creation order; the primary first while it is open.
  const windows = []
  let primary = null

  const alive = (tabWindow) => !!tabWindow && tabWindow.available()
  const forTab = (contents) => windows.find((tabWindow) => tabWindow.isTab(contents)) || null
  const forStrip = (contents) => windows.find((tabWindow) => !tabWindow.window.isDestroyed() &&
    tabWindow.strip === contents) || null
  const forHost = (window) => windows.find((tabWindow) => tabWindow.window === window) || null

  // The tab list for startup tabs: the main window's tabs after Home, then
  // each secondary window's, oldest window first.
  function sessionState() {
    const ordered = primary ? [primary, ...windows.filter((tabWindow) => tabWindow !== primary)] : windows
    return { tabs: ordered.flatMap((tabWindow) => tabWindow.getSessionState().tabs) }
  }
  const changed = () => { try { onTabsChanged(sessionState()) } catch {} }

  function add({ primary: isPrimary, bounds, theme }) {
    let tabWindow = null
    tabWindow = create({
      primary: isPrimary, bounds, theme,
      onNewWindow: (id) => moveToNewWindow(tabWindow, id),
      onTabsChanged: changed,
    })
    windows.push(tabWindow)
    if (isPrimary) primary = tabWindow
    tabWindow.window.once('closed', () => {
      const index = windows.indexOf(tabWindow)
      if (index !== -1) windows.splice(index, 1)
      if (primary === tabWindow) primary = null
      changed()
      onWindowClosed(tabWindow)
    })
    return tabWindow
  }

  // Moves one tab into a new window. The page keeps its document: nothing
  // reloads. If the new window cannot take it, the tab goes back where it
  // was, as it was, and the new window closes.
  function moveToNewWindow(source, id) {
    if (!alive(source) || !source.movable(id, { newWindow: true })) return false
    let target = null
    try {
      const open = windows.filter((tabWindow) => !tabWindow.primary && alive(tabWindow))
        .map((tabWindow) => tabWindow.window.getBounds())
      target = add({ primary: false, bounds: placement(source.window.getBounds(), open), theme: source.theme() })
    } catch {
      if (target && !target.window.isDestroyed()) target.window.destroy()
      return false
    }
    const moved = source.detachTab(id)
    if (!moved) {
      target.window.destroy()
      return false
    }
    try {
      target.adoptTab(moved)
    } catch {
      restore(source, moved)
      if (!target.window.isDestroyed()) target.window.destroy()
      return false
    }
    source.closeIfEmpty()
    const show = () => {
      if (!alive(target)) return
      target.window.show()
      target.window.focus()
      target.focusSelected()
    }
    // Shown once its strip has painted; a strip that is slow to paint does
    // not keep the window hidden.
    let shown = false
    const showOnce = () => { if (!shown) { shown = true; show() } }
    target.onceReady(showOnce)
    setTimer(showOnce, SHOW_FALLBACK_MS)
    return true
  }

  // A failed move puts the tab back. Should even that fail, the main window
  // takes it; a page that no window can show is closed rather than left
  // running unseen.
  function restore(source, moved) {
    const options = { position: moved.position, select: moved.selected }
    for (const [tabWindow, where] of [[source, options], [primary, {}]]) {
      if (!alive(tabWindow)) continue
      try { tabWindow.adoptTab(moved, where); return } catch {}
    }
    try { if (!moved.record.contents.isDestroyed()) moved.record.contents.close() } catch {}
  }

  return {
    get primary() { return primary },
    // Home's page, for startup tabs.
    get home() { return alive(primary) ? primary.home : null },
    all: () => [...windows],
    addPrimary: (options) => add({ ...options, primary: true }),
    forTab, forStrip, forHost,
    moveToNewWindow,
    // window-security's tab host: a new tab opens in its opener's window;
    // anything that is not a tab (a pop-out) opens one in the main window.
    available: () => alive(primary),
    openTab(args) {
      const owner = forTab(args.opener)
      return (alive(owner) ? owner : primary).openTab(args)
    },
    // Dialog owner for a tab page in any window; null when not a tab.
    windowFor: (contents) => forTab(contents)?.windowFor(contents) ?? null,
    isTab: (contents) => !!forTab(contents),
    // A page's link label waits in the window that will open its tab.
    linkLabel(event, payload) {
      const owner = forTab(event.sender)
      return (owner || primary)?.linkLabel(event, payload) ?? false
    },
    reportTheme: (contents, theme) => forTab(contents)?.reportTheme(contents, theme),
    stripCommand: (event, command, id, options) => forStrip(event.sender)?.stripCommand(event, command, id, options) ?? false,
    stripState: (event) => forStrip(event.sender)?.stripState(event) ?? null,
    refreshUpdate() { for (const tabWindow of windows) tabWindow.refreshUpdate() },
    getSessionState: sessionState,
    // Startup tabs restore into the main window; a restored tab may have
    // moved since, so its label is looked for in every window.
    restoreTabs: (items) => primary?.restoreTabs(items) ?? [],
    labelRestored(labels) {
      const result = { labeled: 0, closed: 0 }
      for (const tabWindow of windows) {
        const one = tabWindow.labelRestored(labels)
        result.labeled += one.labeled
        result.closed += one.closed
      }
      return result
    },
  }
}

module.exports = { createTabWindows, SHOW_FALLBACK_MS }

// The Brinq windows that hold tabs: the main (primary) window with Home, and
// secondary windows that tabs were moved to. Routes each request to the
// window that owns its sender, and moves a live tab between windows.
//
// There is one close path, the main window's: a secondary window's close
// button gives its tabs back to the main window, and a quit first moves
// every secondary window's tabs there, then the main window's quit loop
// asks every page, one at a time.
//
// `create(options)` builds one tab window (createTabWindow with main's
// shared settings); the options this registry passes are `primary`,
// `bounds`, `theme`, `onNewWindow`, `onCloseWindow`, `beforeQuitClose`,
// `canMove`, `movesHeld` and `onTabsChanged`.

// A new window shows when its strip has loaded, or after this at most.
const SHOW_FALLBACK_MS = 1000

function createTabWindows({
  create, placement = () => undefined, onTabsChanged = () => {}, onWindowClosed = () => {},
  isQuitting = () => false, canMove = () => true, setTimer = setTimeout,
}) {
  // In creation order; the primary first while it is open.
  const windows = []
  let primary = null

  const alive = (tabWindow) => !!tabWindow && tabWindow.available()
  const secondaries = () => windows.filter((tabWindow) => tabWindow !== primary)
  const forTab = (contents) => windows.find((tabWindow) => tabWindow.isTab(contents)) || null
  const forStrip = (contents) => windows.find((tabWindow) => !tabWindow.window.isDestroyed() &&
    tabWindow.strip === contents) || null
  const forHost = (window) => windows.find((tabWindow) => tabWindow.window === window) || null
  // While any page's close is waiting for its answer, no tab moves: a late
  // answer must never land on a tab in another window.
  const anyClosing = () => windows.some((tabWindow) => tabWindow.closingIds().length > 0)

  // The tab list for startup tabs: the main window's tabs after Home, then
  // each secondary window's, oldest window first (the order a quit puts
  // them in the main window).
  function sessionState() {
    const ordered = primary ? [primary, ...secondaries()] : windows
    return { tabs: ordered.flatMap((tabWindow) => tabWindow.getSessionState().tabs) }
  }
  const changed = () => { try { onTabsChanged(sessionState()) } catch {} }

  function add({ primary: isPrimary, bounds, theme }) {
    let tabWindow = null
    tabWindow = create({
      primary: isPrimary, bounds, theme,
      onNewWindow: (id) => moveToNewWindow(tabWindow, id),
      // Like any move, held while a page's close is unanswered; the person
      // can close the window again a moment later.
      onCloseWindow: () => { if (!anyClosing()) giveBack(tabWindow, { select: true }) },
      beforeQuitClose: () => prepareQuit(),
      canMove,
      movesHeld: anyClosing,
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

  // Moves one tab between windows in stages: take it out, add it to the
  // target, and only then let either window react (select a neighbour,
  // load a restored tab, close an empty window). Returns the tab's id in
  // the target, or null with the tab back where it was, as it was.
  function moveTab(source, id, target, { merging = false } = {}) {
    const moved = source.detachTab(id, { merging })
    if (!moved) return null
    let movedId
    try {
      movedId = target.adoptTab(moved, { select: false, merging })
    } catch {
      restore(source, moved)
      return null
    }
    moved.commit()
    return movedId
  }

  // A failed move puts the tab back. Should even that fail, the main window
  // takes it; a page that no window can show is closed rather than left
  // running unseen.
  function restore(source, moved) {
    const options = { position: moved.position, select: moved.selected, merging: true }
    for (const [tabWindow, where] of [[source, options], [primary, { merging: true }]]) {
      if (!alive(tabWindow)) continue
      try { tabWindow.adoptTab(moved, where); return } catch {}
    }
    try { if (!moved.record.contents.isDestroyed()) moved.record.contents.close() } catch {}
  }

  // Moves one tab into a new window. The page keeps its document: nothing
  // reloads. If the new window cannot take it, the tab stays where it was
  // and the new window closes.
  function moveToNewWindow(source, id) {
    if (!alive(source) || isQuitting() || !source.movable(id, { newWindow: true })) return false
    let target = null
    try {
      const open = secondaries().filter(alive).map((tabWindow) => tabWindow.window.getBounds())
      target = add({ primary: false, bounds: placement(source.window.getBounds(), open), theme: source.theme() })
    } catch {
      if (target && !target.window.isDestroyed()) target.window.destroy()
      return false
    }
    const movedId = moveTab(source, id, target)
    if (movedId === null) {
      target.window.destroy()
      return false
    }
    target.select(movedId)
    source.closeIfEmpty()
    let shown = false
    const show = () => {
      if (shown || !alive(target)) return
      shown = true
      target.window.show()
      target.window.focus()
      target.focusSelected()
    }
    // Shown once its strip has loaded; a slow strip does not keep it hidden.
    target.onceReady(show)
    setTimer(show, SHOW_FALLBACK_MS)
    return true
  }

  // A secondary window's tabs go back to the main window, after its tabs,
  // in order (a quit has already waited for every unanswered close in
  // secondary windows). The window closes once it has no tabs. Returns
  // whether every tab moved.
  function giveBack(source, { select = false } = {}) {
    if (!alive(primary) || source === primary || !alive(source)) return false
    const selectedId = source.selectedId()
    let selectedNow = null
    let all = true
    for (const id of source.tabIds()) {
      const movedId = moveTab(source, id, primary, { merging: true })
      if (movedId === null) all = false
      else if (id === selectedId) selectedNow = movedId
    }
    source.closeIfEmpty()
    if (select && selectedNow !== null) {
      primary.select(selectedNow)
      if (primary.window.isMinimized()) primary.window.restore()
      primary.window.show()
      primary.window.focus()
    }
    return all
  }

  // Before the main window's quit loop: closes already under way in
  // secondary windows finish first (Stay there stops the quit), then every
  // secondary window's tabs move to the main window. False stops the quit.
  async function prepareQuit() {
    const pending = secondaries().flatMap((tabWindow) => tabWindow.closingIds().map((id) => tabWindow.whenClosed(id)))
    if ((await Promise.all(pending)).some((closed) => !closed)) return false
    if (!isQuitting()) return false
    let all = true
    for (const tabWindow of secondaries()) all = giveBack(tabWindow) && all
    return all
  }

  return {
    get primary() { return primary },
    // Home's page, for startup tabs.
    get home() { return alive(primary) ? primary.home : null },
    all: () => [...windows],
    addPrimary: (options) => add({ ...options, primary: true }),
    forTab, forStrip, forHost,
    moveToNewWindow,
    giveBack,
    // window-security's tab host: a new tab opens in its opener's window;
    // anything that is not a tab (a pop-out) opens one in the main window.
    // During a quit no tab opens at all.
    available: () => alive(primary),
    quitting: () => isQuitting(),
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
    // An update restart's watchdog gave up: every window lets go.
    abandonQuit() { for (const tabWindow of windows) tabWindow.abandonQuit() },
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

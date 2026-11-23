// The Brinq windows that hold tabs: the main (primary) window with Home, and
// secondary windows that tabs were moved to. Routes each request to the
// window that owns its sender, and moves a live tab between windows.
//
// There is one close path, the main window's: a secondary window's close
// button gives its tabs back to the main window, and Brinq does not quit
// while a secondary window has tabs (`blocksQuit`, used by main.js).
//
// `create(options)` builds one tab window (createTabWindow with main's
// shared settings); the options this registry passes are `primary`,
// `bounds`, `theme`, `onNewWindow`, `onCloseWindow`, `canMove`,
// `movesHeld` and `onTabsChanged`.

// A new window shows when its strip has loaded, or after this at most.
const SHOW_FALLBACK_MS = 1000

function createTabWindows({
  create, placement = () => undefined, onTabsChanged = () => {}, onWindowClosed = () => {},
  isQuitting = () => false, canMove = () => true, setTimer = setTimeout,
  // Drag and drop: the pointer's screen point (DIP), where a window made
  // by a drop opens (`placeAt(sourceBounds, point)`), and whether a window
  // can take a dropped tab now (no Save As dialog open on it).
  cursorPoint = () => null, placeAt = (source) => source, canReceive = () => true,
}) {
  // In creation order; the primary first while it is open.
  const windows = []
  let primary = null
  // Most recently focused first: the best guess at which window is in
  // front, as Electron gives no stacking order.
  const focusOrder = []

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
      canMove,
      movesHeld: anyClosing,
      onTabsChanged: changed,
      onDragEnd: (id) => { dropTab(tabWindow, id).catch(() => {}) },
    })
    windows.push(tabWindow)
    focusOrder.push(tabWindow)
    if (isPrimary) primary = tabWindow
    tabWindow.window.on('focus', () => {
      const index = focusOrder.indexOf(tabWindow)
      if (index !== -1) focusOrder.splice(index, 1)
      focusOrder.unshift(tabWindow)
    })
    tabWindow.window.once('closed', () => {
      const index = windows.indexOf(tabWindow)
      if (index !== -1) windows.splice(index, 1)
      const focused = focusOrder.indexOf(tabWindow)
      if (focused !== -1) focusOrder.splice(focused, 1)
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
  function moveTab(source, id, target, { merging = false, position = null } = {}) {
    const moved = source.detachTab(id, { merging })
    if (!moved) return null
    let movedId
    try {
      movedId = target.adoptTab(moved, { select: false, position })
    } catch {
      restore(moved)
      return null
    }
    moved.commit()
    return movedId
  }

  // A failed move puts the tab back exactly as it was. Should even that
  // fail, the main window takes it; a page that no window can show is
  // closed rather than left running unseen.
  function restore(moved) {
    try { moved.undo(); return } catch {}
    if (alive(primary)) {
      try { primary.adoptTab(moved, { select: false }); return } catch {}
    }
    try { if (!moved.record.contents.isDestroyed()) moved.record.contents.close() } catch {}
  }

  // Moves one tab into a new window. The page keeps its document: nothing
  // reloads. If the new window cannot take it, the tab stays where it was
  // and the new window closes.
  // `at`: a drop's screen point; the window opens there instead of where
  // the last one was left.
  function moveToNewWindow(source, id, { at = null } = {}) {
    if (!alive(source) || isQuitting() || !source.movable(id, { newWindow: true })) return false
    let target = null
    try {
      const open = secondaries().filter(alive).map((tabWindow) => tabWindow.window.getBounds())
      const bounds = at ? placeAt(source.window.getBounds(), at) : placement(source.window.getBounds(), open)
      target = add({ primary: false, bounds, theme: source.theme() })
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

  const contains = (area, point) => !!area && point.x >= area.x && point.x < area.x + area.width &&
    point.y >= area.y && point.y < area.y + area.height
  // A window that can be seen now: a drop never lands in a hidden one.
  const shown = (tabWindow) => alive(tabWindow) && tabWindow.window.isVisible() && !tabWindow.window.isMinimized()

  // The tab window whose strip is under `point`, or null. The window in
  // front at that point is found first (by focus order); only its strip
  // counts, so a strip covered by another Brinq window never takes a drop.
  function stripAt(point) {
    const front = focusOrder.find((tabWindow) => shown(tabWindow) && contains(tabWindow.contentArea(), point))
    if (!front) return null
    const area = front.contentArea()
    return point.y < area.y + front.stripBand ? front : null
  }

  // Whether `target` can take a dropped tab now.
  const receives = (target) => shown(target) && !isQuitting() && !anyClosing() && canReceive(target.window)

  // A tab dragged out of its strip was let go. Main reads the pointer: over
  // another window's strip, the tab joins that window where its strip says;
  // over its own strip nothing happens; anywhere else it opens in a new
  // window there (not the only tab of a secondary window: that snaps back).
  // Every refusal leaves the tab where it was.
  let dropping = false
  async function dropTab(source, id) {
    if (dropping || !alive(source) || isQuitting() || !source.movable(id)) return false
    const point = cursorPoint()
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false
    const target = stripAt(point)
    if (target === source) return false
    if (!target) return moveToNewWindow(source, id, { at: { x: Math.round(point.x), y: Math.round(point.y) } })
    if (!receives(target)) return false
    dropping = true
    let position
    try {
      position = await target.requestSlot(Math.round(point.x - target.contentArea().x))
    } finally {
      dropping = false
    }
    // Everything is checked again: the answer took a moment.
    if (position === null || !alive(source) || !source.movable(id) || !receives(target)) return false
    const movedId = moveTab(source, id, target, { position })
    if (movedId === null) return false
    target.select(movedId)
    if (target.window.isMinimized()) target.window.restore()
    target.window.show()
    target.window.focus()
    target.focusSelected()
    source.closeIfEmpty()
    return true
  }

  // A secondary window's tabs go back to the main window, after its tabs,
  // in order. The window closes once it has no tabs. Returns whether every
  // tab moved.
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

  return {
    get primary() { return primary },
    // Home's page, for startup tabs.
    get home() { return alive(primary) ? primary.home : null },
    all: () => [...windows],
    addPrimary: (options) => add({ ...options, primary: true }),
    forTab, forStrip, forHost,
    moveToNewWindow,
    dropTab,
    giveBack,
    // Brinq quits only from the main window: while a secondary window has
    // tabs, a quit or update restart is refused (main.js says why).
    blocksQuit: () => secondaries().some((tabWindow) => !tabWindow.window.isDestroyed() && tabWindow.tabCount() > 0),
    // window-security's tab host: a new tab opens in its opener's window;
    // anything that is not a tab (a pop-out) opens one in the main window.
    // During a quit no tab opens at all.
    available: () => alive(primary),
    quitting: () => isQuitting(),
    // A link menu's Open in new tab: a tab can open now.
    canOpenTab: () => alive(primary) && !isQuitting(),
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

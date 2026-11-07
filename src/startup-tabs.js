// Startup tabs: what opens after Home when Brinq Desktop starts in Full App
// Mode. Home only (the default), the tabs from last time, or chosen Brinq
// sections. The web app reports the signed-in user and the sections they can
// open; Desktop never builds Brinq addresses or decides access itself.
const { linkLabelText, shareableUrl } = require('./tabs')

const CHOICES = ['home', 'last', 'pages']
// ST7: tabs restored after Home, and pages a person may choose.
const MAX_TABS = 8
// Shape guards with headroom over today's navigation (10 Workspace, 2
// Reports, 3 Account items; at most 5 paths each), not measured budgets.
const MAX_SECTIONS = 32
const MAX_PATHS = 8
const MAX_PATH_LENGTH = 200
const MAX_USER_ID = 64
const KEY = /^[a-z][a-z0-9-]{0,39}$/
// Sign-in, callback and native-viewer pages never reopen as tabs.
const EXCLUDED_ROOTS = ['/login', '/desktop-sign-in', '/oauth', '/gmail', '/o365', '/rc', '/api', '/email/file-viewer']
// Groups a burst of navigation and reordering into one small store write.
// An unmeasured, reversible choice, covered by fake-clock tests.
const SAVE_DELAY_MS = 1000

const SAVE_FAILED = "Brinq Desktop couldn't save that startup choice. Reopen Settings and try again."
const tooManyPages = (count) =>
  `Up to ${MAX_TABS} pages can open at startup, and ${count} are chosen. Deselect a page and try again.`

const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value)
// Control characters and backslashes never belong in a Brinq path.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f\\]/
const under = (pathname, root) => pathname === root || pathname.startsWith(`${root}/`)
const excluded = (pathname) => EXCLUDED_ROOTS.some((root) => under(pathname, root))

const defaultStartup = () => ({ choice: 'home', pages: [] })

function validPages(pages) {
  return Array.isArray(pages) && pages.every((key) => typeof key === 'string' && KEY.test(key)) &&
    new Set(pages).size === pages.length
}

// A saved choice. Anything corrupt or unknown means Home only.
function parseStartup(value) {
  if (!isRecord(value) || !CHOICES.includes(value.choice) || !validPages(value.pages) || value.pages.length > MAX_TABS) {
    return defaultStartup()
  }
  return { choice: value.choice, pages: [...value.pages] }
}

// The last session: who it belongs to and its tabs' addresses. Unknown keys,
// including a legacy selection, are dropped; a bad shape is no session.
function parseSession(value) {
  if (!isRecord(value) || !validUserId(value.userId) || !Array.isArray(value.tabs)) return null
  const tabs = []
  for (const tab of value.tabs) {
    if (!isRecord(tab) || typeof tab.url !== 'string') return null
    tabs.push({ url: tab.url })
  }
  return { userId: value.userId, tabs }
}

function validUserId(value) {
  return typeof value === 'string' && value.trim() === value && value.length >= 1 &&
    value.length <= MAX_USER_ID && !UNSAFE.test(value)
}

// A root-relative Brinq address or path, resolved against the app's origin.
function resolve(value, baseUrl) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || UNSAFE.test(value)) return null
  try { return new URL(value, baseUrl) } catch { return null }
}

// The sections the signed-in person can open, as the web app reports them.
// Returns null unless every field is valid.
function validSections(sections, { baseUrl, isAppUrl }) {
  if (!Array.isArray(sections) || sections.length < 1 || sections.length > MAX_SECTIONS) return null
  const keys = new Set()
  const result = []
  for (const section of sections) {
    if (!isRecord(section) || typeof section.key !== 'string' || !KEY.test(section.key) || keys.has(section.key)) return null
    keys.add(section.key)
    const label = linkLabelText(section.label)
    if (!label) return null
    const href = resolve(section.href, baseUrl)
    if (!href || !isAppUrl(href.href) || excluded(href.pathname)) return null
    const { paths } = section
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_PATHS || new Set(paths).size !== paths.length) return null
    for (const value of paths) {
      if (typeof value !== 'string' || value.length > MAX_PATH_LENGTH || value === '/' || /[?#]/.test(value)) return null
      const resolved = resolve(value, baseUrl)
      // Canonical only: no dot segments, encodings or a trailing slash.
      if (!resolved || resolved.pathname !== value || value.endsWith('/') || excluded(value)) return null
    }
    if (!paths.some((root) => under(href.pathname, root))) return null
    result.push({ key: section.key, label, url: href.href, paths: [...paths] })
  }
  return result
}

// The section whose path holds this address most specifically.
function sectionFor(pathname, sections) {
  let best = null
  let length = -1
  for (const section of sections) {
    for (const root of section.paths) {
      if (under(pathname, root) && root.length > length) { best = section; length = root.length }
    }
  }
  return best
}

// Addresses to save or restore: Brinq app pages only, without the
// desktop-only `standalone` parameter, no repeats, in order.
function tabAddresses(urls, isAppUrl, limit = MAX_TABS) {
  const seen = new Set()
  const result = []
  for (const value of urls) {
    const url = shareableUrl(value, isAppUrl)
    if (!url) continue
    const { pathname } = new URL(url)
    if (excluded(pathname) || seen.has(url)) continue
    seen.add(url)
    result.push(url)
    if (result.length === limit) break
  }
  return result
}

// The tabs to open after Home, each with its section's name until the page
// names it. Navigation roots group pages; they never authorize a record.
function pickTabs({ startup, session, sections, userId, homeUrl, isAppUrl }) {
  let candidates = []
  if (startup.choice === 'pages') {
    const chosen = new Set(startup.pages)
    candidates = sections.filter((section) => chosen.has(section.key)).map((section) => section.url)
  } else if (startup.choice === 'last' && session && session.userId === userId) {
    candidates = session.tabs.map((tab) => tab.url)
  } else {
    return []
  }
  const homePath = (() => { try { return new URL(homeUrl).pathname } catch { return null } })()
  const picked = []
  for (const url of tabAddresses(candidates, isAppUrl, Infinity)) {
    const { pathname } = new URL(url)
    if (pathname === homePath) continue
    const section = sectionFor(pathname, sections)
    if (!section) continue
    picked.push({ url, label: section.label })
    if (picked.length === MAX_TABS) break
  }
  return picked
}

function validLabels(labels) {
  if (!Array.isArray(labels) || labels.length > MAX_TABS) return null
  const seen = new Set()
  const result = []
  for (const label of labels) {
    if (!isRecord(label) || typeof label.url !== 'string') return null
    let canonical
    try { canonical = new URL(label.url).href } catch { return null }
    if (seen.has(canonical)) return null
    seen.add(canonical)
    if (label.unavailable === true && !('title' in label)) result.push({ url: canonical, unavailable: true })
    else if (typeof label.title === 'string' && !('unavailable' in label)) result.push({ url: canonical, title: label.title })
    else return null
  }
  return result
}

function installStartupTabs({
  ipcMain, app, security, config, tabWindow, baseUrl, desktopState,
  timers = { setTimeout, clearTimeout }, log = () => {},
}) {
  const isAppUrl = security.isAppUrl
  // Process-lifetime launch state. Reloading or recreating Home never resets it.
  const launch = {
    consumed: false,
    owner: null,
    // Recording is allowed for this launch's owner in Full App Mode.
    eligible: false,
    // A different user reported later; nothing more is saved or labelled.
    disarmed: false,
    labels: null,
  }
  let timer = null
  let paused = false
  let pending = null
  let lastSaved = null

  const cancel = () => {
    if (timer !== null) timers.clearTimeout(timer)
    timer = null
    pending = null
  }
  const recording = () => launch.eligible && !launch.disarmed && !paused && !app.isQuitting &&
    config.getMode() === 'full' && config.getStartup().choice === 'last'
  const snapshotKey = (urls) => JSON.stringify(urls)

  function write(urls) {
    if (!recording()) return
    try {
      config.setLastSession({ userId: launch.owner, tabs: urls.map((url) => ({ url })) })
      lastSaved = snapshotKey(urls)
    } catch {
      log('session-save-failed')
    }
  }

  // Each change to the tab list, after the tab window coalesces it.
  function onTabsChanged(state) {
    if (!recording() || !isRecord(state) || !Array.isArray(state.tabs)) return
    const urls = tabAddresses(state.tabs.map((tab) => tab?.url), isAppUrl)
    const key = snapshotKey(urls)
    if (key === lastSaved && pending === null) return
    pending = urls
    if (timer !== null) timers.clearTimeout(timer)
    timer = timers.setTimeout(() => {
      timer = null
      const urlsToSave = pending
      pending = null
      if (urlsToSave) write(urlsToSave)
    }, SAVE_DELAY_MS)
  }

  function currentUrls() {
    const state = tabWindow()?.getSessionState?.()
    return Array.isArray(state?.tabs) ? tabAddresses(state.tabs.map((tab) => tab?.url), isAppUrl) : null
  }

  // The first quit request saves the tabs as they are, before any closes.
  // The quit's later passes see tabs closing and save nothing.
  app.on('before-quit', (event) => {
    if (event.defaultPrevented || paused) return
    const urls = launch.eligible && !launch.disarmed ? currentUrls() : null
    cancel()
    if (urls && config.getMode() === 'full' && config.getStartup().choice === 'last') {
      try {
        config.setLastSession({ userId: launch.owner, tabs: urls.map((url) => ({ url })) })
        lastSaved = snapshotKey(urls)
      } catch {
        log('session-save-failed')
      }
    }
    paused = true
  })

  // A quit that stopped (Stay, a stalled or failed update) keeps the saved
  // tabs until the next real change, so a half-closed quit never overwrites
  // them.
  function resume() {
    if (!paused || app.isQuitting) return
    paused = false
    const urls = currentUrls()
    lastSaved = urls ? snapshotKey(urls) : lastSaved
  }

  function fromHome(event) {
    const window = tabWindow()
    return !!window?.available?.() && event.sender === window.home && security.validateSender(event, ['main'])
  }

  ipcMain.handle('set-startup', (event, value) => {
    if (!security.validateSender(event)) return { ok: false, error: 'Unauthorized sender.' }
    if (isRecord(value) && Array.isArray(value.pages) && value.pages.length > MAX_TABS && validPages(value.pages)) {
      return { ok: false, error: tooManyPages(value.pages.length), state: desktopState() }
    }
    if (!isRecord(value) || !CHOICES.includes(value.choice) || !validPages(value.pages)) {
      return { ok: false, error: SAVE_FAILED, state: desktopState() }
    }
    const startup = { choice: value.choice, pages: [...value.pages] }
    try {
      config.saveStartup(startup, { clearSession: startup.choice !== 'last' })
    } catch {
      log('startup-save-failed')
      return { ok: false, error: SAVE_FAILED, state: desktopState() }
    }
    if (startup.choice !== 'last') {
      cancel()
      lastSaved = null
    } else {
      // Choosing it mid-launch saves from now on; it opens nothing now.
      const urls = currentUrls()
      if (urls) { lastSaved = null; onTabsChanged({ tabs: urls.map((url) => ({ url })) }) }
    }
    return { ok: true, state: desktopState() }
  })

  ipcMain.handle('open-startup-tabs', (event, request) => {
    const none = { opened: 0, tabs: [] }
    if (!fromHome(event) || !isRecord(request) || !validUserId(request.userId)) return none
    const sections = validSections(request.sections, { baseUrl, isAppUrl })
    if (!sections) return none
    if (launch.consumed) {
      if (request.userId !== launch.owner && !launch.disarmed) {
        launch.disarmed = true
        launch.labels = null
        cancel()
      }
      return none
    }
    launch.consumed = true
    launch.owner = request.userId
    if (config.getMode() !== 'full') return none
    let startup = defaultStartup()
    let session = null
    try {
      startup = config.getStartup()
      session = startup.choice === 'last' ? config.getLastSession() : null
    } catch {
      log('startup-read-failed')
    }
    const window = tabWindow()
    const picked = pickTabs({ startup, session, sections, userId: request.userId, homeUrl: event.sender.getURL(), isAppUrl })
    const added = picked.length ? window.restoreTabs(picked) : []
    launch.labels = added.length ? {
      stillAuthorized: security.captureSender(event, ['main']),
      home: event.sender,
      urls: new Set(added.map((tab) => new URL(tab.url).href)),
    } : null
    launch.eligible = true
    const urls = currentUrls()
    if (urls) lastSaved = snapshotKey(urls)
    return { opened: added.length, tabs: added.map((tab) => tab.url) }
  })

  ipcMain.handle('label-startup-tabs', (event, labels) => {
    const none = { labeled: 0, closed: 0 }
    const auth = launch.labels
    if (!auth || launch.disarmed || paused || app.isQuitting) return none
    if (!fromHome(event) || event.sender !== auth.home || !auth.stillAuthorized()) return none
    const valid = validLabels(labels)
    if (!valid || !valid.every((label) => auth.urls.has(label.url))) return none
    if (!valid.length) return none
    return tabWindow().labelRestored(valid)
  })

  return { onTabsChanged, resume }
}

module.exports = {
  installStartupTabs, parseStartup, parseSession, validSections, pickTabs, tabAddresses,
  MAX_TABS, SAVE_DELAY_MS, EXCLUDED_ROOTS,
}

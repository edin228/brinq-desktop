#!/usr/bin/env node
// Verifies the tab window against real Electron behavior, or serves the static
// strip harness for visual comparison.
//
//   npx electron scripts/verify-tab-window.js [--no-sandbox]
//   node scripts/verify-tab-window.js --visual-only --port 8765
//
// The Electron run uses the production tab window, window security and app
// preload with synthetic pages on an ephemeral loopback server. It never
// signs in, writes files or contacts the update feed.
const http = require('http')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const argv = process.argv.slice(2)

// --- Visual harness server -------------------------------------------------
// Serves only the strip harness, the strip's CSS/JS and the bundled font.
const VISUAL_FILES = {
  '/scripts/visual/tab-strip.html': ['scripts/visual/tab-strip.html', 'text/html; charset=utf-8'],
  '/scripts/visual/tab-strip.js': ['scripts/visual/tab-strip.js', 'text/javascript; charset=utf-8'],
  '/src/shell/shell.html': ['src/shell/shell.html', 'text/html; charset=utf-8'],
  '/src/shell/shell.css': ['src/shell/shell.css', 'text/css; charset=utf-8'],
  '/src/shell/shell.js': ['src/shell/shell.js', 'text/javascript; charset=utf-8'],
  '/assets/fonts/inter-latin-wght-normal.woff2': ['assets/fonts/inter-latin-wght-normal.woff2', 'font/woff2'],
}

function serveVisual(port) {
  const server = http.createServer((request, response) => {
    const entry = VISUAL_FILES[new URL(request.url, 'http://localhost').pathname]
    if (!entry || request.method !== 'GET') {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('Not found')
      return
    }
    response.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-store' })
    fs.createReadStream(path.join(ROOT, entry[0])).pipe(response)
  })
  server.listen(port, '0.0.0.0', () => {
    console.log(`Strip harness: http://localhost:${port}/scripts/visual/tab-strip.html?state=home-hover&theme=dark`)
  })
  const stop = () => server.close(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

if (argv.includes('--visual-only')) {
  const index = argv.indexOf('--port')
  serveVisual(index === -1 ? 8765 : Number(argv[index + 1]))
  return
}

// --- Electron verification -------------------------------------------------
const { app, BrowserWindow, WebContentsView, Menu, clipboard, ipcMain, desktopCapturer, screen, webContents: allContents } = require('electron')
const { pathToFileURL } = require('url')
const { createWindowSecurity } = require('../src/window-security')
const { createTabWindow } = require('../src/tab-window')
const { createTabWindows } = require('../src/tab-windows')
const { boundsAtPoint } = require('../src/window-state')
const { installQuitGuard } = require('../src/quit-app')

const page = (title, body, script = '') => `<!doctype html><html class="light"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:14px sans-serif;margin:20px} a,button,input{display:block;margin:8px 0;padding:6px}</style></head>
<body>${body}<script>document.body.dataset.ran='yes';${script}</script></body></html>`

const ROUTES = {
  '/home': page('brinq | Home', `
    <a id="client" href="/clients/1">Client one</a>
    <button id="blank" onclick="window.open('/clients/2','_blank','noopener,noreferrer')">Open blank</button>
    <button id="popout" onclick="window.open('/email/1','email-1','width=900,height=600')">Pop out email</button>
    <form id="post" method="post" action="/clients/posted" target="_blank"><button id="post-submit">Post</button></form>
    <iframe id="frame" sandbox="allow-popups" src="/framed" style="width:300px;height:80px"></iframe>`),
  // The frame runs no scripts, so its link fills the frame to be clickable.
  '/framed': page('frame', '<a id="framed-link" href="/clients/3" style="position:fixed;inset:0;margin:0">Framed link</a>'),
  // Link labels: the target pages start with a brand-only title and name
  // themselves later, like a client page loading its data.
  // The page times how long each Ctrl+click is held up: its window capture
  // listener runs before the preload's document capture listener (which waits
  // for the synchronous reply), its bubble listener after.
  '/labels': page('brinq | Labels', `
    <a id="labeled" data-tab-label="Acme Holdings" href="/slow-client">Acme <span>SERVICE_CENTER</span></a>
    <a id="plain" href="/slow-other">Blue Ridge   Bakery</a>
    <a id="search" data-tab-label="Northwind Dental" href="/slow-search">Northwind search row</a>`, `
    window.blocked = []
    window.addEventListener('click', (event) => { if (event.ctrlKey) window.clickStart = performance.now() }, true)
    document.addEventListener('click', (event) => { if (event.ctrlKey) window.blocked.push(performance.now() - window.clickStart) })
    document.getElementById('search').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.ctrlKey) {
        event.preventDefault()
        window.open('/slow-search', '_blank', 'noopener,noreferrer')
      }
    })`),
  '/slow-client': page('brinq', '<p>Loading client</p>', `setTimeout(() => { document.title = 'brinq | Acme Holdings, LLC' }, 1500)`),
  '/slow-other': page('brinq', '<p>Loading</p>'),
  '/slow-search': page('brinq', '<p>Loading</p>'),
  // Open in new window: a page with state of its own, a colour the screen
  // capture can find, a child link and unsaved work once typed into.
  '/stateful': `<!doctype html><html><head><meta charset="utf-8"><title>brinq | Stateful</title>
<style>html,body{margin:0;height:100%;background:#ff00aa;font:14px sans-serif} input,button{display:block;margin:20px}</style></head>
<body><input id="text"><button id="child" onclick="window.open('/clients/9','_blank','noopener,noreferrer')">Child</button>
<script>window.state = Math.random(); document.getElementById('text').addEventListener('input', () => {
  window.onbeforeunload = (event) => { event.preventDefault(); event.returnValue = '' } })</script></body></html>`,
  '/dirty': page('brinq | Draft', '<input id="draft" value="">', `
    document.getElementById('draft').addEventListener('input', () => {
      window.onbeforeunload = (event) => { event.preventDefault(); event.returnValue = '' }
    })`),
}

async function main() {
  // Requests per route, so lazy tabs can be shown to fetch nothing.
  const requests = {}
  const server = http.createServer((request, response) => {
    const route = new URL(request.url, 'http://localhost').pathname
    requests[route] = (requests[route] || 0) + 1
    if (route === '/broken') { request.socket.destroy(); return }
    const body = ROUTES[route] || page(`brinq | ${route}`, `<p>${route}</p>`)
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const shellUrl = pathToFileURL(path.join(ROOT, 'src', 'shell', 'shell.html')).href
  const security = createWindowSecurity({ baseUrl: base, preloadPath: path.join(ROOT, 'src', 'preload.js'), openExternal: () => {} })
  const answers = []
  const prompts = []
  const promptOwners = []
  const dialog = { showMessageBoxSync: (owner, options) => { prompts.push(options.message); promptOwners.push(owner); return answers.shift() ?? 1 } }
  const themes = []
  let quitStops = 0
  // The real Menu and clipboard; each menu is kept to read and close it.
  const menus = []
  const recordingMenu = {
    buildFromTemplate(template) {
      const menu = Menu.buildFromTemplate(template)
      const record = { menu, shown: false }
      menu.once('menu-will-show', () => { record.shown = true })
      menu.once('menu-will-close', () => { record.closed = true })
      const popup = menu.popup.bind(menu)
      menu.popup = (options) => { record.options = options; popup(options) }
      menus.push(record)
      return menu
    },
  }
  const opened = []
  // Windows are made the way main.js makes them: through tabWindows.
  let tabs = null
  const tabWindows = createTabWindows({
    // The registry's own options (primary, bounds, theme and the move, close
    // and quit hooks) go through as main.js passes them.
    create: ({ theme, ...registryOptions }) => createTabWindow({
      ...registryOptions,
      electron: { BrowserWindow, WebContentsView, dialog, Menu: recordingMenu, clipboard },
      openExternal: (url) => { opened.push(url) },
      security,

      preloadPath: path.join(ROOT, 'src', 'preload.js'),
      shellPreloadPath: path.join(ROOT, 'src', 'shell-preload.js'),
      shellUrl,
      theme,
      newTabUrl: () => tabs.home.getURL(),
      onTheme: (value) => themes.push(value),
      onHome: (contents) => contents.loadURL(`${base}/home`),
      // The same quit wiring main.js uses, with the real app.quit().
      isQuitting: () => !!app.isQuitting,
      requestQuit: () => app.quit(),
      onQuitStopped: () => { quitStops++; app.isQuitting = false; tabs.window.show() },
    }),
    placement: (source) => ({ ...source, x: source.x + 640, y: source.y + 60, width: 900, height: 700 }),
    isQuitting: () => !!app.isQuitting,
    // Dropping a dragged tab, as main.js: the real pointer and monitor.
    cursorPoint: () => screen.getCursorScreenPoint(),
    placeAt: (source, point) => boundsAtPoint({ size: source, point, workArea: screen.getDisplayNearestPoint(point).workArea }),
  })
  tabs = tabWindows.addPrimary({ bounds: { width: 1200, height: 800, x: 0, y: 0 }, theme: 'light' })
  // As main.js: no quit while another window has tabs (registered first).
  let quitsRefused = 0
  installQuitGuard({ app, blocked: () => tabWindows.blocksQuit(), onRefused: () => { quitsRefused++ } })
  app.on('before-quit', (event) => { if (!event.defaultPrevented) app.isQuitting = true })
  app.on('window-all-closed', () => {})
  // Same forwarding as main.js, with timings for the label-to-open gap.
  const labelTimes = []
  const openTimes = []
  ipcMain.on('link-label', (event, payload) => {
    let stored = false
    try { stored = !!tabWindows.linkLabel(event, payload) } catch { stored = false } finally { event.returnValue = stored }
    if (stored) labelTimes.push(performance.now())
  })
  security.setTabHost({
    available: tabWindows.available,
    openTab: (args) => { openTimes.push(performance.now()); return tabWindows.openTab(args) },
  })
  ipcMain.on('tabs:command', (event, command, id, options) => tabWindows.stripCommand(event, command, id, options))
  ipcMain.handle('tabs:state', (event) => tabWindows.stripState(event))
  ipcMain.on('theme-changed', (event, theme) => {
    if (security.validateSender(event)) tabWindows.reportTheme(event.sender, theme)
  })
  const host = tabs.window
  host.show()

  const results = []
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: !!ok })
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (predicate, timeout = 8000) => {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      if (await predicate()) return true
      await wait(50)
    }
    return false
  }
  const stripState = () => tabs.strip.executeJavaScript(`({
    labels: [...document.querySelectorAll('.tab-label')].map((node) => node.textContent),
    selected: document.querySelector('.home').getAttribute('aria-selected') === 'true' ? 'home'
      : document.querySelector('.tab.selected .tab-label')?.textContent ?? null,
    theme: document.documentElement.dataset.theme,
    panel: !document.querySelector('.panel').hidden,
  })`)
  const tabPages = () => allContents.getAllWebContents().filter((wc) => tabs.isTab(wc) && wc !== tabs.home)
  const click = async (contents, selector, modifiers = [], button = 'left') => {
    const point = await contents.executeJavaScript(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)})
      const box = element.getBoundingClientRect()
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
    })()`)
    contents.focus()
    for (const type of ['mouseDown', 'mouseUp']) {
      contents.sendInputEvent({ type, x: point.x, y: point.y, button, clickCount: 1, modifiers })
    }
  }
  // Sandboxed frames run in their own process and synthetic input does not
  // reach them, so this click uses real X input when XDOTOOL is provided.
  const framedClick = async () => {
    const point = await tabs.home.executeJavaScript(`(() => { const box = document.getElementById('frame').getBoundingClientRect(); return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) } })()`)
    const content = host.getContentBounds()
    const x = String(content.x + point.x)
    const y = String(content.y + 40 + point.y)
    require('child_process').execFileSync(process.env.XDOTOOL, ['mousemove', x, y, 'keydown', 'ctrl', 'click', '1', 'keyup', 'ctrl'])
  }

  // A pixel of the screen, read through the real compositor: proves what a
  // window actually shows, not only what its pages hold.
  const screenPixel = async (x, y) => {
    const [source] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1600, height: 1000 } })
    const bitmap = source.thumbnail.toBitmap()
    const { width } = source.thumbnail.getSize()
    const at = (y * width + x) * 4
    return [bitmap[at + 2], bitmap[at + 1], bitmap[at]]
  }
  const stripOf = (tabWindow) => tabWindow.strip
  const stripDom = (tabWindow) => stripOf(tabWindow).executeJavaScript(`({
    labels: [...document.querySelectorAll('.tab-label')].map((node) => node.textContent),
    home: !document.querySelector('.home').hidden && getComputedStyle(document.querySelector('.home')).display !== 'none',
    selected: document.querySelector('.tab.selected .tab-label')?.textContent ?? null,
  })`)

  async function openInNewWindow() {
    const windowsBefore = BrowserWindow.getAllWindows().length
    const page = tabs.openTab({ opener: tabs.home, url: `${base}/stateful`, options: { webPreferences: {} }, referrer: { url: '', policy: 'default' }, background: false })
    await until(() => !page.isLoading() && page.getURL().endsWith('/stateful'))
    await click(page, '#text')
    for (const keyCode of ['h', 'i']) page.sendInputEvent({ type: 'char', keyCode })
    await until(() => page.executeJavaScript('document.getElementById("text").value === "hi"'))
    const state = await page.executeJavaScript('window.state')
    const requested = requests['/stateful']
    const id = tabs.stripState({ sender: tabs.strip, senderFrame: tabs.strip.mainFrame }).selectedId
    // The tab menu offers it; Ctrl+Shift+N in the page does it.
    await tabs.strip.executeJavaScript(`document.querySelector('.tab.selected').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 20, button: 2 }))`)
    await until(() => menus.at(-1)?.shown)
    const item = menus.at(-1).menu.items.find((entry) => entry.label === 'Open in new window')
    check('the tab menu offers Open in new window, enabled, with its shortcut', item?.enabled === true && item.accelerator === 'CmdOrCtrl+Shift+N')
    menus.at(-1).menu.closePopup(host)
    await wait(200)
    page.focus()
    for (const type of ['keyDown', 'keyUp']) page.sendInputEvent({ type, keyCode: 'N', modifiers: ['control', 'shift'] })
    check('Ctrl+Shift+N opens a new Brinq window', await until(() => BrowserWindow.getAllWindows().length === windowsBefore + 1))
    const second = tabWindows.all()[1]
    check('the new window shows', await until(() => second.window.isVisible()))
    check('the page moved, not copied: same document, typed text kept',
      second.isTab(page) && !tabs.isTab(page) && (await page.executeJavaScript('[window.state, document.getElementById("text").value]')).join() === [state, 'hi'].join())
    check('the move made no request (no reload)', requests['/stateful'] === requested, `${requests['/stateful']} vs ${requested}`)
    check('the new strip shows the tab and no Home', await until(async () => {
      const dom = await stripDom(second)
      return dom.labels.join() === 'Stateful' && !dom.home && dom.selected === 'Stateful'
    }))
    check('the main strip no longer shows it', !(await stripDom(tabs)).labels.includes('Stateful'))
    check('the moved page keeps its native authority', security.validateSender({ sender: page, senderFrame: page.mainFrame }))
    check('the window title follows the moved tab', await until(() => second.window.getTitle() === 'Stateful', 2000), second.window.getTitle())
    check('the new window has the same strip, and its own page stays empty',
      second.strip.getURL() === shellUrl && second.window.webContents.getURL() === '')
    // What the new window actually paints: the page's own colour below its strip.
    second.window.moveTop()
    second.window.focus()
    await wait(600)
    const content = second.window.getContentBounds()
    // Sampled where only the new window is: Xvfb has no window manager to stack them.
    const magenta = (value) => value[0] > 230 && value[1] < 30 && value[2] > 150
    const sample = () => screenPixel(content.x + content.width - 60, content.y + 300)
    let pixel = await sample()
    const timeline = [[0, pixel]]
    for (const ms of [500, 1000, 2000]) {
      if (magenta(pixel)) break
      await wait(ms)
      pixel = await sample()
      timeline.push([ms, pixel])
    }
    if (!magenta(pixel)) {
      const view = second.window.contentView.children.find((child) => child.webContents === page)
      view.setVisible(false)
      await wait(200)
      view.setVisible(true)
      await wait(500)
      timeline.push(['toggled', await sample()])
      page.invalidate()
      await wait(500)
      timeline.push(['invalidated', await sample()])
      second.window.setSize(901, 700)
      await wait(500)
      timeline.push(['resized', await sample()])
    }
    console.log('PAINT TIMELINE', JSON.stringify(timeline))
    check('the new window paints the moved page', pixel[0] > 230 && pixel[1] < 30 && pixel[2] > 150,
      JSON.stringify({
        pixel, content, main: host.getContentBounds(), visible: second.window.isVisible(),
        views: second.window.contentView.children.map((view) => ({ bounds: view.getBounds(), visible: view.getVisible?.(), page: view.webContents === page })),
        viewport: await page.executeJavaScript('[innerWidth, innerHeight, getComputedStyle(document.body).backgroundColor]'),
        samples: [await screenPixel(content.x + 100, content.y + 100), await screenPixel(content.x + 100, content.y + 20), await screenPixel(content.x + 450, content.y + 650)],
      }))
    check('keyboard focus is in the moved page', await until(() => page.isFocused(), 2000))
    // Links from the moved page open in its window.
    await click(page, '#child')
    check('a tab the moved page opens joins its window', await until(() => second.tabCount() === 2 && !tabs.isTab(allContents.getAllWebContents().find((wc) => wc.getURL().endsWith('/clients/9')))))
    await until(async () => (await stripDom(second)).labels.length === 2)
    // Its unsaved-work prompt belongs to the new window.
    second.select((await second.stripState({ sender: stripOf(second), senderFrame: stripOf(second).mainFrame })).tabs[0].id)
    const pageId = second.stripState({ sender: stripOf(second), senderFrame: stripOf(second).mainFrame }).tabs[0].id
    answers.push(1)
    const promptsBefore = prompts.length
    second.closeTab(pageId)
    await until(() => prompts.length === promptsBefore + 1)
    check('closing the moved tab asks in its new window, and Stay keeps it',
      promptOwners.at(-1) === second.window && !page.isDestroyed(), String(promptOwners.at(-1)?.id))
    // Its close button gives both tabs back to the main window, live.
    await wait(300)
    const promptsBeforeX = prompts.length
    second.window.close()
    const gaveBack = await until(() => second.window.isDestroyed() && tabs.isTab(page))
    check('the close button gives its tabs back to the main window', gaveBack && tabWindows.all().length === 1 && prompts.length === promptsBeforeX,
      JSON.stringify({ destroyed: second.window.isDestroyed(), inMain: tabs.isTab(page), inSecond: !second.window.isDestroyed() && second.isTab(page),
        windows: tabWindows.all().length, prompts: prompts.slice(promptsBeforeX), closing: tabWindows.all().map((each) => each.closingIds()) }))
    check('the page came back unchanged and unreloaded',
      (await page.executeJavaScript('[window.state, document.getElementById("text").value]')).join() === [state, 'hi'].join() &&
      requests['/stateful'] === requested)
    check('the main strip shows them again, the page selected', await until(async () => {
      const dom = await stripDom(tabs)
      return dom.labels.includes('Stateful') && dom.labels.includes('/clients/9') && dom.selected === 'Stateful'
    }))
    const back = tabs.window.getContentBounds()
    await wait(400)
    check('the main window paints the page that came back', (await screenPixel(back.x + 300, back.y + 300))[1] < 30)
    // Out again, then closing its last tab closes the window.
    tabs.window.focus()
    page.focus()
    for (const type of ['keyDown', 'keyUp']) page.sendInputEvent({ type, keyCode: 'N', modifiers: ['control', 'shift'] })
    await until(() => tabWindows.all().length === 2)
    const third = tabWindows.all()[1]
    await until(() => third.window.isVisible())
    answers.push(0)
    third.closeTab(third.tabIds()[0])
    check('closing its last tab closes the window', await until(() => third.window.isDestroyed() && page.isDestroyed()),
      JSON.stringify({ window: third.window.isDestroyed(), page: page.isDestroyed(), prompts: prompts.slice(promptsBefore) }))
    const child = allContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL().endsWith('/clients/9'))
    if (child) { child.close(); await until(() => child.isDestroyed()) }
    check('the main window and Home are untouched', !host.isDestroyed() && !tabs.home.isDestroyed() && tabWindows.all().length === 1)
  }

  // Step 2: a real X pointer drags a tab out of the main strip into a new
  // window, then onto the main strip again. Xvfb has no window manager, so
  // the windows are placed to not overlap where it matters.
  async function dragOutAndBack() {
    const xdo = (...args) => require('child_process').execFileSync(process.env.XDOTOOL, args.map(String))
    const drag = async (from, to, { steps = 16, before = null } = {}) => {
      xdo('mousemove', from.x, from.y, 'mousedown', '1')
      for (let step = 1; step <= steps; step++) {
        xdo('mousemove', Math.round(from.x + (to.x - from.x) * step / steps), Math.round(from.y + (to.y - from.y) * step / steps))
        await wait(15)
      }
      if (before) await before()
      xdo('mouseup', '1')
    }
    // The selected tab's grip in a window's strip, in screen pixels.
    const grip = async (tabWindow) => {
      const content = tabWindow.window.getContentBounds()
      const [x, y] = await tabWindow.strip.executeJavaScript(`(() => { const box = document.querySelector('.tab.selected').getBoundingClientRect(); return [Math.round(box.x + 40), Math.round(box.y + box.height / 2)] })()`)
      return { x: content.x + x, y: content.y + y }
    }
    const lifted = (tabWindow) => tabWindow.strip.executeJavaScript(`!!document.querySelector('.tab.lifted')`)
    // A neighbour, so the drop back has a tab to land after.
    const neighbour = tabs.openTab({ opener: tabs.home, url: `${base}/clients/5`, options: { webPreferences: {} }, referrer: { url: '', policy: 'default' }, background: true })
    await until(() => !neighbour.isLoading() && neighbour.getURL().endsWith('/clients/5'))
    const page = tabs.openTab({ opener: tabs.home, url: `${base}/stateful`, options: { webPreferences: {} }, referrer: { url: '', policy: 'default' }, background: false })
    await until(() => !page.isLoading() && page.getURL().endsWith('/stateful'))
    await click(page, '#text')
    for (const keyCode of ['o', 'k']) page.sendInputEvent({ type: 'char', keyCode })
    await until(() => page.executeJavaScript('document.getElementById("text").value === "ok"'))
    const state = await page.executeJavaScript('window.state')
    const requested = requests['/stateful']
    const kept = async () => (await page.executeJavaScript('[window.state, document.getElementById("text").value]')).join() === [state, 'ok'].join() &&
      requests['/stateful'] === requested
    await until(async () => (await stripDom(tabs)).selected === 'Stateful')
    const windowsBefore = tabWindows.all().length

    // Esc while dragging outside: nothing moves.
    let wasLifted = false
    await drag(await grip(tabs), { x: 700, y: 500 }, {
      before: async () => {
        wasLifted = await lifted(tabs)
        xdo('key', 'Escape')
        await wait(150)
      },
    })
    await wait(500)
    check('a tab dragged out of the strip lifts', wasLifted)
    check('Esc ends the drag: the tab stays and nothing opens',
      tabWindows.all().length === windowsBefore && tabs.isTab(page) && !(await lifted(tabs)))

    // Out: let go over the main window's own page.
    const out = { x: 900, y: 600 }
    await drag(await grip(tabs), out)
    check('letting go outside the strip opens the tab in a new window',
      await until(() => tabWindows.all().length === windowsBefore + 1 && !tabs.isTab(page)))
    const second = tabWindows.all().at(-1)
    check('the dragged page moved live: same document, typed text kept, no request', second?.isTab(page) && await kept())
    await until(() => second.window.isVisible())
    const placed = second.window.getBounds()
    check('the new window opens at the pointer, kept on the screen',
      placed.x <= out.x && out.x < placed.x + placed.width && placed.y <= out.y && out.y < placed.y + placed.height &&
      placed.x >= 0 && placed.y >= 0 && placed.x + placed.width <= 1600 && placed.y + placed.height <= 1000, JSON.stringify(placed))
    await wait(600)
    const magenta = (value) => value[0] > 230 && value[1] < 30 && value[2] > 150
    // Right of the main window: only the new one is there.
    const outPixel = await screenPixel(1500, placed.y + 300)
    check('the new window paints the dragged page', magenta(outPixel), JSON.stringify(outPixel))
    check('the new strip shows the tab', await until(async () => (await stripDom(second)).selected === 'Stateful'))

    // Back: onto the main strip, just after its first tab.
    const mainContent = host.getContentBounds()
    const firstTab = await tabs.strip.executeJavaScript(`(() => { const box = document.querySelector('.tab').getBoundingClientRect(); return [box.x, box.width, box.y + box.height / 2] })()`)
    const into = { x: Math.round(mainContent.x + firstTab[0] + firstTab[1] * 0.8), y: Math.round(mainContent.y + firstTab[2]) }
    await drag(await grip(second), into)
    check('dropping it on the main strip moves it there, and the emptied window closes',
      await until(() => tabs.isTab(page) && second.window.isDestroyed()),
      JSON.stringify({ inMain: tabs.isTab(page), closed: second.window.isDestroyed() }))
    check('it lands where it was let go: after the first tab, selected', await until(async () => {
      const dom = await stripDom(tabs)
      return dom.labels[1] === 'Stateful' && dom.selected === 'Stateful'
    }), JSON.stringify(await stripDom(tabs)))
    check('the page came back live: same document, typed text kept, no request', await kept())
    await wait(400)
    const backPixel = await screenPixel(mainContent.x + 300, mainContent.y + 300)
    check('the main window paints the page that came back', magenta(backPixel), JSON.stringify(backPixel))
    check('the page has keyboard focus in the main window', await until(() => page.isFocused(), 2000))
    // Done: close it (its unsaved text is let go).
    answers.push(0)
    tabs.closeTab(tabs.stripState({ sender: tabs.strip, senderFrame: tabs.strip.mainFrame }).selectedId)
    await until(() => page.isDestroyed())
    neighbour.close()
    await until(() => neighbour.isDestroyed())
    tabs.selectHome()
  }

  try {
    await until(() => tabs.home.getURL().endsWith('/home') && !tabs.home.isLoading())
    await until(async () => (await stripState()).selected === 'home')
    const baseline = allContents.getAllWebContents().length

    await click(tabs.home, '#client', ['control'])
    check('Ctrl+click opens a background tab', await until(() => tabPages().length === 1))
    const clientTab = tabPages()[0]
    await until(() => !clientTab.isLoading() && clientTab.getURL().endsWith('/clients/1'))
    check('background tab loads its page once', clientTab.getURL() === `${base}/clients/1`)
    check('background tab keeps Home selected', (await stripState()).selected === 'home')
    check('tab label comes from the page title', await until(async () => (await stripState()).labels.includes('/clients/1')))
    const hiddenSize = await clientTab.executeJavaScript('[innerWidth, innerHeight]')
    check('a background tab lays out at full size', hiddenSize[0] === 1200 && hiddenSize[1] === 760, JSON.stringify(hiddenSize))
    host.setContentSize(1000, 700)
    await wait(300)
    tabs.select(await tabs.strip.executeJavaScript('Number(document.querySelector(".tab .tab-select").id.slice(4))'))
    const shownSize = await until(async () => JSON.stringify(await clientTab.executeJavaScript('[innerWidth, innerHeight]')) === '[1000,660]')
    check('a background tab takes the current size when shown', shownSize)
    host.setContentSize(1200, 800)
    tabs.selectHome()
    await wait(300)

    await click(tabs.home, '#client', [], 'middle')
    check('middle-click opens a background tab', await until(() => tabPages().length === 2))

    await click(tabs.home, '#blank')
    check('window.open _blank opens a selected tab', await until(async () => (await stripState()).selected === '/clients/2'))
    tabs.selectHome()

    if (process.env.XDOTOOL) {
      // Real pointer drag in the strip: first tab to the end.
      const stripOrder = () => tabs.strip.executeJavaScript(`[...document.querySelectorAll('.tab-select')].map((node) => node.id)`)
      const before = await stripOrder()
      const boxes = await tabs.strip.executeJavaScript(`[...document.querySelectorAll('.tab')].map((node) => { const box = node.getBoundingClientRect(); return [Math.round(box.x + 40), Math.round(box.y + box.height / 2)] })`)
      const content = host.getContentBounds()
      const [fromX, y] = boxes[0]
      const toX = boxes[boxes.length - 1][0] + 60
      const xdo = (...args) => require('child_process').execFileSync(process.env.XDOTOOL, args.map(String))
      xdo('mousemove', content.x + fromX, content.y + y, 'mousedown', '1')
      for (let x = fromX; x <= toX; x += 20) { xdo('mousemove', content.x + x, content.y + y); await wait(15) }
      xdo('mouseup', '1')
      const expected = [...before.slice(1), before[0]]
      check('dragging a tab reorders it', await until(async () => JSON.stringify(await stripOrder()) === JSON.stringify(expected)),
        JSON.stringify(await stripOrder()))
      check('dropping a dragged tab does not select it', (await stripState()).selected === 'home')

      // Plain real clicks select, including a press that wobbles under the
      // drag threshold.
      const selectedId = () => tabs.strip.executeJavaScript(`document.querySelector('.tab.selected .tab-select')?.id ?? 'home'`)
      const after = await stripOrder()
      const centers = await tabs.strip.executeJavaScript(`[...document.querySelectorAll('.tab')].map((node) => { const box = node.getBoundingClientRect(); return [Math.round(box.x + 60), Math.round(box.y + box.height / 2)] })`)
      xdo('mousemove', content.x + centers[0][0], content.y + centers[0][1], 'click', '1')
      check('a plain click selects a tab', await until(async () => (await selectedId()) === after[0]))
      xdo('mousemove', content.x + centers[1][0], content.y + centers[1][1], 'mousedown', '1')
      xdo('mousemove', content.x + centers[1][0] + 3, content.y + centers[1][1])
      xdo('mouseup', '1')
      check('a press that moves under the drag threshold still selects', await until(async () => (await selectedId()) === after[1]))
      check('clicks do not reorder', JSON.stringify(await stripOrder()) === JSON.stringify(after))
      tabs.selectHome()
    } else console.log('SKIP tab drag: set XDOTOOL to a real input tool')

    const windowsBefore = BrowserWindow.getAllWindows().length
    await click(tabs.home, '#popout')
    check('named, sized email pop-out stays a window', await until(() => BrowserWindow.getAllWindows().length === windowsBefore + 1))
    const popout = BrowserWindow.getAllWindows().find((window) => window !== host)
    popout?.destroy()

    const beforePost = BrowserWindow.getAllWindows().length
    await click(tabs.home, '#post-submit', ['control'])
    check('form post opens a window, not a tab', await until(() => BrowserWindow.getAllWindows().length === beforePost + 1))
    BrowserWindow.getAllWindows().filter((window) => window !== host).forEach((window) => window.destroy())

    if (process.env.XDOTOOL) {
      const tabsBeforeFrame = tabPages().length
      await framedClick()
      const framedOpened = await until(() => tabPages().length === tabsBeforeFrame + 1)
      check('sandboxed frame link opens a tab', framedOpened)
      if (framedOpened) {
        const framed = tabPages().find((wc) => wc.getURL().endsWith('/clients/3'))
        await until(() => framed && !framed.isLoading())
        const ran = await framed.executeJavaScript('document.body.dataset.ran || "no"').catch(() => 'no (script blocked)')
        check('the tab keeps the frame\'s sandbox (scripts stay off)', ran.startsWith('no'), `page scripts ran: ${ran}`)
      }
    } else console.log('SKIP sandboxed frame link: set XDOTOOL to a real input tool')

    // Unsaved work: Stay keeps the tab, Leave closes it.
    const dirtyTab = tabs.openTab({ opener: tabs.home, url: `${base}/dirty`, options: { webPreferences: {} }, referrer: { url: '', policy: 'default' }, background: false })
    await until(() => !dirtyTab.isLoading())
    await click(dirtyTab, '#draft')
    dirtyTab.sendInputEvent({ type: 'char', keyCode: 'x' })
    await until(() => dirtyTab.executeJavaScript('document.getElementById("draft").value === "x"'))
    const dirtyId = (await tabs.strip.executeJavaScript('Number(document.querySelector(".tab.selected .tab-select").id.slice(4))'))
    answers.push(1)
    tabs.closeTab(dirtyId)
    await wait(800)
    check('closing a tab with unsaved work asks first', prompts.includes('Discard unsaved changes?'))
    check('Stay keeps the tab and its page', !dirtyTab.isDestroyed() && tabs.isTab(dirtyTab))
    answers.push(0)
    tabs.closeTab(dirtyId)
    check('Leave closes the tab', await until(() => dirtyTab.isDestroyed()))

    // Theme: a real class change in the selected page repaints the header.
    tabs.selectHome()
    await tabs.home.executeJavaScript(`document.documentElement.classList.replace('light', 'dark')`)
    check('selected page theme repaints the header', await until(async () => (await stripState()).theme === 'dark'))
    check('header theme is saved', themes.at(-1) === 'dark')
    await clientTab.executeJavaScript(`document.documentElement.classList.replace('light', 'dark'); document.documentElement.classList.replace('dark', 'light')`)
    await wait(300)
    check('a background tab does not repaint the header', (await stripState()).theme === 'dark')

    // Tab menu: real right-clicks and keys in the strip, real menu and clipboard.
    const stripPoint = (selector) => tabs.strip.executeJavaScript(`(() => {
      const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect()
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), left: Math.round(box.left), bottom: Math.round(box.bottom) }
    })()`)
    const takeMenu = async (count) => {
      const shown = await until(() => menus.length >= count && menus.at(-1).shown, 2000)
      const record = menus.at(-1)
      record?.menu.closePopup(host)
      await wait(150)
      return shown ? record : null
    }
    const rightClick = async (selector) => {
      const { x, y } = await stripPoint(selector)
      for (const type of ['mouseDown', 'mouseUp']) tabs.strip.sendInputEvent({ type, x, y, button: 'right', clickCount: 1 })
      return { x, y }
    }
    // The client tab moves to a call recording without a full navigation.
    const recording = `${base}/clients/1/calls/rec_9?standalone=full&t=95#transcript`
    await clientTab.executeJavaScript(`history.pushState(null, '', ${JSON.stringify(recording.slice(base.length))}); document.title = 'brinq | Call recording'`)
    await until(async () => clientTab.getURL() === recording && (await stripState()).labels.includes('Call recording'))
    const clientSelector = await tabs.strip.executeJavaScript(
      `'#' + [...document.querySelectorAll('.tab-select')].find((node) => node.textContent === 'Call recording').id`)
    await clipboard.writeText('before')
    const at = await rightClick(clientSelector)
    const clientMenu = await takeMenu(1)
    check('right-clicking a tab opens its menu at the pointer', clientMenu && clientMenu.options.window === host &&
      clientMenu.options.x === at.x && clientMenu.options.y === at.y, JSON.stringify(clientMenu?.options && { x: clientMenu.options.x, y: clientMenu.options.y, at }))
    check('the menu has Copy link and Open in browser, both enabled',
      JSON.stringify(clientMenu?.menu.items.slice(0, 2).map(({ label, enabled }) => [label, enabled])) === JSON.stringify([['Copy link', true], ['Open in browser', true]]))
    clientMenu?.menu.items[0].click()
    const copiedText = async (expected) => (await until(async () => (await clipboard.readText()) === expected, 2000)) || clipboard.readText()
    check('Copy link puts the page\'s browser link on the clipboard', (await copiedText(`${base}/clients/1/calls/rec_9?t=95#transcript`)) === true)
    clientMenu?.menu.items[1].click()
    check('Open in browser opens the same link', JSON.stringify(opened) === JSON.stringify([`${base}/clients/1/calls/rec_9?t=95#transcript`]), JSON.stringify(opened))
    check('the menu does not select the tab', (await stripState()).selected === 'home')
    check('closing a clicked menu gives focus back to the page', await until(() => tabs.home.isFocused(), 1000))
    await rightClick('.home')
    const homeMenu = await takeMenu(2)
    homeMenu?.menu.items[0].click()
    const homeCopy = await copiedText(`${base}/home`)
    check('Home has the menu too, with its page as the link', menus.length === 2 && homeCopy === true, String(homeCopy))
    // Keyboard: the Menu key and Shift+F10 open it once, below the focused tab.
    await tabs.strip.executeJavaScript(`document.querySelector(${JSON.stringify(clientSelector)}).focus()`)
    tabs.strip.focus()
    const below = await stripPoint(`.tab:has(> ${clientSelector})`)
    // Synthetic input has no Menu key; that press uses real X input.
    const keys = [['Shift+F10', () => {
      tabs.strip.sendInputEvent({ type: 'rawKeyDown', keyCode: 'F10', modifiers: ['shift'] })
      tabs.strip.sendInputEvent({ type: 'keyUp', keyCode: 'F10', modifiers: ['shift'] })
    }]]
    if (process.env.XDOTOOL) keys.push(['the Menu key', () => require('child_process').execFileSync(process.env.XDOTOOL, ['key', 'Menu'])])
    else console.log('SKIP the Menu key: set XDOTOOL to a real input tool')
    for (const [name, press] of keys) {
      const before = menus.length
      host.focus()
      press()
      const record = await takeMenu(before + 1)
      await wait(200)
      check(`${name} opens the focused tab's menu once, below the tab`, record && menus.length === before + 1 &&
        record.options.x === below.left && record.options.y === below.bottom && record.options.sourceType === 'keyboard',
        JSON.stringify({ menus: menus.length - before, at: record?.options && [record.options.x, record.options.y], below }))
    }
    // A menu request with no pointer, such as a screen reader's, comes the
    // way Chromium sends the Menu key's: a PointerEvent with button -1.
    const beforeAssistive = menus.length
    await tabs.strip.executeJavaScript(`document.querySelector(${JSON.stringify(clientSelector)}).dispatchEvent(new PointerEvent('contextmenu', { bubbles: true, cancelable: true, button: -1 }))`)
    const assistive = await takeMenu(beforeAssistive + 1)
    check('a menu request without a pointer opens below the tab', assistive && assistive.options.x === below.left && assistive.options.y === below.bottom,
      JSON.stringify(assistive?.options && [assistive.options.x, assistive.options.y]))
    tabs.selectHome()

    console.log('MENUS OPEN before labels', JSON.stringify(menus.map((record) => [record.shown, !!record.closed])))
    // Link labels name background tabs before their pages do.
    await tabs.home.loadURL(`${base}/labels`)
    const labelsBefore = labelTimes.length
    const opensBefore = openTimes.length
    await click(tabs.home, '#labeled', ['control'])
    check('a labeled client link names its background tab at once',
      await until(async () => (await stripState()).labels.includes('Acme Holdings'), 1000),
      JSON.stringify((await stripState()).labels))
    check('the page title replaces the link name when it arrives',
      await until(async () => (await stripState()).labels.includes('Acme Holdings, LLC'), 5000) &&
      !(await stripState()).labels.includes('Acme Holdings'))
    const blocked = await tabs.home.executeJavaScript('window.blocked')
    check('the synchronous label holds a click up only briefly', blocked.length === 1 && blocked[0] < 50,
      `click held for ${blocked.map((ms) => ms.toFixed(1)).join(', ')} ms (sendSync round trip plus listeners)`)
    await click(tabs.home, '#plain', [], 'middle')
    check('a link without a label falls back to its text',
      await until(async () => (await stripState()).labels.includes('Blue Ridge Bakery'), 1000))
    await tabs.home.executeJavaScript(`document.getElementById('search').focus()`)
    tabs.home.sendInputEvent({ type: 'rawKeyDown', keyCode: 'Enter', modifiers: ['control'] })
    tabs.home.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['control'] })
    check('a Ctrl+Enter script open gets its link name',
      await until(async () => (await stripState()).labels.includes('Northwind Dental'), 1000))
    // A plain anchor's Ctrl+Enter also produces a keyboard click; only the
    // keydown may send the label.
    const beforeKeyboard = labelTimes.length
    const openedBefore = openTimes.length
    await tabs.home.executeJavaScript(`document.getElementById('plain').focus()`)
    tabs.home.sendInputEvent({ type: 'rawKeyDown', keyCode: 'Enter', modifiers: ['control'] })
    tabs.home.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['control'] })
    await until(() => openTimes.length === openedBefore + 1, 2000)
    await wait(200)
    check('keyboard activation of a plain link sends one label', labelTimes.length === beforeKeyboard + 1 && openTimes.length === openedBefore + 1,
      `labels ${labelTimes.length - beforeKeyboard}, opens ${openTimes.length - openedBefore}`)
    const labels = labelTimes.slice(labelsBefore, labelsBefore + 3)
    const opens = openTimes.slice(opensBefore, opensBefore + 3)
    const gaps = opens.map((openAt, index) => openAt - labels[index])
    check('each gesture sends one label before its open', labels.length === 3 && opens.length === 3 && gaps.every((gap) => gap >= 0),
      `labels ${labels.length}, opens ${opens.length}, label-to-open ms ${gaps.map((gap) => gap.toFixed(1)).join(', ')}`)
    await tabs.home.loadURL(`${base}/home`)

    // Failure panel and retry.
    const broken = tabs.openTab({ opener: tabs.home, url: `${base}/broken`, options: { webPreferences: {} }, referrer: { url: '', policy: 'default' }, background: false })
    check('a failed tab shows the explanation panel', await until(async () => (await stripState()).panel))

    // Repeated open and close leaves no renderers behind.
    for (const wc of tabPages()) {
      wc.close()
    }
    await until(() => tabPages().length === 0)
    for (let round = 0; round < 5; round++) {
      await click(tabs.home, '#client', ['control'])
      await until(() => tabPages().length === 1)
      tabPages()[0].close()
      await until(() => tabPages().length === 0)
    }
    await wait(300)
    check('open/close cycles leave no pages behind', allContents.getAllWebContents().length <= baseline, `${allContents.getAllWebContents().length} vs ${baseline}`)

    // Home navigating away from unsaved work (as a mode switch does).
    await tabs.home.loadURL(`${base}/dirty`)
    await click(tabs.home, '#draft')
    tabs.home.sendInputEvent({ type: 'char', keyCode: 'h' })
    await until(() => tabs.home.executeJavaScript('document.getElementById("draft").value === "h"'))
    answers.push(1)
    const stayed = await tabs.home.loadURL(`${base}/home`).then(() => 'loaded', () => 'rejected')
    check('Stay keeps Home on its page and rejects the navigation', stayed === 'rejected' && tabs.home.getURL().endsWith('/dirty'))
    // A person takes longer than Chromium's canceled-unload acknowledgement.
    await wait(300)
    answers.push(0)
    const left = await tabs.home.loadURL(`${base}/home`).then(() => 'loaded', (error) => `rejected: ${error.message}`)
    check('Leave lets Home navigate', left === 'loaded' && tabs.home.getURL().endsWith('/home'), `${left} at ${tabs.home.getURL()}`)

    // Startup tabs: restored tabs are real views that fetch nothing until selected.
    const restored = tabs.restoreTabs(['/restored-a', '/restored-b'].map((route) => ({ url: `${base}${route}`, label: route })))
    await wait(500)
    check('restored tabs are added without selecting them', restored.length === 2 && (await stripState()).selected === 'home')
    check('a restored tab makes no request until selected', !requests['/restored-a'] && !requests['/restored-b'], JSON.stringify(requests))
    const restoredPages = tabPages().filter((wc) => !wc.getURL())
    check('a restored tab has a blank document with no native authority',
      restoredPages.length === 2 && restoredPages.every((wc) => !security.validateSender({ sender: wc, senderFrame: wc.mainFrame })))
    tabs.select(restored[0].id)
    const pageA = () => restoredPages.find((wc) => !wc.isDestroyed() && wc.getURL() === `${base}/restored-a`)
    check('selecting a restored tab loads it once', await until(() => requests['/restored-a'] === 1 && !!pageA()))
    await wait(300)
    check('it is not loaded twice', requests['/restored-a'] === 1)
    const pageB = restoredPages.find((wc) => wc !== pageA())
    const promptsBeforeClose = prompts.length
    tabs.closeTab(restored[1].id)
    check('closing a never-loaded tab destroys it without a prompt',
      await until(() => pageB.isDestroyed()) && prompts.length === promptsBeforeClose && !requests['/restored-b'])
    const loadedA = pageA()
    tabs.closeTab(restored[0].id)
    await until(() => loadedA.isDestroyed())

    await openInNewWindow()
    if (process.env.XDOTOOL) await dragOutAndBack()
    else console.log('SKIP drag out: set XDOTOOL to a real input tool')

    // A real app.quit() with a hidden tab holding unsaved work.
    const quitTab = tabs.openTab({ opener: tabs.home, url: `${base}/dirty`, options: { webPreferences: {} }, referrer: { url: '', policy: 'default' }, background: false })
    await until(() => !quitTab.isLoading())
    await click(quitTab, '#draft')
    quitTab.sendInputEvent({ type: 'char', keyCode: 'y' })
    await until(() => quitTab.executeJavaScript('document.getElementById("draft").value === "y"'))
    // A second window with unsaved work of its own (set up first: moving the
    // selected tab out selects its neighbour, which would load a restored one).
    const elsewhere = tabs.openTab({ opener: tabs.home, url: `${base}/stateful`, options: { webPreferences: {} }, referrer: { url: '', policy: 'default' }, background: false })
    await until(() => !elsewhere.isLoading() && elsewhere.getURL().endsWith('/stateful'))
    await click(elsewhere, '#text')
    elsewhere.sendInputEvent({ type: 'char', keyCode: 'z' })
    await until(() => elsewhere.executeJavaScript('document.getElementById("text").value === "z"'))
    tabWindows.moveToNewWindow(tabs, tabs.stripState({ sender: tabs.strip, senderFrame: tabs.strip.mainFrame }).selectedId)
    const quitSecond = tabWindows.all()[1]
    await until(() => quitSecond?.window.isVisible())
    // Two restored tabs after the guarded one; quitting must not load them.
    tabs.restoreTabs(['/restored-c', '/restored-d'].map((route) => ({ url: `${base}${route}`, label: route })))
    tabs.selectHome()
    // A quit while the other window has tabs is refused before anything closes.
    const promptsBeforeRefused = prompts.length
    app.quit()
    await wait(500)
    check('a quit is refused while another window has tabs, and nothing closes',
      quitsRefused === 1 && !app.isQuitting && prompts.length === promptsBeforeRefused &&
      !quitSecond.window.isDestroyed() && !elsewhere.isDestroyed() && !quitTab.isDestroyed() && !tabs.home.isDestroyed())
    // Its close button gives the tab back; then the quit runs as before.
    quitSecond.window.close()
    await until(() => quitSecond.window.isDestroyed() && tabs.isTab(elsewhere))
    tabs.selectHome()
    host.hide()
    const promptsBeforeQuit = prompts.length
    const ownersBeforeQuit = promptOwners.length
    answers.push(1)
    app.quit()
    const quitStopped = await until(() => quitStops === 1)
    check('Stay stops a real quit', quitStopped && !quitTab.isDestroyed() && !app.isQuitting,
      JSON.stringify({ quitStops, destroyed: quitTab.isDestroyed(), quitting: app.isQuitting, prompts: prompts.length, answers }))
    check('the stopped quit shows the window and the tab with unsaved work', host.isVisible() && tabs.isTab(quitTab))
    check('Stay prompted once and loaded no restored tab', prompts.length === promptsBeforeQuit + 1 && !requests['/restored-c'] && !requests['/restored-d'])
    check('the prompts came in the main window, which now holds the given-back tab',
      tabs.isTab(elsewhere) && !elsewhere.isDestroyed() && promptOwners.slice(ownersBeforeQuit).every((owner) => owner === host))
    let quitState = null
    app.once('will-quit', (event) => {
      // Keep the harness alive to report; record what quitting left behind.
      event.preventDefault()
      quitState = { host: host.isDestroyed(), tabs: tabPages().length, home: tabs.home.isDestroyed() }
    })
    answers.push(0, 0)
    app.quit()
    check('Leave completes the quit after every tab and Home closed', await until(() => quitState !== null),
      JSON.stringify(quitState))
    check('quit left no pages and closed the window', quitState?.host === true && quitState?.tabs === 0 && quitState?.home === true &&
      elsewhere.isDestroyed())
    check('each page with unsaved work was asked once, one at a time', prompts.length === promptsBeforeQuit + 3, String(prompts.length - promptsBeforeQuit))
    check('closing the selected guarded tab during quit loaded neither restored neighbour', !requests['/restored-c'] && !requests['/restored-d'], JSON.stringify(requests))
  } catch (error) {
    check('harness completed', false, error?.stack || String(error))
  }

  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  server.close()
  if (!host.isDestroyed()) host.destroy()
  app.exit(failed.length ? 1 : 0)
}

app.whenReady().then(main)

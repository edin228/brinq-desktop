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
  '/test/visual/tab-strip.html': ['test/visual/tab-strip.html', 'text/html; charset=utf-8'],
  '/test/visual/tab-strip.js': ['test/visual/tab-strip.js', 'text/javascript; charset=utf-8'],
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
    console.log(`Strip harness: http://localhost:${port}/test/visual/tab-strip.html?state=home-hover&theme=dark`)
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
const { app, BrowserWindow, WebContentsView, ipcMain, webContents: allContents } = require('electron')
const { pathToFileURL } = require('url')
const { createWindowSecurity } = require('../src/window-security')
const { createTabWindow } = require('../src/tab-window')

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
  '/dirty': page('brinq | Draft', '<input id="draft" value="">', `
    document.getElementById('draft').addEventListener('input', () => {
      window.onbeforeunload = (event) => { event.preventDefault(); event.returnValue = '' }
    })`),
}

async function main() {
  const server = http.createServer((request, response) => {
    const route = new URL(request.url, 'http://localhost').pathname
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
  const dialog = { showMessageBoxSync: (_owner, options) => { prompts.push(options.message); return answers.shift() ?? 1 } }
  const themes = []
  const tabs = createTabWindow({
    electron: { BrowserWindow, WebContentsView, dialog },
    security,
    bounds: { width: 1200, height: 800, x: 0, y: 0 },
    preloadPath: path.join(ROOT, 'src', 'preload.js'),
    shellPreloadPath: path.join(ROOT, 'src', 'shell-preload.js'),
    shellUrl,
    theme: 'light',
    newTabUrl: (home) => home.getURL(),
    onTheme: (theme) => themes.push(theme),
    onHome: (contents) => contents.loadURL(`${base}/home`),
  })
  security.setTabHost(tabs)
  ipcMain.on('tabs:command', (event, command, id, options) => tabs.stripCommand(event, command, id, options))
  ipcMain.handle('tabs:state', (event) => tabs.stripState(event))
  ipcMain.on('theme-changed', (event, theme) => {
    if (security.validateSender(event)) tabs.reportTheme(event.sender, theme)
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
  const stripState = () => host.webContents.executeJavaScript(`({
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

    await click(tabs.home, '#client', [], 'middle')
    check('middle-click opens a background tab', await until(() => tabPages().length === 2))

    await click(tabs.home, '#blank')
    check('window.open _blank opens a selected tab', await until(async () => (await stripState()).selected === '/clients/2'))
    tabs.selectHome()

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
    const dirtyId = (await host.webContents.executeJavaScript('Number(document.querySelector(".tab.selected .tab-select").id.slice(4))'))
    answers.push(1)
    tabs.closeTab(dirtyId)
    await wait(800)
    check('closing a tab with unsaved work asks first', prompts.includes('Leave this page?'))
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

    // Quit: a hidden dirty tab can stop it.
    const quitTab = tabs.openTab({ opener: tabs.home, url: `${base}/dirty`, options: { webPreferences: {} }, referrer: { url: '', policy: 'default' }, background: false })
    await until(() => !quitTab.isLoading())
    await click(quitTab, '#draft')
    quitTab.sendInputEvent({ type: 'char', keyCode: 'y' })
    await until(() => quitTab.executeJavaScript('document.getElementById("draft").value === "y"'))
    tabs.selectHome()
    host.hide()
    answers.push(1)
    const stopped = await tabs.closeAllForQuit()
    check('quit with unsaved work stops at Stay', stopped === false && !quitTab.isDestroyed())
    check('quit shows the window and the tab with unsaved work', host.isVisible() && tabs.isTab(quitTab))
    answers.push(0)
    // Retry at once: the request must wait for Chromium, not be dropped.
    const second = tabs.closeAllForQuit()
    check('quit completes after Leave', await second)
    check('quit closed every tab, Home last', !tabs.hasOpenTabs())
  } catch (error) {
    check('harness completed', false, error?.stack || String(error))
  }

  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  server.close()
  host.destroy()
  app.exit(failed.length ? 1 : 0)
}

app.whenReady().then(main)

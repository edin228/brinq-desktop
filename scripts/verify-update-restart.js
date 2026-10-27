#!/usr/bin/env node
// Verifies "Restart to update" against real Electron windows and unload
// prompts: no installer runs until every tab and window accepted closing,
// and Stay anywhere keeps the update ready for another try.
//
//   npx electron scripts/verify-update-restart.js [--no-sandbox]
//
// Uses the production tab window, window security, unload guards and update
// owner with synthetic pages on an ephemeral loopback server. The updater is
// a stand-in that never contacts a feed or runs an installer.
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { app, BrowserWindow, WebContentsView, Menu, clipboard, ipcMain, webContents: allContents } = require('electron')
const { pathToFileURL } = require('url')
const { createWindowSecurity } = require('../src/window-security')
const { createTabWindow } = require('../src/tab-window')
const { createUpdateStatus } = require('../src/update-status')
const { guardWindowUnload } = require('../src/unload-guard')

const ROOT = path.join(__dirname, '..')

const page = (title, body, script = '') => `<!doctype html><html class="light"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:14px sans-serif;margin:20px} a,button,input{display:block;margin:8px 0;padding:6px}</style></head>
<body>${body}<script>${script}</script></body></html>`

// A typed character arms the page's unsaved-work guard, like a draft.
const DRAFT = `document.getElementById('draft').addEventListener('input', () => {
  window.onbeforeunload = (event) => { event.preventDefault(); event.returnValue = '' }
})`

// A slow guard answers after Home has already closed, the latest a pop-out
// can stop a quit.
const SLOW_DRAFT = DRAFT.replace('event.preventDefault()', 'const end = Date.now() + 400; while (Date.now() < end) {} event.preventDefault()')

const ROUTES = {
  '/home': page('brinq | Home', `
    <button id="popout" onclick="window.open('/email/draft','email-1','width=900,height=600')">Pop out email</button>
    <button id="slow-popout" onclick="window.open('/email/slow-draft','email-2','width=900,height=600')">Pop out slow email</button>`),
  '/dirty': page('brinq | Draft', '<input id="draft" value="">', DRAFT),
  '/email/draft': page('brinq | Email draft', '<input id="draft" value="">', DRAFT),
  '/email/slow-draft': page('brinq | Email draft', '<input id="draft" value="">', SLOW_DRAFT),
}

async function main() {
  const server = http.createServer((request, response) => {
    const route = new URL(request.url, 'http://localhost').pathname
    const body = ROUTES[route] || page(`brinq | ${route}`, `<p>${route}</p>`)
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const security = createWindowSecurity({ baseUrl: base, preloadPath: path.join(ROOT, 'src', 'preload.js'), openExternal: () => {} })
  // Every prompt is answered from `answers`: 0 is Leave, 1 is Stay.
  const answers = []
  const prompts = []
  const dialog = { showMessageBoxSync: (_owner, options) => { prompts.push(options.message); return answers.shift() ?? 1 } }

  // Stand-in for electron-updater: the downloaded installer is a real file,
  // and quitAndInstall records what was still open when it ran.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'brinq-update-restart-'))
  const updater = new EventEmitter()
  updater.installerPath = path.join(directory, 'Brinq-Setup.exe')
  fs.writeFileSync(updater.installerPath, 'fixture; never executed')
  const installs = []
  updater.quitAndInstall = () => {
    installs.push({
      windows: BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()).length,
      pages: allContents.getAllWebContents().filter((wc) => !wc.isDestroyed()).length,
    })
  }
  updater.checkForUpdates = () => { throw new Error('The harness never checks a feed') }

  let tabs = null
  let quitStops = 0
  // The same wiring main.js uses, with the real app.quit(). A Stay can
  // arrive after the main window already closed; like main.js, restoring
  // then creates a new main window with a fresh Home.
  const updates = createUpdateStatus({
    app, updater,
    restoreWindow: () => {
      if (tabs.window.isDestroyed()) createHost()
      tabs.window.show()
    },
  })
  app.on('browser-window-created', (_event, window) => {
    guardWindowUnload({ window, dialog, onStay: () => updates.cancelQuit() })
  })
  const createHost = () => {
    tabs = createTabWindow({
      electron: { BrowserWindow, WebContentsView, dialog, Menu, clipboard },
      openExternal: () => {},
      security,
      bounds: { width: 1200, height: 800, x: 0, y: 0 },
      preloadPath: path.join(ROOT, 'src', 'preload.js'),
      shellPreloadPath: path.join(ROOT, 'src', 'shell-preload.js'),
      shellUrl: pathToFileURL(path.join(ROOT, 'src', 'shell', 'shell.html')).href,
      theme: 'light',
      newTabUrl: (home) => home.getURL(),
      onTheme: () => {},
      onHome: (contents) => contents.loadURL(`${base}/home`),
      isQuitting: () => !!app.isQuitting,
      requestQuit: () => app.quit(),
      onQuitStopped: () => {
        quitStops++
        updates.cancelQuit()
        tabs.window.show()
      },
    })
    security.setTabHost({ available: tabs.available, openTab: (args) => tabs.openTab(args) })
  }
  createHost()
  app.on('before-quit', (event) => { if (!event.defaultPrevented) app.isQuitting = true })
  app.on('window-all-closed', () => {})
  ipcMain.on('tabs:command', (event, command, id, options) => tabs.stripCommand(event, command, id, options))
  ipcMain.handle('tabs:state', (event) => tabs.stripState(event))
  tabs.window.show()

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
  const open = async (route, background = true) => {
    const contents = tabs.openTab({ opener: tabs.home, url: `${base}${route}`, options: { webPreferences: {} }, referrer: { url: '', policy: 'default' }, background })
    await until(() => !contents.isLoading())
    return contents
  }
  // Real input events give the page the user activation beforeunload needs.
  const type = async (contents, key) => {
    contents.focus()
    await contents.executeJavaScript(`document.getElementById('draft').focus()`)
    contents.sendInputEvent({ type: 'char', keyCode: key })
    return until(() => contents.executeJavaScript(`document.getElementById('draft').value.includes(${JSON.stringify(key)})`))
  }
  const quitListeners = () => app.listenerCount('will-quit')
  const state = () => updates.getState()

  try {
    await until(() => tabs.home.getURL().endsWith('/home') && !tabs.home.isLoading())
    const baseListeners = quitListeners()
    updater.emit('update-downloaded', { version: '9.9.9' })
    check('a downloaded update is ready', state().status === 'ready')

    // 1. A pop-out with an unsaved draft answers Stay while the tab loop runs.
    // Several tabs keep the loop busy so the Stay lands before Home closes;
    // 1b covers a Stay that lands after.
    const cleanA = await open('/clients/a')
    for (const route of ['/clients/b', '/clients/c', '/clients/d']) await open(route)
    const windowsBefore = BrowserWindow.getAllWindows().length
    await tabs.home.executeJavaScript(`document.getElementById('popout').click()`)
    await until(() => BrowserWindow.getAllWindows().length === windowsBefore + 1)
    const popout = BrowserWindow.getAllWindows().find((window) => window !== tabs.window)
    await until(() => popout && !popout.webContents.isLoading())
    check('the pop-out draft holds unsaved work', await type(popout.webContents, 'p'))
    answers.push(1)
    check('Restart to update is accepted', updates.restart().ok === true)
    check('a second request while it runs is refused', updates.restart().ok === false)
    await until(() => !app.isQuitting && prompts.length === 1)
    // Restoring may have to create a new main window; wait for its Home.
    await until(() => !tabs.window.isDestroyed() && tabs.window.isVisible() && !tabs.home.isDestroyed() && !tabs.home.isLoading())
    await wait(600)
    check('the pop-out asked about its unsaved changes', prompts.length === 1, JSON.stringify(prompts))
    check('Stay in a pop-out keeps the pop-out', !popout.isDestroyed())
    check('Stay in a pop-out runs no installer', installs.length === 0)
    check('Stay in a pop-out keeps the update ready', state().status === 'ready' && /Restart canceled/.test(state().message), JSON.stringify(state()))
    check('Stay in a pop-out ends the quit and drops the pending install', !app.isQuitting && quitListeners() === baseListeners,
      JSON.stringify({ quitting: app.isQuitting, listeners: quitListeners() - baseListeners }))
    check('Stay in a pop-out shows the main window again, with Home', tabs.window.isVisible() && tabs.home.getURL().endsWith('/home'))
    // Informational: how far the tab loop got before the pop-out's Stay arrived.
    console.log(`INFO after pop-out Stay: first tab still open ${!cleanA.isDestroyed()}, tabs left ${allContents.getAllWebContents().filter((wc) => tabs.isTab(wc) && wc !== tabs.home).length}`)
    popout.destroy()
    if (cleanA.isDestroyed()) await open('/clients/a')

    // 1b. Today: a pop-out's Stay that arrives after Home closed. The tab
    // loop has finished, so it quits again and the pop-out is asked twice;
    // the main window is left without Home. The scheduler work fixes both.
    const slowBefore = BrowserWindow.getAllWindows().length
    await tabs.home.executeJavaScript(`document.getElementById('slow-popout').click()`)
    await until(() => BrowserWindow.getAllWindows().length === slowBefore + 1)
    const slow = BrowserWindow.getAllWindows().find((window) => window !== tabs.window)
    await until(() => slow && !slow.webContents.isLoading())
    check('the slow pop-out draft holds unsaved work', await type(slow.webContents, 's'))
    const slowPrompts = prompts.length
    answers.push(1, 1)
    check('Restart to update is accepted with a slow pop-out', updates.restart().ok === true)
    await until(() => prompts.length >= slowPrompts + 2, 5000)
    await wait(800)
    const homeGone = tabs.window.isDestroyed() || tabs.home.isDestroyed()
    check('today: a Stay after Home closed is asked twice', prompts.length === slowPrompts + 2, JSON.stringify(prompts.slice(slowPrompts)))
    check('today: a Stay after Home closed leaves the main window without Home', homeGone)
    check('a Stay after Home closed runs no installer and keeps the update ready',
      installs.length === 0 && state().status === 'ready' && !app.isQuitting && quitListeners() === baseListeners && !slow.isDestroyed())
    // Harness recovery only: start again with a fresh main window.
    slow.destroy()
    if (!tabs.window.isDestroyed()) tabs.window.destroy()
    createHost()
    tabs.window.show()
    await until(() => tabs.home.getURL().endsWith('/home') && !tabs.home.isLoading())

    // 2. A tab in the middle of the close order answers Stay after earlier
    // tabs already closed.
    for (const wc of allContents.getAllWebContents().filter((wc) => tabs.isTab(wc) && wc !== tabs.home)) wc.close()
    await until(() => allContents.getAllWebContents().filter((wc) => tabs.isTab(wc) && wc !== tabs.home).length === 0)
    const first = await open('/clients/first')
    // Typing needs the tab shown; it then waits in the background.
    const draft = await open('/dirty', false)
    check('the middle tab holds unsaved work', await type(draft, 'k'))
    tabs.selectHome()
    const last = await open('/clients/last')
    tabs.window.hide()
    const promptsBefore = prompts.length
    const stopsBefore = quitStops
    answers.push(1)
    check('Restart to update is accepted again', updates.restart().ok === true)
    check('Stay on a tab stops the restart', await until(() => quitStops > stopsBefore))
    await wait(300)
    check('the tab asked about its unsaved changes', prompts.length === promptsBefore + 1)
    check('tabs before the draft closed; the draft and later tabs stayed', first.isDestroyed() && !draft.isDestroyed() && !last.isDestroyed() && !tabs.home.isDestroyed(),
      JSON.stringify({ first: first.isDestroyed(), draft: draft.isDestroyed(), last: last.isDestroyed() }))
    check('Stay on a tab runs no installer', installs.length === 0)
    check('Stay on a tab keeps the update ready', state().status === 'ready' && /Restart canceled/.test(state().message))
    check('Stay on a tab ends the quit and drops the pending install', !app.isQuitting && quitListeners() === baseListeners)
    check('Stay on a tab shows the main window', tabs.window.isVisible())

    // 3. Leave everywhere: exactly one install, after every window closed.
    await type(draft, 'm')
    answers.push(0)
    check('Restart to update is accepted a third time', updates.restart().ok === true)
    check('Leave lets the restart reach the installer', await until(() => installs.length > 0))
    await wait(500)
    check('the installer ran exactly once', installs.length === 1, JSON.stringify(installs))
    check('the installer ran after every window and page closed', installs[0]?.windows === 0 && installs[0]?.pages === 0, JSON.stringify(installs[0]))
    check('the main window and every tab closed', tabs.window.isDestroyed() && draft.isDestroyed() && last.isDestroyed())
  } catch (error) {
    check('harness completed', false, error?.stack || String(error))
  }

  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  server.close()
  fs.rmSync(directory, { recursive: true, force: true })
  if (!tabs.window.isDestroyed()) tabs.window.destroy()
  app.exit(failed.length ? 1 : 0)
}

app.whenReady().then(main)

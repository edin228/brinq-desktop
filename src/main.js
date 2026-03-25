const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  ipcMain,
  shell,
  nativeImage,
} = require('electron')
const path = require('path')
const { autoUpdater } = require('electron-updater')
const config = require('./config')

// GPU / rendering flags
// --ignore-gpu-blocklist: force GPU compositing even on blocklisted drivers
//   (fixes backdrop-filter, smooth animations on most systems)
// --enable-features=BackdropFilter: explicitly enable CSS backdrop-filter
// Falls back to software rendering gracefully if GPU still fails
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-zero-copy')
app.commandLine.appendSwitch('enable-features', 'BackdropFilter')

const PRELOAD_PATH = path.join(__dirname, 'preload.js')
const BASE_URL = config.getBaseUrl()
const BASE_ORIGIN = new URL(BASE_URL).origin

let mainWindow = null
let tray = null
let pendingPayloads = [] // FIFO queue for protocol/notification intents during startup
let rendererReady = false // true once BrowserWindow is on /emails and authenticated

// ---------------------------------------------------------------------------
// Single instance lock
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    // Windows: protocol URLs arrive via argv on second instance
    const protocolArg = argv.find(
      (a) => a.startsWith('mailto:') || a.startsWith('brinq:'),
    )
    if (protocolArg) handleProtocolUrl(protocolArg)
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isSameOriginEmailPopout(url) {
  try {
    const parsed = new URL(url)
    return parsed.origin === BASE_ORIGIN && parsed.pathname.startsWith('/email/')
  } catch {
    return false
  }
}

function isOffOriginHttp(url) {
  try {
    const parsed = new URL(url)
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.origin !== BASE_ORIGIN
    )
  } catch {
    return false
  }
}

function getModeUrl() {
  const mode = config.getMode()
  return mode === 'email'
    ? `${BASE_URL}/emails?standalone=email`
    : `${BASE_URL}/dashboard?standalone=full`
}

function isOnEmailsRoute() {
  if (!mainWindow) return false
  try {
    const current = new URL(mainWindow.webContents.getURL())
    return current.pathname === '/emails'
  } catch {
    return false
  }
}

function isOnLoginPage() {
  if (!mainWindow) return false
  try {
    const current = new URL(mainWindow.webContents.getURL())
    return current.pathname === '/login'
  } catch {
    return false
  }
}

function drainPendingPayloads() {
  if (!rendererReady || pendingPayloads.length === 0) return
  for (const payload of pendingPayloads) {
    if (payload.type === 'mailto') {
      mainWindow.webContents.send('mailto', payload.data)
    } else if (payload.type === 'navigate-email') {
      mainWindow.webContents.send('navigate-email', payload.uid)
    }
  }
  pendingPayloads = []
}

function queuePayload(payload) {
  pendingPayloads.push(payload)
  drainPendingPayloads()
}

// ---------------------------------------------------------------------------
// Protocol URL handling (mailto: and brinq://)
// ---------------------------------------------------------------------------
function parseMailtoUrl(url) {
  const parsed = new URL(url)
  const to = decodeURIComponent(parsed.pathname)
    .split(/[;,]/)
    .map((v) => v.trim())
    .filter(Boolean)
  const subject = parsed.searchParams.get('subject') || ''
  const cc = (parsed.searchParams.get('cc') || '')
    .split(/[;,]/)
    .map((v) => v.trim())
    .filter(Boolean)
  const body = parsed.searchParams.get('body') || ''
  return { to, subject, cc, body }
}

function handleProtocolUrl(url) {
  if (url.startsWith('mailto:')) {
    const data = parseMailtoUrl(url)
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
    // Ensure we're on /emails before dispatching
    if (!isOnEmailsRoute() && mainWindow) {
      mainWindow.loadURL(getModeUrl())
    }
    queuePayload({ type: 'mailto', data })
  } else if (url.startsWith('brinq:')) {
    // brinq://auth?token=xxx — Step 4 (optional, deferred)
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  }
}

// Register protocol handlers
app.setAsDefaultProtocolClient('mailto')
app.setAsDefaultProtocolClient('brinq')

// macOS: protocol URLs arrive via open-url event
app.on('open-url', (event, url) => {
  event.preventDefault()
  handleProtocolUrl(url)
})

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------
function createWindow() {
  const bounds = config.getWindowBounds()

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '../assets/icon.png'),
    backgroundColor: '#0a0a0f',
    show: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Show window once content is ready (avoids white flash)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.loadURL(getModeUrl())

  // Save window bounds on move/resize
  const saveBounds = () => {
    if (!mainWindow.isMinimized() && !mainWindow.isMaximized()) {
      config.setWindowBounds(mainWindow.getBounds())
    }
  }
  mainWindow.on('resize', saveBounds)
  mainWindow.on('move', saveBounds)

  // Hide to tray on close (all platforms) — keep background notifications alive
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  // Track when the renderer is on /emails and ready for IPC payloads
  mainWindow.webContents.on('did-finish-load', () => {
    if (isOnLoginPage()) {
      // Clear stale badge when landing on login
      clearBadge()
    }
    if (isOnEmailsRoute()) {
      rendererReady = true
      drainPendingPayloads()
    }
  })

  // Same-origin navigation guard
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const parsed = new URL(url)
      // Allow same-origin navigation (login, dashboard, emails, etc.)
      if (parsed.origin === BASE_ORIGIN) return
      // Off-origin: open in system browser
      event.preventDefault()
      shell.openExternal(url)
    } catch {
      event.preventDefault()
    }
  })

  // Handle window.open() from the web app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Email pop-out: open as native Electron window
    if (isSameOriginEmailPopout(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1100,
          height: 700,
          autoHideMenuBar: true,
          webPreferences: {
            preload: PRELOAD_PATH,
            contextIsolation: true,
            nodeIntegration: false,
          },
        },
      }
    }
    // Off-origin URLs: open in system browser
    if (isOffOriginHttp(url)) {
      shell.openExternal(url)
    }
    // Same-origin non-email (downloads, print helpers): allow
    if (url && !isOffOriginHttp(url) && !isSameOriginEmailPopout(url)) {
      return { action: 'allow' }
    }
    return { action: 'deny' }
  })
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function createTray() {
  // Windows needs ICO or a properly sized PNG; macOS/Linux use PNG
  const iconFile =
    process.platform === 'win32' ? 'icon.ico' : 'tray-icon.png'
  const trayIcon = nativeImage.createFromPath(
    path.join(__dirname, '../assets/', iconFile),
  )
  // Resize for tray (16x16 on Windows, 22x22 on macOS/Linux)
  const resized =
    process.platform === 'win32'
      ? trayIcon.resize({ width: 16, height: 16 })
      : trayIcon
  tray = new Tray(resized)
  tray.setToolTip('Brinq Mail')

  updateTrayMenu()
}

function updateTrayMenu() {
  const currentMode = config.getMode()
  const menu = Menu.buildFromTemplate([
    {
      label: 'Open Brinq',
      click: () => {
        mainWindow.show()
        mainWindow.focus()
      },
    },
    { type: 'separator' },
    {
      label: 'Mail Mode',
      type: 'radio',
      checked: currentMode === 'email',
      click: () => switchMode('email'),
    },
    {
      label: 'Full App Mode',
      type: 'radio',
      checked: currentMode === 'full',
      click: () => switchMode('full'),
    },
    { type: 'separator' },
    {
      label: `Version ${app.getVersion()}`,
      enabled: false,
    },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true
        app.quit()
      },
    },
  ])
  tray.setContextMenu(menu)
}

function switchMode(mode) {
  config.setMode(mode)
  rendererReady = false
  mainWindow.loadURL(getModeUrl())
  updateTrayMenu()
}

// ---------------------------------------------------------------------------
// IPC handlers (with sender origin validation)
// ---------------------------------------------------------------------------
function validateSender(event) {
  try {
    const senderUrl = event.sender.getURL()
    return new URL(senderUrl).origin === BASE_ORIGIN
  } catch {
    return false
  }
}

ipcMain.on('notify', (event, title, body, data) => {
  if (!validateSender(event)) return
  if (typeof title !== 'string' || typeof body !== 'string') return

  const notif = new Notification({
    title,
    body,
    icon: path.join(__dirname, '../assets/icon.png'),
  })
  notif.on('click', () => {
    mainWindow.show()
    mainWindow.focus()
    if (data?.uid && typeof data.uid === 'string') {
      if (isOnEmailsRoute()) {
        mainWindow.webContents.send('navigate-email', data.uid)
      } else {
        // Navigate to /emails with the email UID as a query param
        const mode = config.getMode()
        mainWindow.loadURL(
          `${BASE_URL}/emails?standalone=${mode}&open_email_uid=${encodeURIComponent(data.uid)}`,
        )
      }
    }
  })
  notif.show()
})

ipcMain.on('badge-count', (event, count) => {
  if (!validateSender(event)) return
  const n =
    typeof count === 'number' ? Math.max(0, Math.min(Math.floor(count), 9999)) : 0

  if (process.platform === 'darwin' && app.dock) {
    app.dock.setBadge(n > 0 ? String(n) : '')
  }
  if (tray) {
    tray.setToolTip(
      n > 99
        ? 'Brinq Mail \u2014 99+ unread'
        : n > 0
          ? `Brinq Mail \u2014 ${n} unread`
          : 'Brinq Mail',
    )
  }
})

function clearBadge() {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setBadge('')
  }
  if (tray) {
    tray.setToolTip('Brinq Mail')
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.on('ready', () => {
  createWindow()
  createTray()

  // Check for protocol URLs passed via argv on cold start (Windows)
  const protocolArg = process.argv.find(
    (a) => a.startsWith('mailto:') || a.startsWith('brinq:'),
  )
  if (protocolArg) handleProtocolUrl(protocolArg)

  // Auto-update: check silently on launch, download in background
  // Skip in dev mode — no packaged app to update
  if (process.env.NODE_ENV !== 'development') {
    autoUpdater.logger = require('electron-log')
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.checkForUpdatesAndNotify().catch(() => {})
  }
})

// macOS: re-show window when dock icon clicked
app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show()
    mainWindow.focus()
  }
})

// Ensure app.isQuitting is set for the close handler
app.on('before-quit', () => {
  app.isQuitting = true
})

app.on('window-all-closed', () => {
  // On macOS, apps stay active until explicit quit
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

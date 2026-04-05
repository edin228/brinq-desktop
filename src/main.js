const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  ipcMain,
  shell,
  nativeImage,
  dialog,
} = require('electron')
const { randomUUID } = require('crypto')
const fs = require('fs')
const path = require('path')
const { autoUpdater } = require('electron-updater')
const { simpleParser } = require('mailparser')
const config = require('./config')

// GPU / rendering flags
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-zero-copy')
app.commandLine.appendSwitch('enable-features', 'BackdropFilter')

const PRELOAD_PATH = path.join(__dirname, 'preload.js')
const BASE_URL = config.getBaseUrl()
const BASE_ORIGIN = new URL(BASE_URL).origin

let mainWindow = null
let tray = null
let pendingPayloads = []
let rendererReady = false

// ---------------------------------------------------------------------------
// EML File Viewer — in-memory store and parser
// ---------------------------------------------------------------------------
const MAX_EML_BYTES = 25 * 1024 * 1024
const fileViewerStore = new Map()

function sanitizeDownloadName(filename, index) {
  const base = path.basename(filename || `attachment-${index}`)
  return base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || `attachment-${index}`
}

function escapeHtml(text = '') {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function parseEmailFile(filePath) {
  const stats = await fs.promises.stat(filePath)
  if (!stats.isFile()) throw new Error('Selected path is not a file.')
  if (stats.size > MAX_EML_BYTES) {
    throw new Error(
      `Email file exceeds ${MAX_EML_BYTES / (1024 * 1024)} MB limit.`,
    )
  }

  const buffer = await fs.promises.readFile(filePath)
  let parsed
  try {
    parsed = await simpleParser(buffer)
  } catch {
    throw new Error(
      'This email file could not be parsed. It may be malformed or use an unsupported format.',
    )
  }

  const attachments = (parsed.attachments || []).map((a, index) => ({
    index,
    filename: sanitizeDownloadName(a.filename, index),
    size: a.size || 0,
    contentType: a.contentType || 'application/octet-stream',
  }))

  return {
    metadata: {
      subject: parsed.subject || '(No Subject)',
      from: parsed.from?.value || [],
      to: parsed.to?.value || [],
      cc: parsed.cc?.value || [],
      bcc: parsed.bcc?.value || [],
      date: parsed.date?.toISOString() || null,
      bodyHtml:
        parsed.html ||
        parsed.textAsHtml ||
        `<pre>${escapeHtml(parsed.text || '')}</pre>`,
      text: parsed.text || '',
      attachments,
    },
    rawAttachments: parsed.attachments || [],
  }
}

// ---------------------------------------------------------------------------
// EML File Viewer — IPC validation and URL helpers
// ---------------------------------------------------------------------------
function validateFileViewerSender(event, viewerId) {
  if (!validateSender(event)) return false
  const stored = fileViewerStore.get(viewerId)
  return !!stored && event.sender.id === stored.windowId
}

function isAllowedExternalUrl(url) {
  try {
    const parsed = new URL(url)
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// EML File Viewer — open file in popup window
// ---------------------------------------------------------------------------
async function openEmailFile(filePath) {
  let viewer = null
  let viewerId = null
  let getChannel = null
  let saveChannel = null

  try {
    const result = await parseEmailFile(filePath)
    viewerId = randomUUID()

    viewer = new BrowserWindow({
      width: 1100,
      height: 700,
      title: result.metadata.subject,
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

    fileViewerStore.set(viewerId, {
      ...result,
      windowId: viewer.webContents.id,
    })

    // Register IPC handlers BEFORE loadURL to prevent race with renderer mount
    getChannel = `get-file-email-${viewerId}`
    ipcMain.handle(getChannel, (event) => {
      if (!validateFileViewerSender(event, viewerId)) return null
      return fileViewerStore.get(viewerId)?.metadata || null
    })

    saveChannel = `save-file-attachment-${viewerId}`
    ipcMain.handle(saveChannel, async (event, attachmentIndex) => {
      if (!validateFileViewerSender(event, viewerId)) {
        return { ok: false, canceled: false, error: 'Unauthorized sender.' }
      }

      const stored = fileViewerStore.get(viewerId)
      const att = stored?.rawAttachments?.[attachmentIndex]
      if (!att) {
        return { ok: false, canceled: false, error: 'Attachment not found.' }
      }

      const { canceled, filePath: savePath } = await dialog.showSaveDialog(
        viewer,
        {
          defaultPath: sanitizeDownloadName(att.filename, attachmentIndex),
        },
      )
      if (canceled || !savePath) {
        return { ok: false, canceled: true }
      }

      try {
        await fs.promises.writeFile(savePath, att.content)
        return { ok: true, canceled: false }
      } catch (err) {
        return {
          ok: false,
          canceled: false,
          error: err?.message || 'Failed to save attachment.',
        }
      }
    })

    viewer.once('ready-to-show', () => viewer.show())

    // Keyboard shortcuts for document viewer
    viewer.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const isAccel = input.control || input.meta
      if (!isAccel) return

      const key = input.key.toLowerCase()
      if (key === 'w') {
        event.preventDefault()
        viewer.close()
      } else if (key === 'p') {
        event.preventDefault()
        viewer.webContents.print()
      }
    })

    // Block ALL navigation — loadURL is a top-level load and does not trigger will-navigate
    viewer.webContents.on('will-navigate', (event, url) => {
      event.preventDefault()
      if (isAllowedExternalUrl(url)) {
        shell.openExternal(url)
      }
    })

    viewer.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternalUrl(url)) {
        shell.openExternal(url)
      }
      return { action: 'deny' }
    })

    await viewer.loadURL(
      `${BASE_URL}/email/file-viewer?viewerId=${viewerId}`,
    )

    viewer.once('closed', () => {
      fileViewerStore.delete(viewerId)
      ipcMain.removeHandler(getChannel)
      ipcMain.removeHandler(saveChannel)
      maybeQuitAfterFileViewerClose()
    })
  } catch (err) {
    if (viewerId) {
      fileViewerStore.delete(viewerId)
      if (getChannel) ipcMain.removeHandler(getChannel)
      if (saveChannel) ipcMain.removeHandler(saveChannel)
    }
    if (viewer && !viewer.isDestroyed()) {
      viewer.destroy()
    }
    dialog.showErrorBox(
      'Could not open email file',
      err.message || 'Unknown error.',
    )
  }
}

// ---------------------------------------------------------------------------
// EML File Viewer — OS file-open event wiring
// ---------------------------------------------------------------------------
const pendingEmailFiles = []
const pendingEmailFileSet = new Set()
let launchedForFileViewerOnly = false

function normalizeEmailFilePath(candidate) {
  if (!candidate || typeof candidate !== 'string') return null
  const resolved = path.resolve(candidate)
  if (path.extname(resolved).toLowerCase() !== '.eml') return null
  try {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile())
      return null
  } catch {
    return null
  }
  return resolved
}

function extractEmailFilesFromArgv(argv) {
  return [...new Set(argv.map(normalizeEmailFilePath).filter(Boolean))]
}

function queueEmailFiles(filePaths) {
  for (const filePath of filePaths) {
    if (pendingEmailFileSet.has(filePath)) continue
    pendingEmailFileSet.add(filePath)
    pendingEmailFiles.push(filePath)
  }
}

function maybeQuitAfterFileViewerClose() {
  if (!launchedForFileViewerOnly) return
  if (fileViewerStore.size > 0) return
  if (mainWindow && mainWindow.isVisible()) return
  app.quit()
}

// Check for .eml file paths in argv before app is ready
const startupFiles = extractEmailFilesFromArgv(process.argv)
if (startupFiles.length > 0) {
  launchedForFileViewerOnly = true
  queueEmailFiles(startupFiles)
}

// macOS: open-file event — register before app.on('ready'), just like open-url
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  const normalized = normalizeEmailFilePath(filePath)
  if (!normalized) return
  if (app.isReady()) {
    openEmailFile(normalized)
  } else {
    launchedForFileViewerOnly = true
    queueEmailFiles([normalized])
  }
})

// ---------------------------------------------------------------------------
// Single instance lock
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    // Check for .eml file paths first — open viewers without showing main window
    const emlFiles = extractEmailFilesFromArgv(argv)
    if (emlFiles.length > 0) {
      for (const fp of emlFiles) openEmailFile(fp)
      return
    }

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
    return (
      parsed.origin === BASE_ORIGIN && parsed.pathname.startsWith('/email/')
    )
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
    if (!isOnEmailsRoute() && mainWindow) {
      mainWindow.loadURL(getModeUrl())
    }
    queuePayload({ type: 'mailto', data })
  } else if (url.startsWith('brinq:')) {
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
function createWindow({ showOnReady = true } = {}) {
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

  mainWindow.once('ready-to-show', () => {
    if (showOnReady) mainWindow.show()
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

  // Hide to tray on close — keep background notifications alive
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  // Track when the renderer is on /emails and ready for IPC payloads
  mainWindow.webContents.on('did-finish-load', () => {
    if (isOnLoginPage()) {
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
      if (parsed.origin === BASE_ORIGIN) return
      event.preventDefault()
      shell.openExternal(url)
    } catch {
      event.preventDefault()
    }
  })

  // Handle window.open() from the web app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
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
    if (isOffOriginHttp(url)) {
      shell.openExternal(url)
    }
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
  const iconFile =
    process.platform === 'win32' ? 'icon.ico' : 'tray-icon.png'
  const trayIcon = nativeImage.createFromPath(
    path.join(__dirname, '../assets/', iconFile),
  )
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
        const mode = config.getMode()
        mainWindow.loadURL(
          `${BASE_URL}/emails?standalone=${mode}&open_email_uid=${encodeURIComponent(data.uid)}`,
        )
      }
    }
  })
  notif.show()
})

ipcMain.on('set-mode', (event, mode) => {
  if (!validateSender(event)) return
  if (mode === 'email' || mode === 'full') {
    config.setMode(mode)
    updateTrayMenu()
  }
})

ipcMain.on('badge-count', (event, count) => {
  if (!validateSender(event)) return
  const n =
    typeof count === 'number'
      ? Math.max(0, Math.min(Math.floor(count), 9999))
      : 0

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
  createWindow({ showOnReady: !launchedForFileViewerOnly })
  createTray()

  // Drain any .eml files queued before app was ready
  for (const fp of pendingEmailFiles.splice(0)) {
    pendingEmailFileSet.delete(fp)
    openEmailFile(fp)
  }

  // Check for protocol URLs passed via argv on cold start (Windows)
  const protocolArg = process.argv.find(
    (a) => a.startsWith('mailto:') || a.startsWith('brinq:'),
  )
  if (protocolArg) handleProtocolUrl(protocolArg)

  // Auto-update: check silently on launch, download in background
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

app.on('before-quit', () => {
  app.isQuitting = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

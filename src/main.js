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
const MsgReader = require('@kenjiuno/msgreader').default
const { decompressRTF } = require('@kenjiuno/decompressrtf')
const { deEncapsulateSync } = require('rtf-stream-parser')
const iconv = require('iconv-lite')
const config = require('./config')

// Windows: set App User Model ID so notifications show "Brinq" not "electron.app.brinq"
if (process.platform === 'win32') {
  app.setAppUserModelId('Brinq')
}

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
const MAX_CONCURRENT_VIEWERS = 10
const fileViewerStore = new Map()
let pendingViewerCount = 0
let viewerCapErrorShown = false

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

// ---------------------------------------------------------------------------
// .msg file helpers
// ---------------------------------------------------------------------------
function decodeRtfText(value, charset) {
  const source = Buffer.isBuffer(value) ? value : Buffer.from(value)
  const encoding =
    charset && iconv.encodingExists(charset) ? charset : 'windows-1252'
  return iconv.decode(source, encoding)
}

function normalizeCid(value = '') {
  return String(value).trim().replace(/^<|>$/g, '').toLowerCase()
}

function replaceCidUrls(html, cidMap) {
  return html.replace(/cid:([^"'\s)]+)/gi, (match, rawCid) => {
    return cidMap.get(normalizeCid(rawCid)) || match
  })
}

function parseMsgFile(buffer) {
  let reader
  let data

  try {
    reader = new MsgReader(buffer)
    data = reader.getFileData()
  } catch {
    throw new Error(
      'This email file could not be parsed. It may be malformed or use an unsupported format.',
    )
  }

  if (
    data.messageClass &&
    !String(data.messageClass).toLowerCase().startsWith('ipm.note')
  ) {
    throw new Error('This .msg file is not an email message.')
  }

  // --- Body extraction pipeline ---
  // Priority: HTML string → HTML bytes → de-encapsulated RTF HTML → plain text
  let bodyHtml = null
  let bodyText = data.body || ''

  if (data.bodyHtml) {
    bodyHtml = data.bodyHtml
  } else if (data.html?.length) {
    bodyHtml = Buffer.from(data.html).toString('utf-8')
  }

  if (!bodyHtml && data.compressedRtf?.length) {
    try {
      const rtfBytes = decompressRTF(data.compressedRtf)
      const result = deEncapsulateSync(Buffer.from(rtfBytes), {
        decode: (value, charset) => decodeRtfText(value, charset),
      })

      if (result.mode === 'html' && result.text) {
        bodyHtml =
          typeof result.text === 'string'
            ? result.text
            : Buffer.from(result.text).toString('utf-8')
      } else if (result.mode === 'text' && result.text && !bodyText) {
        bodyText =
          typeof result.text === 'string'
            ? result.text
            : decodeRtfText(result.text)
      }
    } catch {
      // RTF may be malformed or may not contain encapsulated HTML/text
    }
  }

  // --- Attachments and CID resolution ---
  const visibleAttachments = []
  const cidMap = new Map()

  for (const [sourceIndex, att] of (data.attachments || []).entries()) {
    let attachment
    try {
      attachment = reader.getAttachment(att)
    } catch {
      continue
    }

    const contentBuffer = attachment?.content
      ? Buffer.from(attachment.content)
      : Buffer.alloc(0)
    const filename =
      attachment?.fileName ||
      att.fileName ||
      att.fileNameShort ||
      `attachment-${sourceIndex}`
    const contentType = att.attachMimeTag || 'application/octet-stream'
    const normalizedCid = normalizeCid(att.pidContentId)

    if (normalizedCid && contentBuffer.length > 0) {
      cidMap.set(
        normalizedCid,
        `data:${contentType};base64,${contentBuffer.toString('base64')}`,
      )
    }

    if (att.attachmentHidden) continue

    const attachmentIndex = visibleAttachments.length
    visibleAttachments.push({
      raw: {
        content: contentBuffer,
        filename,
        contentType,
      },
      metadata: {
        index: attachmentIndex,
        filename: sanitizeDownloadName(filename, attachmentIndex),
        size: contentBuffer.length,
        contentType,
      },
    })
  }

  if (bodyHtml && cidMap.size > 0) {
    bodyHtml = replaceCidUrls(bodyHtml, cidMap)
  }

  if (!bodyHtml) {
    bodyHtml = `<pre>${escapeHtml(bodyText)}</pre>`
  }

  // --- Recipients ---
  const from = []
  if (data.senderName || data.senderSmtpAddress || data.senderEmail) {
    from.push({
      name: data.senderName || '',
      address: data.senderSmtpAddress || data.senderEmail || '',
    })
  }

  const to = []
  const cc = []
  const bcc = []
  for (const r of data.recipients || []) {
    const entry = {
      name: r.name || '',
      address: r.smtpAddress || r.email || '',
    }
    if (r.recipType === 'cc') cc.push(entry)
    else if (r.recipType === 'bcc') bcc.push(entry)
    else to.push(entry)
  }

  const dateStr = data.clientSubmitTime || data.messageDeliveryTime || null
  let date = null
  if (dateStr) {
    const parsedDate = new Date(dateStr)
    if (!Number.isNaN(parsedDate.getTime())) {
      date = parsedDate.toISOString()
    }
  }

  return {
    metadata: {
      subject: data.subject || '(No Subject)',
      from,
      to,
      cc,
      bcc,
      date,
      bodyHtml,
      text: bodyText,
      attachments: visibleAttachments.map((entry) => entry.metadata),
    },
    rawAttachments: visibleAttachments.map((entry) => entry.raw),
  }
}

// ---------------------------------------------------------------------------
// Email file parsing — routes .eml and .msg
// ---------------------------------------------------------------------------
async function parseEmailFile(filePath) {
  const stats = await fs.promises.stat(filePath)
  if (!stats.isFile()) throw new Error('Selected path is not a file.')
  if (stats.size > MAX_EML_BYTES) {
    throw new Error(
      `Email file exceeds ${MAX_EML_BYTES / (1024 * 1024)} MB limit.`,
    )
  }

  const buffer = await fs.promises.readFile(filePath)
  const ext = path.extname(filePath).toLowerCase()

  if (ext === '.msg') {
    return parseMsgFile(buffer)
  }

  // .eml parsing
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
// EML File Viewer — static IPC handlers (registered once at startup)
// ---------------------------------------------------------------------------
ipcMain.handle('get-file-email', (event, viewerId) => {
  if (
    typeof viewerId !== 'string' ||
    !validateFileViewerSender(event, viewerId)
  )
    return null
  return fileViewerStore.get(viewerId)?.metadata || null
})

ipcMain.handle(
  'save-file-attachment',
  async (event, viewerId, attachmentIndex) => {
    if (
      typeof viewerId !== 'string' ||
      !validateFileViewerSender(event, viewerId)
    ) {
      return { ok: false, canceled: false, error: 'Unauthorized sender.' }
    }

    if (
      typeof attachmentIndex !== 'number' ||
      !Number.isInteger(attachmentIndex) ||
      attachmentIndex < 0
    ) {
      return { ok: false, canceled: false, error: 'Invalid attachment index.' }
    }

    const stored = fileViewerStore.get(viewerId)
    const att = stored?.rawAttachments?.[attachmentIndex]
    if (!att) {
      return { ok: false, canceled: false, error: 'Attachment not found.' }
    }

    const viewer = BrowserWindow.fromWebContents(event.sender)
    if (!viewer || viewer.isDestroyed()) {
      return { ok: false, canceled: false, error: 'Viewer window closed.' }
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
  },
)

// Formats safe for direct open — passive renderers or Office Protected View
const SAFE_OPEN_EXTENSIONS = new Set([
  '.pdf',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff',
  '.txt', '.csv',
  '.docx', '.xlsx', '.pptx',
])

const BRINQ_TEMP_DIR = path.join(app.getPath('temp'), 'brinq-viewer')
const viewerTempFiles = new Map() // viewerId -> Set<tempPath>

function cleanupTempDir() {
  fs.rm(BRINQ_TEMP_DIR, { recursive: true, force: true }, () => {})
}

function retryUnlink(filePath, attemptsLeft) {
  fs.unlink(filePath, (err) => {
    if (!err || attemptsLeft <= 1) return
    setTimeout(() => retryUnlink(filePath, attemptsLeft - 1), 15000)
  })
}

function cleanupViewerTempFiles(viewerId) {
  const files = viewerTempFiles.get(viewerId)
  if (!files) return
  viewerTempFiles.delete(viewerId)
  // Retry up to 4 times over ~1 minute (5s + 15s + 15s + 15s)
  setTimeout(() => {
    for (const tempPath of files) {
      retryUnlink(tempPath, 4)
    }
  }, 5000)
}

ipcMain.handle(
  'open-file-attachment',
  async (event, viewerId, attachmentIndex) => {
    if (
      typeof viewerId !== 'string' ||
      !validateFileViewerSender(event, viewerId)
    ) {
      return { ok: false, error: 'Unauthorized sender.', unsafe: false }
    }

    if (
      typeof attachmentIndex !== 'number' ||
      !Number.isInteger(attachmentIndex) ||
      attachmentIndex < 0
    ) {
      return { ok: false, error: 'Invalid attachment index.', unsafe: false }
    }

    const stored = fileViewerStore.get(viewerId)
    const att = stored?.rawAttachments?.[attachmentIndex]
    if (!att) {
      return { ok: false, error: 'Attachment not found.', unsafe: false }
    }

    const safeName = sanitizeDownloadName(att.filename, attachmentIndex)
    const ext = path.extname(safeName).toLowerCase()

    if (!SAFE_OPEN_EXTENSIONS.has(ext)) {
      return {
        ok: false,
        unsafe: true,
        error: `Cannot open .${ext.slice(1)} files directly. Use "Save As" instead.`,
      }
    }

    try {
      await fs.promises.mkdir(BRINQ_TEMP_DIR, { recursive: true })
      const tempPath = path.join(BRINQ_TEMP_DIR, `${Date.now()}-${safeName}`)
      await fs.promises.writeFile(tempPath, att.content)

      if (!viewerTempFiles.has(viewerId)) viewerTempFiles.set(viewerId, new Set())
      viewerTempFiles.get(viewerId).add(tempPath)

      const errorMessage = await shell.openPath(tempPath)
      if (errorMessage) {
        return { ok: false, error: errorMessage, unsafe: false }
      }
      return { ok: true }
    } catch (err) {
      return {
        ok: false,
        unsafe: false,
        error: err?.message || 'Failed to open attachment.',
      }
    }
  },
)

// ---------------------------------------------------------------------------
// EML File Viewer — open file in popup window
// ---------------------------------------------------------------------------
async function openEmailFile(filePath) {
  if (fileViewerStore.size + pendingViewerCount >= MAX_CONCURRENT_VIEWERS) {
    if (!viewerCapErrorShown) {
      viewerCapErrorShown = true
      dialog.showErrorBox(
        'Too many viewers open',
        `Please close some email viewer windows first (max ${MAX_CONCURRENT_VIEWERS}).`,
      )
      process.nextTick(() => { viewerCapErrorShown = false })
    }
    return
  }

  pendingViewerCount++
  let viewer = null
  let viewerId = null
  let registered = false

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
    pendingViewerCount--
    registered = true

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

    const viewerUrl = `${BASE_URL}/email/file-viewer?viewerId=${viewerId}`

    viewer.webContents.on('will-navigate', (event, url) => {
      if (url === viewerUrl) return
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

    try {
      await viewer.loadURL(viewerUrl)
    } catch (loadErr) {
      // ERR_ABORTED (-3) means our will-navigate handler blocked a navigation.
      // This can only happen AFTER the page's JavaScript ran (triggering the
      // redirect we blocked), so the page loaded successfully. Non-abort errors
      // (ERR_CONNECTION_REFUSED, ERR_NAME_NOT_RESOLVED, etc.) indicate real
      // failures where the page never loaded.
      const isAbort =
        loadErr &&
        (String(loadErr.message || '').includes('ERR_ABORTED') ||
          String(loadErr.code) === '-3')
      if (!isAbort) throw loadErr
    }

    viewer.once('closed', () => {
      fileViewerStore.delete(viewerId)
      cleanupViewerTempFiles(viewerId)
      maybeQuitAfterFileViewerClose()
    })
  } catch (err) {
    if (!registered) pendingViewerCount--
    if (viewerId) fileViewerStore.delete(viewerId)
    if (viewer && !viewer.isDestroyed()) viewer.destroy()
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
  const ext = path.extname(resolved).toLowerCase()
  if (ext !== '.eml' && ext !== '.msg') return null
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
      launchedForFileViewerOnly = false
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
      launchedForFileViewerOnly = false
      mainWindow.show()
      mainWindow.focus()
    }
    if (!isOnEmailsRoute() && mainWindow) {
      mainWindow.loadURL(getModeUrl())
    }
    queuePayload({ type: 'mailto', data })
  } else if (url.startsWith('brinq:')) {
    if (mainWindow) {
      launchedForFileViewerOnly = false
      mainWindow.show()
      mainWindow.focus()
    }
  }
}

// Register Brinq-owned deep links only. Do not register as the system
// mailto: handler; Outlook and AMS360 depend on that association.
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
        launchedForFileViewerOnly = false
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
    launchedForFileViewerOnly = false
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
  cleanupTempDir()
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
    launchedForFileViewerOnly = false
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

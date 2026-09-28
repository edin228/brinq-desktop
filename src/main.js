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
  screen,
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
const { isMode, modeUrl, visibleBounds, parseProtocolUrl, incomingNavigationUrl, createNavigationQueue } = require('./window-state')
const { createWindowSecurity } = require('./window-security')
const {
  isSafeOpenFilename,
  sanitizeDownloadName,
  truncateFilenameBytes,
  profileTempDir,
  ensurePrivateDirectory,
  cleanupProfileTemp,
  markFileAsInternetOrigin,
  requiresInternetOriginProtection,
} = require('./attachment-files')
const { createFileActions, CAPABILITIES } = require('./file-actions')

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
const windowSecurity = createWindowSecurity({
  baseUrl: BASE_URL,
  preloadPath: PRELOAD_PATH,
  openExternal: (url) => shell.openExternal(url),
})

let mainWindow = null
let tray = null
const navigationQueue = createNavigationQueue()
let navigatingMain = false

// ---------------------------------------------------------------------------
// EML File Viewer — in-memory store and parser
// ---------------------------------------------------------------------------
const MAX_EML_BYTES = 25 * 1024 * 1024
const MAX_CONCURRENT_VIEWERS = 10
const fileViewerStore = new Map()
let pendingViewerCount = 0
let viewerCapErrorShown = false

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
  return windowSecurity.validateViewerSender(event, fileViewerStore.get(viewerId))
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
    const stillAuthorized = windowSecurity.captureSender(event, ['viewer'])
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
      if (!stillAuthorized()) {
        return { ok: false, canceled: true, error: 'Window navigated or closed.' }
      }
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

const BRINQ_TEMP_DIR = profileTempDir(app.getPath('temp'), app.getPath('userData'))
const viewerTempFiles = new Map() // viewerId -> Set<tempPath>

function ensurePrivateTempDir() {
  return ensurePrivateDirectory(BRINQ_TEMP_DIR)
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

function scheduleSyncedAttachmentCleanup(tempPath) {
  const timer = setTimeout(
    () => retryUnlink(tempPath, 4),
    24 * 60 * 60 * 1000,
  )
  timer.unref()
}

ipcMain.handle(
  'open-file-attachment',
  async (event, viewerId, attachmentIndex) => {
    const stillAuthorized = windowSecurity.captureSender(event, ['viewer'])
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

    if (!isSafeOpenFilename(safeName)) {
      return {
        ok: false,
        unsafe: true,
        error: `Cannot open .${ext.slice(1)} files directly. Use "Save As" instead.`,
      }
    }

    let tempPath
    let tempCreated = false
    try {
      await ensurePrivateTempDir()
      tempPath = path.join(
        BRINQ_TEMP_DIR,
        `${randomUUID()}-${truncateFilenameBytes(safeName, 180)}`,
      )
      const handle = await fs.promises.open(tempPath, 'wx', 0o600)
      tempCreated = true
      try {
        await handle.writeFile(att.content)
      } finally {
        await handle.close()
      }

      try {
        const protectedByOs = await markFileAsInternetOrigin(
          tempPath,
          BASE_ORIGIN,
        )
        if (!protectedByOs && requiresInternetOriginProtection(safeName)) {
          retryUnlink(tempPath, 1)
          return {
            ok: false,
            unsafe: true,
            error: 'This file type must be saved before it can be opened.',
          }
        }
      } catch (err) {
        if (requiresInternetOriginProtection(safeName)) {
          retryUnlink(tempPath, 1)
          return {
            ok: false,
            unsafe: true,
            error: 'Could not apply OS security protections. Use "Save As" instead.',
          }
        }
        console.warn('Could not mark attachment as Internet-originated:', err)
      }

      if (!viewerTempFiles.has(viewerId)) viewerTempFiles.set(viewerId, new Set())
      viewerTempFiles.get(viewerId).add(tempPath)

      if (!stillAuthorized()) {
        retryUnlink(tempPath, 1)
        return { ok: false, unsafe: false, error: 'Window navigated or closed.' }
      }
      const errorMessage = await shell.openPath(tempPath)
      if (errorMessage) {
        retryUnlink(tempPath, 1)
        return { ok: false, error: 'No application could open this file. Use Save As instead.', unsafe: false }
      }
      return { ok: true }
    } catch (err) {
      if (tempCreated) retryUnlink(tempPath, 1)
      return {
        ok: false,
        unsafe: false,
        error: err?.message || 'Failed to open attachment.',
      }
    }
  },
)

// Authenticated remote files share one cancellable streaming owner.
const fileActions = createFileActions({
  baseUrl: BASE_URL,
  security: windowSecurity,
  tempDir: BRINQ_TEMP_DIR,
  showSaveDialog: (contents, options) => {
    const owner = BrowserWindow.fromWebContents(contents)
    if (!owner || owner.isDestroyed()) return { canceled: true }
    return dialog.showSaveDialog(owner, options)
  },
  openPath: (file) => shell.openPath(file),
  scheduleCleanup: scheduleSyncedAttachmentCleanup,
})
ipcMain.handle('open-file', (event, source, id) => fileActions.open(event, source, id))
ipcMain.handle('save-file-as', (event, source, id) => fileActions.save(event, source, id))
ipcMain.handle('cancel-file-operation', (event, id) => fileActions.cancel(event, id))
ipcMain.handle('file-capabilities', (event) => validateSender(event) ? CAPABILITIES : null)

// Old frontend versions retain their result fields and fixed email methods.
for (const [channel, action] of [['open-email-attachment', 'open'], ['save-email-attachment', 'save']]) {
  ipcMain.handle(channel, (event, emailUid, attachmentId, filename) =>
    fileActions[action](event, { kind: 'synced-email-attachment', emailUid, attachmentId, filename }, randomUUID()))
}

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
        sandbox: true,
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

    windowSecurity.register(viewer, 'viewer', viewerUrl)

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
function getModeUrl() {
  return modeUrl(BASE_URL, config.getMode())
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
  if (!mainWindow || navigatingMain || !isOnEmailsRoute()) return
  const contents = mainWindow.webContents
  const frame = contents.mainFrame
  if (!windowSecurity.validateSender({ sender: contents, senderFrame: frame }, ['main'])) return
  navigationQueue.drain(frame, (channel, data) => contents.send(channel, data))
}

function routePendingPayloads() {
  if (!mainWindow || navigatingMain || !navigationQueue.hasPending()) return
  const target = incomingNavigationUrl(mainWindow.webContents.getURL(), BASE_URL, config.getMode())
  if (target) mainWindow.loadURL(target).catch(() => {})
  else drainPendingPayloads()
}

function queuePayload(channel, data) {
  navigationQueue.push(channel, data)
  routePendingPayloads()
}

// Protocols activate Brinq or compose email; they never select an arbitrary URL.
function handleProtocolUrl(url) {
  const payload = parseProtocolUrl(url)
  if (!payload) return
  if (mainWindow) {
    launchedForFileViewerOnly = false
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
  if (payload.type === 'mailto') queuePayload('mailto', payload.data)
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
  const bounds = visibleBounds(config.getWindowBounds(), screen.getAllDisplays().map((display) => display.workArea), screen.getPrimaryDisplay().workArea)

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
      sandbox: true,
    },
  })

  mainWindow.once('ready-to-show', () => {
    if (showOnReady) mainWindow.show()
  })

  windowSecurity.register(mainWindow, 'main')
  mainWindow.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) {
      navigatingMain = true
      navigationQueue.reset()
    }
  })
  mainWindow.webContents.on('did-frame-navigate', (_event, _url, _code, _text, isMainFrame) => {
    if (isMainFrame) navigatingMain = false
  })
  mainWindow.webContents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
    if (isMainFrame) routePendingPayloads()
  })
  mainWindow.loadURL(navigationQueue.hasPending() ? modeUrl(BASE_URL, config.getMode(), true) : getModeUrl()).catch(() => {})

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

  mainWindow.webContents.on('did-finish-load', () => {
    if (isOnLoginPage()) clearBadge()
    routePendingPayloads()
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

function desktopState() {
  return { mode: config.getMode(), version: app.getVersion() }
}

async function switchMode(mode) {
  if (!isMode(mode)) return { ok: false, error: 'Choose Mail Mode or Full App Mode.' }
  try {
    await mainWindow.loadURL(modeUrl(BASE_URL, mode))
    config.setMode(mode)
    updateTrayMenu()
    return { ok: true, state: desktopState() }
  } catch {
    return { ok: false, state: desktopState(), error: 'Could not open the selected mode. Please try again.' }
  }
}

// ---------------------------------------------------------------------------
// IPC handlers (with sender origin validation)
// ---------------------------------------------------------------------------
function validateSender(event) {
  return windowSecurity.validateSender(event)
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
      queuePayload('navigate-email', data.uid)
    }
  })
  notif.show()
})

ipcMain.handle('desktop-state', (event) => validateSender(event) ? desktopState() : null)
ipcMain.handle('change-mode', (event, mode) => {
  if (!validateSender(event)) return { ok: false, error: 'Unauthorized sender.' }
  return switchMode(mode)
})
ipcMain.on('email-listener-state', (event, channel, active) => {
  if (!windowSecurity.validateSender(event, ['main']) || typeof active !== 'boolean') return
  navigationQueue.subscribe(channel, event.senderFrame, active)
  drainPendingPayloads()
})

ipcMain.on('set-mode', (event, mode) => {
  if (!validateSender(event)) return
  if (isMode(mode)) {
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
app.on('ready', async () => {
  if (!gotLock) return
  try {
    await cleanupProfileTemp(BRINQ_TEMP_DIR, gotLock)
  } catch (err) {
    console.warn('Could not clean attachment temp directory:', err)
  }
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

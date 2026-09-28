// Native authority belongs to a registered window's current top document.
const APP_ROLES = ['main', 'app']

function parseUrl(value) {
  try { return new URL(value) } catch { return null }
}

function resolveBaseUrl({ isPackaged, env = process.env }) {
  if (isPackaged || env.NODE_ENV !== 'development') return 'https://brinq.io'
  const url = parseUrl(env.BRINQ_DEV_URL || 'http://localhost:3000')
  if (!url || url.protocol !== 'http:' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('BRINQ_DEV_URL must be an HTTP loopback origin, including the development port.')
  }
  return url.origin
}

function createWindowSecurity({ baseUrl, preloadPath, openExternal }) {
  const origin = new URL(baseUrl).origin
  const windows = new Map()
  const sessions = new WeakSet()
  const isAppUrl = (value) => {
    const url = parseUrl(value)
    return !!url && ['http:', 'https:'].includes(url.protocol) &&
      url.origin === origin && !url.username && !url.password
  }
  const isExternalUrl = (value) => {
    const url = parseUrl(value)
    return !!url && ['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol) &&
      !url.username && !url.password
  }
  const presentationUrl = (value) => {
    const url = parseUrl(value)
    return value === 'about:blank' || (url?.protocol === 'blob:' && url.origin === origin)
  }
  const allowedDocument = (entry, url) =>
    entry.role === 'viewer' ? url === entry.url :
      APP_ROLES.includes(entry.role) ? isAppUrl(url) : presentationUrl(url)

  function validateSender(event, roles = APP_ROLES) {
    try {
      const wc = event.sender
      const frame = event.senderFrame
      const entry = windows.get(wc)
      return !!entry && roles.includes(entry.role) && !entry.window.isDestroyed() &&
        !wc.isDestroyed() && !entry.navigating && !!frame && !frame.detached &&
        frame === wc.mainFrame && frame.parent === null && frame.origin === origin &&
        allowedDocument(entry, frame.url) && allowedDocument(entry, wc.getURL())
    } catch { return false }
  }

  function validateViewerSender(event, storedViewer) {
    return validateSender(event, ['viewer']) && !!storedViewer &&
      event.sender.id === storedViewer.windowId
  }

  function captureSender(event, roles = APP_ROLES) {
    const entry = windows.get(event.sender)
    const generation = entry?.generation
    return () => windows.get(event.sender) === entry &&
      entry?.generation === generation && validateSender(event, roles)
  }

  function permissionAllowed(wc, permission, requestingOrigin, details) {
    if (permission !== 'clipboard-sanitized-write' || details?.isMainFrame !== true) return false
    if (!isAppUrl(requestingOrigin) || !isAppUrl(details.requestingUrl)) return false
    return validateSender({ sender: wc, senderFrame: wc?.mainFrame }, [...APP_ROLES, 'viewer'])
  }

  function register(window, role, url) {
    const wc = window.webContents
    const entry = { window, role, url, generation: 0, navigating: false }
    windows.set(wc, entry)
    wc.once('destroyed', () => windows.delete(wc))
    window.once('closed', () => windows.delete(wc))
    wc.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) { entry.generation++; entry.navigating = true }
    })
    wc.on('did-frame-navigate', (_event, _url, _code, _text, isMainFrame) => {
      if (isMainFrame) entry.navigating = false
    })
    // Redirects never launch external applications. Only deliberate navigation does.
    const guard = (event, target, external) => {
      if (allowedDocument(entry, target)) return
      event.preventDefault()
      if (external && role !== 'presentation' && isExternalUrl(target)) {
        Promise.resolve(openExternal(target)).catch(() => {})
      }
    }
    wc.on('will-navigate', (event, target) => guard(event, event.url || target, true))
    wc.on('will-redirect', (event, target, _inPlace, isMainFrame) => {
      if (event.isMainFrame ?? isMainFrame) guard(event, event.url || target, false)
    })
    wc.setWindowOpenHandler(({ url: target }) => {
      if (!validateSender({ sender: wc, senderFrame: wc.mainFrame }, [...APP_ROLES, 'viewer'])) {
        return { action: 'deny' }
      }
      const privileged = APP_ROLES.includes(role) && isAppUrl(target)
      if (privileged || presentationUrl(target)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 1100, height: 700, autoHideMenuBar: true,
            webPreferences: {
              preload: privileged ? preloadPath : '',
              contextIsolation: true, nodeIntegration: false, sandbox: true,
              webviewTag: false,
              // Blob previews can contain active content; they only display bytes.
              javascript: !target.startsWith('blob:'),
            },
          },
        }
      }
      if (isExternalUrl(target)) Promise.resolve(openExternal(target)).catch(() => {})
      return { action: 'deny' }
    })
    wc.on('did-create-window', (child, details) => {
      register(child, APP_ROLES.includes(role) && isAppUrl(details.url) ? 'app' : 'presentation')
    })
    if (!sessions.has(wc.session)) {
      sessions.add(wc.session)
      wc.session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
        permissionAllowed(contents, permission, requestingOrigin, details))
      wc.session.setPermissionRequestHandler((contents, permission, callback, details) =>
        callback(permissionAllowed(contents, permission, details?.requestingUrl, details)))
    }
  }

  return { register, validateSender, validateViewerSender, captureSender }
}

module.exports = { createWindowSecurity, resolveBaseUrl }

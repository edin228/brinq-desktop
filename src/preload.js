const { contextBridge, ipcRenderer } = require('electron')

function subscribe(channel, callback) {
  const handler = (_, data) => callback(data)
  ipcRenderer.on(channel, handler)
  if (ipcRenderer.listenerCount(channel) === 1) ipcRenderer.send('email-listener-state', channel, true)
  let active = true
  return () => {
    if (!active) return
    active = false
    ipcRenderer.removeListener(channel, handler)
    if (ipcRenderer.listenerCount(channel) === 0) ipcRenderer.send('email-listener-state', channel, false)
  }
}

// about:blank inherits its parent's preload in Electron. Never expose a bridge
// there, in blob previews, or in subframes, even when their origin is inherited.
if (process.isMainFrame && ['http:', 'https:'].includes(location.protocol)) {
  contextBridge.exposeInMainWorld('electronAPI', {
    notify: (title, body, data) => ipcRenderer.send('notify', title, body, data),

    setBadgeCount: (count) => ipcRenderer.send('badge-count', count),

    setMode: (mode) => ipcRenderer.send('set-mode', mode),

    getDesktopState: () => ipcRenderer.invoke('desktop-state'),

    changeMode: (mode) => ipcRenderer.invoke('change-mode', mode),

    getUpdateStatus: () => ipcRenderer.invoke('update-status'),

    checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),

    restartToUpdate: () => ipcRenderer.invoke('restart-to-update'),

    onUpdateStatus: (callback) => {
      const handler = (_, state) => callback(state)
      ipcRenderer.on('update-status', handler)
      return () => ipcRenderer.removeListener('update-status', handler)
    },

    onNavigateEmail: (callback) => subscribe('navigate-email', callback),

    onMailto: (callback) => subscribe('mailto', callback),

    getFileCapabilities: () => ipcRenderer.invoke('file-capabilities'),

    openFile: (source, operationId) => ipcRenderer.invoke('open-file', source, operationId),

    saveFileAs: (source, operationId) => ipcRenderer.invoke('save-file-as', source, operationId),

    cancelFileOperation: (operationId) => ipcRenderer.invoke('cancel-file-operation', operationId),

    // EML file viewer — static IPC channels with viewerId as argument
    getFileEmail: (viewerId) =>
      ipcRenderer.invoke('get-file-email', viewerId),

    saveFileAttachment: (viewerId, attachmentIndex) =>
      ipcRenderer.invoke('save-file-attachment', viewerId, attachmentIndex),

    openFileAttachment: (viewerId, attachmentIndex) =>
      ipcRenderer.invoke('open-file-attachment', viewerId, attachmentIndex),

    openEmailAttachment: (emailUid, attachmentId, filename) =>
      ipcRenderer.invoke(
        'open-email-attachment',
        emailUid,
        attachmentId,
        filename,
      ),

    saveEmailAttachment: (emailUid, attachmentId, filename) =>
      ipcRenderer.invoke(
        'save-email-attachment',
        emailUid,
        attachmentId,
        filename,
      ),

    // Windows only; the page shows browser sign-in when all three exist.
    ...(process.platform === 'win32' ? {
      startBrowserSignIn: () => ipcRenderer.invoke('browser-sign-in-start'),
      cancelBrowserSignIn: () => ipcRenderer.invoke('browser-sign-in-cancel'),
      takeBrowserSignIn: () => ipcRenderer.invoke('browser-sign-in-take'),
    } : {}),
  })

  // Report Brinq's light/dark theme so the desktop header can match it.
  // next-themes marks the root element with a `light` or `dark` class.
  let reported = null
  const reportTheme = (force = false) => {
    const classes = document.documentElement?.classList
    if (!classes) return
    const dark = classes.contains('dark')
    const light = classes.contains('light')
    if (dark === light) return
    const theme = dark ? 'dark' : 'light'
    if (!force && theme === reported) return
    reported = theme
    ipcRenderer.send('theme-changed', theme)
  }
  const observeTheme = () => {
    const observer = new MutationObserver(() => reportTheme())
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    window.addEventListener('pagehide', () => observer.disconnect(), { once: true })
    reportTheme()
  }
  // Name the tab a link opens before its page loads: send the link's label
  // synchronously, so the main process has it before the open request that
  // the same gesture produces. Client links carry data-tab-label; other
  // links fall back to their visible text.
  const MAX_LINK_LABEL = 120
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim()
  const captureLink = (event) => {
    if (!event.isTrusted || event.defaultPrevented) return
    const target = event.target
    if (!(target instanceof Element)) return
    const anchor = target.closest('a[href]')
    if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute('download')) return
    if (anchor.origin !== location.origin) return
    const text = clean(anchor.getAttribute('data-tab-label')) || clean(anchor.innerText)
    const label = Array.from(text).slice(0, MAX_LINK_LABEL).join('')
    if (!label) return
    try { ipcRenderer.sendSync('link-label', { href: anchor.href, label }) } catch {}
  }
  const plain = (event) => !event.altKey && !event.shiftKey
  // Keyboard-generated clicks (detail 0) are left to the keydown capture.
  document.addEventListener('click', (event) => {
    if (event.button === 0 && event.detail !== 0 && (event.ctrlKey || event.metaKey) && plain(event)) captureLink(event)
  }, true)
  document.addEventListener('auxclick', (event) => {
    if (event.button === 1 && plain(event)) captureLink(event)
  }, true)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && plain(event) && !event.repeat && !event.isComposing) captureLink(event)
  }, true)

  // Main asks again after each load and tab switch, since a report sent
  // while the page was still navigating is not accepted.
  ipcRenderer.on('theme-request', () => reportTheme(true))
  if (document.documentElement) observeTheme()
  else document.addEventListener('DOMContentLoaded', observeTheme, { once: true })
}

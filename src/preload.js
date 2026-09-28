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
  })
}

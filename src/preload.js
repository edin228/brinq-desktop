const { contextBridge, ipcRenderer } = require('electron')

// about:blank inherits its parent's preload in Electron. Never expose a bridge
// there, in blob previews, or in subframes, even when their origin is inherited.
if (process.isMainFrame && ['http:', 'https:'].includes(location.protocol)) {
  contextBridge.exposeInMainWorld('electronAPI', {
    notify: (title, body, data) => ipcRenderer.send('notify', title, body, data),

    setBadgeCount: (count) => ipcRenderer.send('badge-count', count),

    setMode: (mode) => ipcRenderer.send('set-mode', mode),

    onNavigateEmail: (callback) => {
      const handler = (_, uid) => callback(uid)
      ipcRenderer.on('navigate-email', handler)
      return () => ipcRenderer.removeListener('navigate-email', handler)
    },

    onMailto: (callback) => {
      const handler = (_, data) => callback(data)
      ipcRenderer.on('mailto', handler)
      return () => ipcRenderer.removeListener('mailto', handler)
    },

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

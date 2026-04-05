const { contextBridge, ipcRenderer } = require('electron')

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

  // EML file viewer — static IPC channels with viewerId as argument
  getFileEmail: (viewerId) =>
    ipcRenderer.invoke('get-file-email', viewerId),

  saveFileAttachment: (viewerId, attachmentIndex) =>
    ipcRenderer.invoke('save-file-attachment', viewerId, attachmentIndex),

  openFileAttachment: (viewerId, attachmentIndex) =>
    ipcRenderer.invoke('open-file-attachment', viewerId, attachmentIndex),
})

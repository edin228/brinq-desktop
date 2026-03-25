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
})

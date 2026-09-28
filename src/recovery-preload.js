const { contextBridge, ipcRenderer } = require('electron')

if (process.isMainFrame && location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('brinqRecovery', {
    retry: () => ipcRenderer.invoke('retry-app-load'),
  })
}

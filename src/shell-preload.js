const { contextBridge, ipcRenderer } = require('electron')

// The tab strip gets fixed tab commands only: no destinations, files, modes
// or other native features. Main also checks each command's sender.
if (process.isMainFrame && location.protocol === 'file:') {
  const command = (name, id, options) => ipcRenderer.send('tabs:command', name, id, options)
  contextBridge.exposeInMainWorld('brinqTabs', {
    onState(callback) {
      const handler = (_event, state) => callback(state)
      ipcRenderer.on('tabs:state', handler)
      // Subscribe first so a push between the request and its reply is kept.
      ipcRenderer.invoke('tabs:state').then((state) => { if (state) callback(state) }).catch(() => {})
      return () => ipcRenderer.removeListener('tabs:state', handler)
    },
    select: (id, focus) => command('select', id, { focus: focus === true }),
    close: (id) => command('close', id),
    retry: (id) => command('retry', id),
    newTab: () => command('new'),
    home: (focus) => command('home', undefined, { focus: focus === true }),
    reload: () => command('reload'),
  })
}

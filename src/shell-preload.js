const { contextBridge, ipcRenderer } = require('electron')

// The tab strip gets fixed tab commands only: no destinations, files, modes
// or other native features. Main also checks each command's sender. The
// update commands take no arguments: main decides what restart or retry do.
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
    move: (id, position) => command('move', id, { position }),
    retry: (id) => command('retry', id),
    menu: (id, x, y, keyboard) => command('menu', id, { x, y, keyboard: keyboard === true }),
    newTab: () => command('new'),
    home: (focus) => command('home', undefined, { focus: focus === true }),
    reload: () => command('reload'),
    restartUpdate: () => command('restart-update'),
    retryUpdate: () => command('retry-update'),
    // F6: main asks the strip to take keyboard focus ('header'), or, for a
    // failed tab's panel, to move it between header and panel ('toggle').
    onFocusRequest(callback) {
      const handler = (_event, mode) => callback(mode === 'toggle' ? 'toggle' : 'header')
      ipcRenderer.on('tabs:focus', handler)
      return () => ipcRenderer.removeListener('tabs:focus', handler)
    },
  })
}

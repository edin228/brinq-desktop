const Store = require('electron-store')
const { app } = require('electron')
const { resolveBaseUrl } = require('./window-security')

const store = new Store({
  defaults: {
    mode: 'full',
    windowBounds: { width: 1200, height: 800 },
  },
})

module.exports = {
  getMode: () => store.get('mode'),
  setMode: (mode) => store.set('mode', mode),
  getWindowBounds: () => store.get('windowBounds'),
  setWindowBounds: (bounds) => store.set('windowBounds', bounds),
  getBaseUrl: () => resolveBaseUrl({ isPackaged: app.isPackaged }),
}

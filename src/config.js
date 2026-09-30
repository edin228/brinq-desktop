const Store = require('electron-store')
const { app } = require('electron')
const { resolveBaseUrl } = require('./window-security')

const store = new Store({
  defaults: {
    mode: 'full',
    theme: 'light',
    windowBounds: { width: 1200, height: 800 },
  },
})

// Corrupt or unknown stored values fall back to the web app's default.
const isTheme = (value) => value === 'light' || value === 'dark'

module.exports = {
  getMode: () => store.get('mode'),
  setMode: (mode) => store.set('mode', mode),
  getTheme: () => (isTheme(store.get('theme')) ? store.get('theme') : 'light'),
  setTheme: (theme) => { if (isTheme(theme)) store.set('theme', theme) },
  getWindowBounds: () => store.get('windowBounds'),
  setWindowBounds: (bounds) => store.set('windowBounds', bounds),
  getBaseUrl: () => resolveBaseUrl({ isPackaged: app.isPackaged }),
}

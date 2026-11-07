const Store = require('electron-store')
const { app } = require('electron')
const { resolveBaseUrl } = require('./window-security')
const { parseStartup, parseSession } = require('./startup-tabs')

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
  // Startup tabs. A corrupt value means Home only, or no saved session.
  getStartup: () => parseStartup(store.get('startup')),
  getLastSession: () => parseSession(store.get('lastSession')),
  // One store write, so a failure keeps the previous choice and session.
  saveStartup: (startup, { clearSession = false } = {}) =>
    store.set(clearSession ? { startup, lastSession: null } : { startup }),
  setLastSession: (session) => store.set('lastSession', session),
  getBaseUrl: () => resolveBaseUrl({ isPackaged: app.isPackaged }),
}

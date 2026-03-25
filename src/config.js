const Store = require('electron-store')

const store = new Store({
  defaults: {
    mode: 'email',
    windowBounds: { width: 1200, height: 800 },
  },
})

module.exports = {
  getMode: () => store.get('mode'),
  setMode: (mode) => store.set('mode', mode),
  getWindowBounds: () => store.get('windowBounds'),
  setWindowBounds: (bounds) => store.set('windowBounds', bounds),
  getBaseUrl: () =>
    process.env.NODE_ENV === 'development'
      ? 'http://localhost:3000'
      : 'https://brinq.io',
}

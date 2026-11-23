// Quits Brinq the way the tray's Quit does. Every window still closes through
// its unsaved-work guard, so a page with unsaved changes asks first and Stay
// keeps Brinq open.
function quitApp(app) {
  app.isQuitting = true
  app.quit()
}

// Quit Brinq in a Brinq page's account menu. Only a validated app page (a tab
// or a pop-out on the Brinq origin) can ask; anything else is ignored.
function installQuitApp({ ipcMain, app, security }) {
  ipcMain.on('quit-app', (event) => {
    if (security.validateSender(event)) quitApp(app)
  })
}

// Brinq quits only from its main window: while another Brinq window has
// tabs, a quit is refused before anything closes or is saved, and
// `onRefused` tells the person why. Install it before the other
// before-quit listeners (the updater's, startup tabs'), which skip a quit
// that is already refused.
function installQuitGuard({ app, blocked, onRefused = () => {} }) {
  app.on('before-quit', (event) => {
    if (event.defaultPrevented || !blocked()) return
    event.preventDefault()
    app.isQuitting = false
    onRefused()
  })
}

// The notice for a refused quit, on the main window.
const OTHER_WINDOWS_NOTICE = {
  type: 'info',
  buttons: ['OK'],
  defaultId: 0,
  noLink: true,
  title: 'Brinq has other windows open',
  message: 'Brinq has other windows open',
  detail: 'Close your other Brinq windows first, then quit again. Their tabs go back to this window when you close them.',
}

module.exports = { quitApp, installQuitApp, installQuitGuard, OTHER_WINDOWS_NOTICE }

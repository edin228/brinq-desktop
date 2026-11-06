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

module.exports = { quitApp, installQuitApp }

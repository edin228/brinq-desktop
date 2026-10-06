const fs = require('fs')

// Electron updater 6.8.3 starts installation inside quitAndInstall, before its
// own app.quit. Call it only from will-quit, after every window accepted closing.
function createUpdateStatus({ app, updater, onChange = () => {}, restoreWindow = () => {}, schedule = setImmediate }) {
  let state = app.isPackaged
    ? { status: 'idle' }
    : { status: 'unavailable', message: 'Updates are available in the installed Brinq app.' }
  let checking = null
  let restartPending = false
  let installing = false
  let blockInstallerQuit = false
  let startupChecked = false
  const getState = () => ({ ...state })
  const publish = (next) => { state = next; onChange(getState()) }
  const fail = () => {
    publish({ status: 'error', message: 'Could not update Brinq. Check your connection and try again.' })
    if (installing) {
      installing = false
      restartPending = false
      updater.autoInstallOnAppQuit = false
      // BaseUpdater keeps this latch set when an asynchronous spawn fails.
      // Clear it only after its error event so an explicit retry can install.
      if ('quitAndInstallCalled' in updater) updater.quitAndInstallCalled = false
      blockInstallerQuit = true
      app.isQuitting = false
      publish({ status: 'error', message: 'The update could not be installed. Brinq has reopened. Check for updates to try again.' })
      schedule(() => { restoreWindow(); blockInstallerQuit = false })
    }
  }
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true
  updater.on('checking-for-update', () => publish({ status: 'checking' }))
  updater.on('update-not-available', () => publish({ status: 'up-to-date' }))
  updater.on('update-available', (info) => publish({ status: 'downloading', version: info.version, percent: 0 }))
  updater.on('download-progress', (progress) => {
    if (state.status === 'downloading' && Number.isFinite(progress.percent)) {
      publish({ ...state, percent: Math.max(0, Math.min(100, progress.percent)) })
    }
  })
  updater.on('update-downloaded', (info) => {
    updater.autoInstallOnAppQuit = true
    publish({ status: 'ready', version: info.version, message: 'Restart to install the update. Brinq will close; save your work first.' })
  })
  updater.on('error', fail)

  function installAfterClosing(event) {
    event.preventDefault()
    restartPending = false
    installing = true
    try {
      // BaseUpdater (NSIS/Linux) exposes its downloaded installer. MacUpdater
      // delegates to Squirrel and has no installerPath. Check at the last
      // synchronous point: NSIS 6.8.3 can swallow openPath's resolved error after
      // a missing-file spawn and still quit. Do not enter that fallback.
      if ('installerPath' in updater) {
        const descriptor = fs.openSync(updater.installerPath, 'r')
        try {
          if (!fs.fstatSync(descriptor).isFile()) throw new Error('Installer is not a regular file')
        } finally { fs.closeSync(descriptor) }
      }
      updater.quitAndInstall()
    } catch { fail() }
  }

  // A page kept its unsaved work (the user chose Stay), which stops a quit.
  function cancelQuit() {
    app.isQuitting = false
    if (!restartPending) return
    restartPending = false
    app.removeListener('will-quit', installAfterClosing)
    publish({ ...state, message: 'Restart canceled. Save your work, then choose Restart to update.' })
    schedule(restoreWindow)
  }
  app.on('before-quit', (event) => {
    if (blockInstallerQuit) {
      event.preventDefault()
      app.isQuitting = false
    }
  })

  function check() {
    if (!app.isPackaged) return Promise.resolve({ ok: false, state: getState(), error: state.message })
    if (checking) return checking
    if (state.status === 'ready' || installing || restartPending) return Promise.resolve({ ok: true, state: getState() })
    publish({ status: 'checking' })
    // Start in a microtask so synchronous updater events cannot race assignment.
    checking = Promise.resolve().then(async () => {
      try {
        const result = await updater.checkForUpdates()
        if (!result) {
          publish({ status: 'unavailable', message: 'Updates are unavailable for this installation.' })
          return { ok: false, state: getState(), error: state.message }
        }
        if (result.downloadPromise) await result.downloadPromise
        return { ok: state.status !== 'error', state: getState() }
      } catch {
        fail()
        return { ok: false, state: getState(), error: state.message }
      } finally { checking = null }
    })
    return checking
  }

  function restart() {
    if (state.status !== 'ready' || restartPending || installing) {
      return { ok: false, state: getState(), error: 'Download an update before restarting.' }
    }
    restartPending = true
    app.once('will-quit', installAfterClosing)
    // Let IPC acknowledge the request before the originating window closes.
    schedule(() => { if (restartPending) app.quit() })
    return { ok: true, state: getState() }
  }

  return {
    getState, check, restart,
    // Tab pages are not windows, so the main window reports their veto here.
    cancelQuit,
    checkOnLaunch() {
      if (startupChecked) return
      startupChecked = true
      return check()
    },
  }
}

module.exports = { createUpdateStatus }

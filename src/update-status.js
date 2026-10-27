const fs = require('fs')

const HOUR = 60 * 60 * 1000
const MESSAGES = {
  ready: 'Restart to update. Brinq closes and reopens once updated.',
  restarting: 'Updating… Brinq will reopen.',
  postponed: 'Update postponed. Some tabs may have closed.',
  stalled: "Update postponed. A window didn't close. Try again when you're ready.",
  already: 'Brinq is already restarting to update.',
  notReady: 'Download an update before restarting.',
  check: "Brinq couldn't check for updates. It will try again. You can keep working.",
  download: "The update couldn't download. Check your connection and try again.",
  limited: "Brinq couldn't check for updates right now. It will try again later.",
  installFailed: (version) => `The update couldn't start. Brinq is still on version ${version}. Try again when you're ready.`,
  installBlocked: (version) => `The update couldn't be installed. Brinq is still on version ${version}. Reinstall Brinq to update.`,
}

// GitHub answers too many update checks with 429, or 403 naming the rate
// limit. electron-updater can wrap the HTTP error in a generic one, and drops
// Retry-After either way, so back off an hour.
function rateLimited(error) {
  const status = error?.statusCode
  const text = String(error?.message || '')
  return status === 429 || /\b429\b|rate limit/i.test(text) || (status === 403 && /limit/i.test(text))
}

// Electron updater 6.8.3 starts installation inside quitAndInstall, before its
// own app.quit. Call it only from will-quit, after every window accepted closing.
//
// States keep the shapes the web Settings page reads (status, version,
// percent, message). Extra fields: `phase: 'restarting'` while a restart
// closes windows, and on errors `failure` (check, download or install) and
// `manual` (a person asked, so the error may be shown in place).
function createUpdateStatus({
  app, updater, onChange = () => {}, restoreWindow = () => {}, schedule = setImmediate,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {},
  watchdogMs = 60 * 1000, manualCooldownMs = 5 * 1000,
}) {
  let state = app.isPackaged
    ? { status: 'idle' }
    : { status: 'unavailable', message: 'Updates are available in the installed Brinq app.' }
  let checking = null
  // The check in progress: who asked, and an error its events reported.
  let attempt = null
  let lastCheckEnded = 0
  let limitedUntil = 0
  let restartPending = false
  let installing = false
  let blockInstallerQuit = false
  let startupChecked = false
  let watchdog = null
  // The downloaded version, and how often installing each version failed.
  let candidate = null
  const installFailures = new Map()
  const getState = () => ({ ...state })
  const publish = (next) => { state = next; onChange(getState()) }
  const currentVersion = () => (typeof app.getVersion === 'function' ? app.getVersion() : 'unknown')
  // After an install failure, background checks keep its notice in place
  // and never offer or arm the version that failed.
  const quiet = () => attempt && !attempt.manual && state.failure === 'install'

  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true
  updater.on('checking-for-update', () => { if (!quiet()) publish({ status: 'checking' }) })
  updater.on('update-not-available', () => { if (!quiet()) publish({ status: 'up-to-date' }) })
  updater.on('update-available', (info) => {
    if (!quiet()) publish({ status: 'downloading', version: info.version, percent: 0 })
  })
  updater.on('download-progress', (progress) => {
    if (state.status === 'downloading' && Number.isFinite(progress.percent)) {
      publish({ ...state, percent: Math.max(0, Math.min(100, progress.percent)) })
    }
  })
  updater.on('update-downloaded', (info) => {
    candidate = info.version
    const failures = installFailures.get(info.version) || 0
    // A cached re-download of a version that failed to install: only a
    // person's retry may offer it again, and never after a second failure.
    if (failures >= 2 || (failures && !attempt?.manual)) {
      updater.autoInstallOnAppQuit = false
      log('downloaded-held', { version: info.version, failures })
      if (failures >= 2) publish({ status: 'error', failure: 'install', manual: true, message: MESSAGES.installBlocked(currentVersion()) })
      return
    }
    updater.autoInstallOnAppQuit = true
    log('downloaded', { version: info.version })
    publish({ status: 'ready', version: info.version, message: MESSAGES.ready })
  })
  updater.on('error', (error) => {
    if (installing) return failInstall(error)
    // The check reports its own failure once, when it settles.
    if (attempt) { attempt.error ||= error; return }
    // A downloaded installer is still valid; a stray error does not undo it.
    log('error-ignored', { status: state.status, category: category(error) })
  })

  function category(error) {
    if (rateLimited(error)) return 'rate-limit'
    return typeof error?.code === 'string' ? error.code : 'unknown'
  }

  function clearWatchdog() {
    if (watchdog) clearTimer(watchdog)
    watchdog = null
  }

  // Throws unless the downloaded installer is a readable regular file.
  function checkInstaller() {
    // BaseUpdater (NSIS/Linux) exposes its downloaded installer. MacUpdater
    // delegates to Squirrel and has no installerPath. NSIS 6.8.3 can swallow
    // openPath's resolved error after a missing-file spawn and still quit, so
    // never enter that fallback.
    if (!('installerPath' in updater)) return
    const descriptor = fs.openSync(updater.installerPath, 'r')
    try {
      if (!fs.fstatSync(descriptor).isFile()) throw new Error('Installer is not a regular file')
    } finally { fs.closeSync(descriptor) }
  }

  // Counts a failed install of the downloaded version and stops offering it.
  function installFailed(error) {
    const failures = (installFailures.get(candidate) || 0) + 1
    installFailures.set(candidate, failures)
    updater.autoInstallOnAppQuit = false
    log('install-failed', { version: candidate, failures, category: category(error) })
    const message = failures >= 2 ? MESSAGES.installBlocked(currentVersion()) : MESSAGES.installFailed(currentVersion())
    publish({ status: 'error', failure: 'install', manual: true, message })
  }

  function failInstall(error) {
    installing = false
    restartPending = false
    clearWatchdog()
    // BaseUpdater keeps this latch set when an asynchronous spawn fails.
    // Clear it only after its error event so an explicit retry can install.
    if ('quitAndInstallCalled' in updater) updater.quitAndInstallCalled = false
    blockInstallerQuit = true
    app.isQuitting = false
    installFailed(error)
    schedule(() => { restoreWindow(); blockInstallerQuit = false })
  }

  function installAfterClosing(event) {
    event.preventDefault()
    clearWatchdog()
    restartPending = false
    installing = true
    log('install', { version: candidate })
    try {
      // Check at the last synchronous point too: the file can go while
      // windows close.
      checkInstaller()
      // Silent, then reopen Brinq. The assisted installer starts the app
      // only when silent; Windows still asks for permission (UAC).
      updater.quitAndInstall(true, true)
    } catch (error) { failInstall(error) }
  }

  // Back to ready: the restart stopped before any installer ran.
  function postpone(message) {
    restartPending = false
    clearWatchdog()
    app.removeListener('will-quit', installAfterClosing)
    log('restart-postponed', { message })
    publish({ status: 'ready', version: state.version, message })
    schedule(restoreWindow)
  }

  // A page kept its unsaved work (the user chose Stay), which stops a quit.
  // Several windows can report the same stop.
  function cancelQuit() {
    app.isQuitting = false
    if (restartPending) postpone(MESSAGES.postponed)
  }

  // A page that never answers its unsaved-work check would hold the restart
  // forever; give the user their windows back instead.
  function restartStalled() {
    watchdog = null
    if (!restartPending) return
    app.isQuitting = false
    postpone(MESSAGES.stalled)
  }

  app.on('before-quit', (event) => {
    if (blockInstallerQuit) {
      event.preventDefault()
      app.isQuitting = false
    }
  })

  // `manual` is a person asking (tray, Settings, the header's Try again).
  // Every caller shares one check; a check holds until its download is done.
  function check({ manual = false } = {}) {
    if (!app.isPackaged) return Promise.resolve({ ok: false, state: getState(), error: state.message })
    if (checking) {
      if (manual) attempt.manual = true
      return checking
    }
    if (state.status === 'ready' || installing || restartPending) return Promise.resolve({ ok: true, state: getState() })
    if (app.isQuitting) return Promise.resolve({ ok: false, state: getState() })
    if (now() < limitedUntil) {
      return Promise.resolve({ ok: false, state: getState(), error: state.message, retryAt: limitedUntil })
    }
    if (manual && now() - lastCheckEnded < manualCooldownMs) {
      return Promise.resolve({ ok: state.status !== 'error', state: getState() })
    }
    attempt = { manual, error: null }
    const current = attempt
    log('check', { manual })
    if (!quiet()) publish({ status: 'checking' })
    // Start in a microtask so synchronous updater events cannot race assignment.
    checking = Promise.resolve().then(async () => {
      try {
        const result = await updater.checkForUpdates()
        if (!result) {
          publish({ status: 'unavailable', message: 'Updates are unavailable for this installation.' })
          return { ok: false, state: getState(), error: state.message }
        }
        if (result.downloadPromise) await result.downloadPromise
        if (current.error) throw current.error
        return { ok: true, state: getState() }
      } catch (error) {
        return failCheck(current.error || error, current)
      } finally {
        checking = null
        attempt = null
        lastCheckEnded = now()
      }
    })
    return checking
  }

  function failCheck(error, current) {
    const failure = state.status === 'downloading' ? 'download' : 'check'
    const limited = rateLimited(error)
    if (limited) limitedUntil = now() + HOUR
    log('check-failed', { failure, manual: current.manual, category: category(error), retryAt: limited ? limitedUntil : null })
    // Keep an install failure's notice; a background check failing too
    // changes nothing the user can act on.
    if (!(state.failure === 'install' && !current.manual)) {
      const message = limited ? MESSAGES.limited : MESSAGES[failure]
      publish({ status: 'error', failure, manual: current.manual, message })
    }
    return { ok: false, state: getState(), error: state.message, ...(limited && { retryAt: limitedUntil }) }
  }

  function restart() {
    if (restartPending || installing) return { ok: false, state: getState(), error: MESSAGES.already }
    if (state.status !== 'ready') return { ok: false, state: getState(), error: MESSAGES.notReady }
    // Before any window closes: a missing installer must not cost the
    // user their tabs.
    try { checkInstaller() } catch (error) {
      installFailed(error)
      return { ok: false, state: getState(), error: state.message }
    }
    restartPending = true
    log('restart', { version: state.version })
    publish({ ...state, phase: 'restarting', message: MESSAGES.restarting })
    app.once('will-quit', installAfterClosing)
    watchdog = setTimer(restartStalled, watchdogMs)
    watchdog?.unref?.()
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

module.exports = { createUpdateStatus, MESSAGES }

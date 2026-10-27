const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createUpdateStatus } = require('../src/update-status')
const { guardWindowUnload } = require('../src/unload-guard')

// A page window guarded the way main.js guards every window. Its page holds
// unsaved work when `dirty`; the user answers the prompt with Leave or Stay.
function guardedWindow(webContents, owner, leave) {
  const prompts = []
  const dialog = { showMessageBoxSync: (_window, options) => { prompts.push(options); return leave ? 0 : 1 } }
  const window = { webContents, isDestroyed: () => false, isMinimized: () => false, show() {} }
  guardWindowUnload({ window, dialog, onStay: () => owner()?.cancelQuit() })
  return { window, prompts }
}

// Emits the page's unload veto; true when a listener let the page unload.
function unloadVeto(webContents) {
  const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
  webContents.emit('will-prevent-unload', event)
  return event.defaultPrevented
}

function fixture({ packaged = true, dirty = false, leave = false, installFailure = false, asyncInstallFailure = false } = {}) {
  const app = new EventEmitter()
  app.isPackaged = packaged
  const updater = new EventEmitter()
  const scheduled = []
  const changes = []
  let restored = 0
  let installs = 0
  let quits = 0
  let exited = false
  let windows = []
  const installArgs = []
  // A fake clock and timers: `advance(ms)` runs timers that come due.
  const clock = { now: 1_000_000 }
  const timers = new Set()
  const setTimer = (fn, ms) => { const timer = { fn, at: clock.now + ms }; timers.add(timer); return timer }
  const clearTimer = (timer) => timers.delete(timer)
  const advance = (ms) => {
    clock.now += ms
    for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
      if (timer.at <= clock.now && timers.delete(timer)) timer.fn()
    }
  }
  updater.quitAndInstall = (...args) => {
    installArgs.push(args)
    installs++
    assert.equal(windows.length, 0, 'installation must wait until all windows closed')
    if (asyncInstallFailure) {
      updater.quitAndInstallCalled = true
      scheduled.push(() => updater.emit('error', new Error('spawn failed')))
      scheduled.push(() => app.quit())
    } else if (installFailure) updater.emit('error', new Error('private installer path'))
    else scheduled.push(() => app.quit()) // BaseUpdater 6.8.3 schedules its quit after install.
  }
  app.quit = () => {
    quits++
    const before = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    app.emit('before-quit', before)
    if (before.defaultPrevented) return
    app.isQuitting = true
    if (dirty && windows.length && !unloadVeto(windows[0].webContents)) return
    windows = []
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    app.emit('will-quit', event)
    if (!event.defaultPrevented) { exited = true; app.emit('quit', {}, 0) }
  }
  app.getVersion = () => '1.3.6'
  const owner = createUpdateStatus({
    app, updater, schedule: (fn) => scheduled.push(fn), onChange: (state) => changes.push(state), restoreWindow: () => { restored++ },
    now: () => clock.now, setTimer, clearTimer,
  })
  const { window, prompts } = guardedWindow(new EventEmitter(), () => owner, leave)
  windows.push(window)
  return { app, updater, owner, changes, window, prompts, installArgs, timers, advance, clock, flush() { while (scheduled.length) scheduled.shift()() }, get restored() { return restored }, get installs() { return installs }, get quits() { return quits }, get exited() { return exited } }
}

test('unpackaged checks are unavailable and launch checks happen once', async () => {
  const f = fixture({ packaged: false })
  f.updater.checkForUpdates = () => { throw Error('Must not contact provider') }
  assert.equal((await f.owner.check()).state.status, 'unavailable')
  await f.owner.checkOnLaunch()
  assert.equal(f.owner.checkOnLaunch(), undefined)
  assert.equal(f.owner.restart().ok, false)
})

test('check serialization, downloading progress, readiness and up-to-date match updater events', async () => {
  const f = fixture()
  let checks = 0
  let finishDownload
  f.updater.checkForUpdates = async () => {
    checks++
    f.updater.emit('checking-for-update')
    f.updater.emit('update-available', { version: '2.0.0' })
    return { downloadPromise: new Promise((resolve) => { finishDownload = resolve }) }
  }
  const first = f.owner.check()
  assert.equal(f.owner.check(), first)
  await Promise.resolve()
  assert.equal(checks, 1)
  assert.equal(f.owner.getState().status, 'downloading')
  f.updater.emit('download-progress', { percent: 42.5 })
  assert.equal(f.owner.getState().percent, 42.5)
  assert.equal(f.owner.restart().ok, false)
  f.updater.emit('update-downloaded', { version: '2.0.0' })
  finishDownload()
  assert.equal((await first).state.status, 'ready')
  assert.equal((await f.owner.check()).state.status, 'ready')
  assert.equal(checks, 1)
  assert.equal(f.updater.autoDownload, true)
  assert.equal(f.updater.autoInstallOnAppQuit, true)
  const fresh = fixture()
  fresh.updater.checkForUpdates = async () => { fresh.updater.emit('update-not-available'); return {} }
  assert.equal((await fresh.owner.check()).state.status, 'up-to-date')
})

test('failed check and download expose safe retryable errors and a later check can succeed', async () => {
  const f = fixture()
  f.updater.checkForUpdates = () => Promise.reject(Error('signed URL or private error'))
  assert.equal((await f.owner.check()).ok, false)
  assert.equal(f.owner.getState().status, 'error')
  assert.ok(!f.owner.getState().message.includes('private'))
  f.updater.checkForUpdates = async () => ({ downloadPromise: Promise.reject(Error('download failed')) })
  assert.equal((await f.owner.check()).ok, false)
  f.updater.checkForUpdates = async () => { f.updater.emit('update-not-available'); return {} }
  assert.equal((await f.owner.check()).state.status, 'up-to-date')
})

test('dirty window veto prevents installer and relaunch and restores normal tray close behavior', () => {
  const f = fixture({ dirty: true })
  f.updater.emit('update-downloaded', { version: '2.0.0' })
  assert.equal(f.owner.restart().ok, true)
  assert.equal(f.owner.restart().ok, false)
  assert.equal(f.installs, 0)
  f.flush()
  assert.equal(f.installs, 0)
  assert.equal(f.exited, false)
  assert.equal(f.app.isQuitting, false)
  assert.equal(f.restored, 1)
  assert.equal(f.app.listenerCount('will-quit'), 0)
  assert.match(f.owner.getState().message, /Update postponed/)
  assert.equal(f.prompts.length, 1)
})

test('choosing Leave on a dirty window lets the restart close it and install', () => {
  const f = fixture({ dirty: true, leave: true })
  f.updater.emit('update-downloaded', { version: '2.0.0' })
  assert.equal(f.owner.restart().ok, true)
  f.flush()
  assert.equal(f.prompts.length, 1)
  assert.equal(f.installs, 1)
  assert.equal(f.exited, true)
  assert.equal(f.restored, 0)
})

test('accepted restart installs once after windows close and lets updater complete quit', () => {
  const f = fixture()
  f.updater.emit('update-downloaded', { version: '2.0.0' })
  f.owner.restart()
  assert.equal(f.installs, 0)
  f.flush()
  assert.equal(f.installs, 1)
  assert.equal(f.quits, 2)
  assert.equal(f.exited, true)
  assert.equal(f.restored, 0)
})

test('installer failure after windows close prevents exit and recreates the app', () => {
  const f = fixture({ installFailure: true })
  f.updater.emit('update-downloaded', { version: '2.0.0' })
  f.owner.restart()
  f.flush()
  assert.equal(f.installs, 1)
  assert.equal(f.exited, false)
  assert.equal(f.app.isQuitting, false)
  assert.equal(f.restored, 1)
  assert.equal(f.owner.getState().status, 'error')
  assert.equal(f.updater.autoInstallOnAppQuit, false)
  assert.equal(f.owner.restart().ok, false)
})

test('ordinary successful quit retains updater automatic-install setting', () => {
  const f = fixture()
  f.updater.emit('update-downloaded', { version: '2.0.0' })
  f.app.quit()
  assert.equal(f.exited, true)
  assert.equal(f.updater.autoInstallOnAppQuit, true)
  assert.equal(f.installs, 0, 'ordinary install remains the installed updater quit handler responsibility')
})


test('an asynchronous installer error cancels the updater scheduled quit and allows an explicit retry', () => {
  const f = fixture({ asyncInstallFailure: true })
  f.updater.emit('update-downloaded', { version: '2.0.0' })
  f.owner.restart()
  f.flush()
  assert.equal(f.installs, 1)
  assert.equal(f.exited, false)
  assert.equal(f.restored, 1)
  assert.equal(f.app.isQuitting, false)
  assert.equal(f.updater.quitAndInstallCalled, false)
  assert.equal(f.updater.autoInstallOnAppQuit, false)
})


test('installed updater contract: missing NSIS installer recovers before its silent openPath failure', async (t) => {
  const fs = require('node:fs')
  const path = require('node:path')
  const os = require('node:os')
  const Module = require('node:module')
  const { NsisUpdater } = require('electron-updater/out/NsisUpdater')
  const { MacUpdater } = require('electron-updater/out/MacUpdater')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'brinq-installer-contract-'))
  const installer = path.join(directory, 'installer.exe')
  const missing = path.join(directory, 'missing.exe')
  fs.writeFileSync(installer, 'fixture; never executed')
  let electron
  const originalLoad = Module._load
  Module._load = function(name, ...args) {
    return name === 'electron' ? electron : originalLoad.call(this, name, ...args)
  }
  t.after(() => { Module._load = originalLoad; fs.rmSync(directory, { recursive: true, force: true }) })
  const settle = async () => { for (let turn = 0; turn < 4; turn++) await new Promise(setImmediate) }

  function installedFixture({ file = missing, dirty = false, mac = false, managed = true, spawnErrors = [], adminRights = false } = {}) {
    const app = new EventEmitter()
    app.isPackaged = true
    const frame = new EventEmitter()
    const calls = []
    let quitHandler = null
    let windowsOpen = true
    let exited = false
    let restored = 0
    let spawns = 0
    let opens = 0
    let installs = 0
    let errors = 0
    electron = {
      autoUpdater: new EventEmitter(),
      shell: { openPath: async () => { opens++; return 'The system cannot find the file specified.' } },
    }
    const event = () => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true } })
    app.quit = () => {
      const before = event()
      app.emit('before-quit', before)
      if (before.defaultPrevented) return
      app.isQuitting = true
      if (windowsOpen && dirty && !unloadVeto(frame)) return
      windowsOpen = false
      const quitting = event()
      app.emit('will-quit', quitting)
      if (quitting.defaultPrevented) return
      exited = true
      // Electron's quit event, where BaseUpdater installs on an ordinary quit.
      quitHandler?.(0)
    }
    electron.autoUpdater.quitAndInstall = () => {
      assert.equal(windowsOpen, false)
      installs++
      setImmediate(app.quit)
    }
    const adapter = { version: '1.2.5', quit: app.quit, onQuit: (handler) => { quitHandler = handler } }
    const updater = new (mac ? MacUpdater : NsisUpdater)(null, adapter)
    updater.logger = null
    updater.on('error', () => { errors++ })
    if (mac) updater.squirrelDownloadedUpdate = true
    else updater.downloadedUpdateHelper = { file, downloadedFileInfo: { isAdminRightsRequired: adminRights } }
    // Stub only OS execution. Installed BaseUpdater.quitAndInstall and
    // NsisUpdater.doInstall, including the ENOENT and elevate fallbacks, remain real.
    updater.spawnLog = async (command, args) => {
      spawns++
      calls.push([path.basename(command), args])
      if (file === missing) throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' })
      const code = spawnErrors.shift()
      if (code) throw Object.assign(new Error('spawn fixture'), { code })
      assert.equal(windowsOpen, false)
      installs++
      return true
    }
    const owner = managed ? createUpdateStatus({ app, updater, restoreWindow: () => { restored++; windowsOpen = true } }) : null
    if (owner) {
      guardedWindow(frame, () => owner, false)
      updater.emit('update-downloaded', { version: '2.0.0' })
    }
    return { app, updater, owner, calls, exitWith: (code) => quitHandler(code), snapshot: () => ({ exited, restored, spawns, opens, installs, errors }) }
  }

  await t.test('reproduces the installed ENOENT/openPath contract without Brinq protection', async () => {
    const f = installedFixture({ managed: false })
    f.updater.quitAndInstall()
    await settle()
    assert.deepEqual(f.snapshot(), { exited: true, restored: 0, spawns: 1, opens: 1, installs: 0, errors: 0 })
  })
  for (const [label, file] of [['missing', missing], ['directory', directory], ['absent metadata', null]]) {
    await t.test(`${label} installer is refused before any window closes`, async () => {
      const f = installedFixture({ file })
      assert.equal(f.owner.restart().ok, false)
      await settle()
      assert.deepEqual(f.snapshot(), { exited: false, restored: 0, spawns: 0, opens: 0, installs: 0, errors: 0 })
      assert.equal(f.owner.getState().status, 'error')
      assert.equal(f.owner.getState().failure, 'install')
      assert.equal(f.updater.autoInstallOnAppQuit, false)
      assert.ok(!f.app.isQuitting)
    })
  }
  await t.test('checks again after restart is requested, immediately before installer invocation', async () => {
    const removed = path.join(directory, 'removed.exe')
    fs.writeFileSync(removed, 'fixture')
    const f = installedFixture({ file: removed })
    f.owner.restart()
    fs.unlinkSync(removed)
    await settle()
    assert.equal(f.snapshot().restored, 1)
    assert.equal(f.snapshot().spawns, 0)
    assert.equal(f.snapshot().exited, false)
  })
  await t.test('a readable regular installer preserves the installed success path', async () => {
    const f = installedFixture({ file: installer })
    f.owner.restart()
    await settle()
    assert.deepEqual(f.snapshot(), { exited: true, restored: 0, spawns: 1, opens: 0, installs: 1, errors: 0 })
  })
  await t.test('dirty window still vetoes before any installed updater invocation', async () => {
    const f = installedFixture({ file: installer, dirty: true })
    f.owner.restart()
    await settle()
    assert.equal(f.snapshot().spawns, 0)
    assert.equal(f.snapshot().exited, false)
    assert.equal(f.owner.getState().status, 'ready')
  })
  await t.test('installed MacUpdater still delegates to native Squirrel without an installer path', async () => {
    const f = installedFixture({ mac: true })
    assert.equal('installerPath' in f.updater, false)
    f.owner.restart()
    await settle()
    assert.equal(f.snapshot().installs, 1)
    assert.equal(f.snapshot().exited, true)
    assert.equal(f.snapshot().restored, 0)
  })

  // The assisted installer reopens Brinq by itself only when silent:
  // --force-run is ignored without /S (installSection.nsh in app-builder-lib).
  await t.test('Restart to update installs silently and reopens Brinq: --updated /S --force-run', async () => {
    const f = installedFixture({ file: installer })
    f.owner.restart()
    await settle()
    assert.deepEqual(f.calls, [['installer.exe', ['--updated', '/S', '--force-run']]])
  })
  await t.test('an ordinary quit installs without installer pages and without relaunching', async () => {
    const f = installedFixture({ file: installer, managed: false })
    updaterArmed(f.updater)
    f.exitWith(1)
    assert.deepEqual(f.calls, [], 'a failed exit never installs')
    f.app.quit()
    await settle()
    assert.deepEqual(f.calls, [['installer.exe', ['--updated', '/S']]])
    assert.deepEqual(f.snapshot(), { exited: true, restored: 0, spawns: 1, opens: 0, installs: 1, errors: 0 })
  })

  // elevate.exe lives in Electron's resources directory, which Node lacks.
  const resourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  process.resourcesPath = directory
  t.after(() => {
    if (resourcesPath) Object.defineProperty(process, 'resourcesPath', resourcesPath)
    else delete process.resourcesPath
  })
  for (const code of ['UNKNOWN', 'EACCES']) {
    await t.test(`an ${code} installer spawn retries through elevate.exe with no error and quits`, async () => {
      const f = installedFixture({ file: installer, spawnErrors: [code] })
      f.owner.restart()
      await settle()
      assert.deepEqual(f.calls.map(([command]) => command), ['installer.exe', 'elevate.exe'])
      assert.deepEqual(f.calls[1][1], [installer, '--updated', '/S', '--force-run'])
      assert.deepEqual(f.snapshot(), { exited: true, restored: 0, spawns: 2, opens: 0, installs: 1, errors: 0 })
    })
  }
  await t.test('an installer that requires admin rights starts through elevate.exe', async () => {
    const f = installedFixture({ file: installer, adminRights: true })
    f.owner.restart()
    await settle()
    assert.deepEqual(f.calls.map(([command]) => command), ['elevate.exe'])
    assert.equal(f.snapshot().exited, true)
  })
  await t.test('elevate.exe failing to start recovers like any asynchronous installer error', async () => {
    const f = installedFixture({ file: installer, spawnErrors: ['EACCES', 'ENOENT'] })
    f.owner.restart()
    await settle()
    assert.deepEqual(f.snapshot(), { exited: false, restored: 1, spawns: 2, opens: 0, installs: 0, errors: 1 })
    assert.equal(f.owner.getState().status, 'error')
    assert.equal(f.updater.autoInstallOnAppQuit, false)
  })
})

// Arms BaseUpdater's own install-on-quit handler, as a finished download does.
function updaterArmed(updater) {
  updater.autoInstallOnAppQuit = true
  updater.addQuitHandler()
}

const ready = (f, version = '2.0.0') => f.updater.emit('update-downloaded', { version })
// A check that finds the same version already downloaded, as
// electron-updater's cache reports it.
const cachedCheck = (f, version = '2.0.0') => {
  f.updater.checkForUpdates = async () => {
    f.updater.emit('checking-for-update')
    f.updater.emit('update-available', { version })
    f.updater.emit('update-downloaded', { version })
    return { downloadPromise: Promise.resolve() }
  }
}

test('after an install failure, background checks never re-arm or offer that version', async () => {
  const f = fixture({ installFailure: true })
  ready(f)
  f.owner.restart()
  f.flush()
  assert.equal(f.owner.getState().failure, 'install')
  assert.match(f.owner.getState().message, /still on version 1\.3\.6\. Try again/)
  cachedCheck(f)
  const changes = f.changes.length
  assert.equal((await f.owner.check()).ok, true)
  assert.equal(f.owner.getState().failure, 'install', 'the install notice stays')
  assert.ok(f.changes.slice(changes).every((state) => state.failure === 'install'), 'a background check does not flicker the state')
  assert.equal(f.updater.autoInstallOnAppQuit, false)
  // A person's Try again offers it once more and arms install-on-quit.
  f.clock.now += 10_000
  await f.owner.check({ manual: true })
  assert.equal(f.owner.getState().status, 'ready')
  assert.equal(f.updater.autoInstallOnAppQuit, true)
  // A second failure of the same version stops offering it, even to a person.
  f.owner.restart()
  f.flush()
  assert.match(f.owner.getState().message, /Reinstall Brinq/)
  f.clock.now += 10_000
  await f.owner.check({ manual: true })
  assert.equal(f.owner.getState().status, 'error')
  assert.match(f.owner.getState().message, /Reinstall Brinq/)
  assert.equal(f.updater.autoInstallOnAppQuit, false)
  // A newer version is offered as usual.
  cachedCheck(f, '2.0.1')
  f.clock.now += 10_000
  await f.owner.check()
  assert.equal(f.owner.getState().status, 'ready')
  assert.equal(f.owner.getState().version, '2.0.1')
  assert.equal(f.updater.autoInstallOnAppQuit, true)
})

test('an updater error while an update is ready keeps it ready', () => {
  const f = fixture()
  ready(f)
  f.updater.emit('error', new Error('late provider error'))
  assert.equal(f.owner.getState().status, 'ready')
  assert.equal(f.owner.restart().ok, true)
})

test('a failed check publishes one error, labelled by phase and by who asked', async () => {
  const f = fixture()
  f.updater.checkForUpdates = async () => {
    f.updater.emit('error', new Error('offline'))
    throw new Error('offline')
  }
  assert.equal((await f.owner.check()).ok, false)
  assert.deepEqual(f.changes.map((state) => state.status), ['checking', 'error'])
  assert.deepEqual(f.owner.getState(), { status: 'error', failure: 'check', manual: false, message: "Brinq couldn't check for updates. It will try again. You can keep working." })
  // A download that fails after its error event reports once, as a download.
  f.updater.checkForUpdates = async () => {
    f.updater.emit('update-available', { version: '2.0.0' })
    return { downloadPromise: new Promise((_resolve, reject) => setImmediate(() => { f.updater.emit('error', new Error('reset')); reject(new Error('reset')) })) }
  }
  f.clock.now += 10_000
  const before = f.changes.length
  await f.owner.check({ manual: true })
  assert.deepEqual(f.changes.slice(before).map((state) => state.status), ['checking', 'downloading', 'error'])
  assert.equal(f.owner.getState().failure, 'download')
  assert.equal(f.owner.getState().manual, true)
})

test('GitHub rate limits hold every check for an hour, with or without the status code', async () => {
  for (const error of [Object.assign(new Error('HTTP error: 429'), { statusCode: 429 }), new Error('Unable to find latest version on GitHub: API rate limit exceeded')]) {
    const f = fixture()
    let calls = 0
    f.updater.checkForUpdates = async () => { calls++; throw error }
    const result = await f.owner.check()
    assert.equal(result.retryAt, f.clock.now + 60 * 60 * 1000)
    assert.match(f.owner.getState().message, /right now/)
    f.clock.now += 30 * 60 * 1000
    assert.equal((await f.owner.check({ manual: true })).retryAt, result.retryAt)
    assert.equal(calls, 1, 'no request while limited, even when a person asks')
    f.clock.now += 31 * 60 * 1000
    await f.owner.check()
    assert.equal(calls, 2)
  }
})

test('a person asking again within seconds reuses the last answer; checks skip while quitting', async () => {
  const f = fixture()
  let calls = 0
  f.updater.checkForUpdates = async () => { calls++; f.updater.emit('update-not-available'); return {} }
  await f.owner.check({ manual: true })
  await f.owner.check({ manual: true })
  assert.equal(calls, 1)
  await f.owner.check()
  assert.equal(calls, 2, 'the schedule is not held back by the cooldown')
  f.app.isQuitting = true
  assert.equal((await f.owner.check()).ok, false)
  assert.equal(calls, 2)
})

test('restart publishes the restarting phase at once and refuses a second request plainly', () => {
  const f = fixture({ dirty: true })
  ready(f)
  assert.equal(f.owner.restart().ok, true)
  assert.deepEqual(f.owner.getState(), { status: 'ready', version: '2.0.0', phase: 'restarting', message: 'Updating… Brinq will reopen.' })
  assert.deepEqual(f.changes.at(-1), f.owner.getState())
  const again = f.owner.restart()
  assert.equal(again.ok, false)
  assert.equal(again.error, 'Brinq is already restarting to update.')
  assert.equal(fixture().owner.restart().error, 'Download an update before restarting.')
})

test('Stay returns to ready, keeps install-on-quit armed, and repeated stops are harmless', () => {
  const f = fixture({ dirty: true })
  ready(f)
  f.owner.restart()
  f.flush()
  f.owner.cancelQuit()
  f.flush()
  assert.deepEqual(f.owner.getState(), { status: 'ready', version: '2.0.0', message: 'Update postponed. Some tabs may have closed.' })
  assert.equal(f.restored, 1, 'one restore for one stopped restart')
  assert.equal(f.updater.autoInstallOnAppQuit, true)
  assert.equal(f.timers.size, 0, 'no watchdog left behind')
  assert.equal(f.installs, 0)
})

test('a restart that stalls closing windows is postponed after a minute', () => {
  const f = fixture()
  ready(f)
  // A page that never answers its unsaved-work check: windows never close.
  f.app.quit = () => { f.app.isQuitting = true }
  f.owner.restart()
  f.flush()
  f.advance(59_000)
  assert.equal(f.owner.getState().phase, 'restarting')
  f.advance(1_000)
  assert.equal(f.owner.getState().status, 'ready')
  assert.equal(f.owner.getState().phase, undefined)
  assert.match(f.owner.getState().message, /A window didn't close/)
  assert.equal(f.app.isQuitting, false)
  assert.equal(f.app.listenerCount('will-quit'), 0)
  f.flush()
  assert.equal(f.restored, 1)
  // A late close no longer installs: the restart was given up.
  f.app.emit('will-quit', { preventDefault() {} })
  assert.equal(f.installs, 0)
})

test('an accepted restart installs silently and asks the installer to reopen Brinq', () => {
  const f = fixture()
  ready(f)
  f.owner.restart()
  f.flush()
  assert.deepEqual(f.installArgs, [[true, true]])
  assert.equal(f.timers.size, 0, 'the watchdog ends when installation starts')
})

// The web Settings page renders these shapes (brinq-mono
// frontend/types/desktop.ts DesktopUpdateState); unknown statuses show
// `message`. Every published state must keep to them.
test('every published state keeps the shape the Settings page reads', async () => {
  const shapes = {
    idle: [], checking: [], 'up-to-date': [],
    unavailable: ['message'], error: ['message'],
    downloading: ['version', 'percent'], ready: ['version', 'message'],
  }
  const seen = []
  const record = (f) => seen.push(...f.changes, f.owner.getState())
  const a = fixture({ dirty: true, installFailure: true })
  a.updater.checkForUpdates = async () => {
    a.updater.emit('checking-for-update')
    a.updater.emit('update-available', { version: '2.0.0' })
    a.updater.emit('download-progress', { percent: 50 })
    a.updater.emit('update-downloaded', { version: '2.0.0' })
    return { downloadPromise: Promise.resolve() }
  }
  await a.owner.check()
  a.owner.restart()
  a.flush()
  record(a)
  const b = fixture({ installFailure: true })
  ready(b)
  b.owner.restart()
  b.flush()
  b.updater.checkForUpdates = async () => { throw new Error('offline') }
  b.clock.now += 10_000
  await b.owner.check({ manual: true })
  record(b)
  record(fixture({ packaged: false }))
  for (const state of seen) {
    assert.ok(state.status in shapes, `unknown status ${state.status}`)
    for (const field of shapes[state.status]) assert.notEqual(state[field], undefined, `${state.status} lacks ${field}`)
    if (state.message !== undefined) assert.equal(typeof state.message, 'string')
  }
  assert.ok(seen.some((state) => state.phase === 'restarting'))
})

test('an install failure stays the notice even after an offline Try again and a later background download', async () => {
  const f = fixture({ installFailure: true })
  ready(f)
  f.owner.restart()
  f.flush()
  f.updater.checkForUpdates = async () => { throw new Error('offline') }
  f.clock.now += 10_000
  await f.owner.check({ manual: true })
  assert.equal(f.owner.getState().failure, 'check')
  cachedCheck(f)
  f.clock.now += 10_000
  await f.owner.check()
  assert.deepEqual(f.owner.getState(), { status: 'error', failure: 'install', manual: true, message: "The update couldn't start. Brinq is still on version 1.3.6. Try again when you're ready." })
  assert.equal(f.updater.autoInstallOnAppQuit, false)
})

test('a download that fails after announcing its installer stays ready', async () => {
  const f = fixture()
  f.updater.checkForUpdates = async () => {
    f.updater.emit('update-available', { version: '2.0.0' })
    f.updater.emit('update-downloaded', { version: '2.0.0' })
    // electron-updater 6.8.3 then copies the blockmap into its cache.
    return { downloadPromise: new Promise((_resolve, reject) => setImmediate(() => { f.updater.emit('error', new Error('EPERM copyfile')); reject(new Error('EPERM copyfile')) })) }
  }
  assert.equal((await f.owner.check()).ok, true)
  assert.equal(f.owner.getState().status, 'ready')
  assert.equal(f.changes.at(-1).status, 'ready')
  assert.equal(f.owner.restart().ok, true)
})

test('only real throttling holds checks: 429, or a 403 with no quota left', async () => {
  const { createHttpError } = require('builder-util-runtime')
  const response = (statusCode, statusMessage, remaining) => ({ statusCode, statusMessage, headers: { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': remaining, 'set-cookie': 'secret' } })
  const cases = [
    [createHttpError(response(429, 'Too Many Requests', '0')), true],
    [createHttpError(response(403, 'Forbidden', '0')), true],
    [createHttpError(response(403, 'Forbidden', '59')), false],
    [createHttpError(response(404, 'Not Found', '59')), false],
    // GitHubProvider wraps HTTP errors in plain ones that keep their text.
    [new Error(`Unable to find latest version on GitHub (https://github.com/x/releases/latest), please ensure a production release exists: HttpError: 429 Too Many Requests\n${'Headers: {}'}`), true],
    [new Error('API rate limit exceeded for 203.0.113.9.'), true],
    [new Error('net::ERR_INTERNET_DISCONNECTED'), false],
  ]
  for (const [error, limited] of cases) {
    const f = fixture()
    f.updater.checkForUpdates = async () => { throw error }
    const result = await f.owner.check()
    assert.equal(result.retryAt !== undefined, limited, error.message.split('\n')[0])
  }
})

test('every check that reaches the feed is reported for scheduling, including a person\'s', async () => {
  const reports = []
  const app = new EventEmitter()
  app.isPackaged = true
  const updater = new EventEmitter()
  const owner = createUpdateStatus({ app, updater, schedule: () => {}, onCheckEnd: (result) => reports.push(result.ok) })
  updater.checkForUpdates = async () => { throw new Error('offline') }
  await owner.check({ manual: true })
  updater.checkForUpdates = async () => { updater.emit('update-not-available'); return {} }
  await owner.check()
  // An answer given without checking is not a report.
  await owner.check({ manual: true })
  assert.deepEqual(reports, [false, true])
})

test('the header shows only an installable, installing or user-facing failed update', () => {
  const { headerView, MESSAGES } = require('../src/update-status')
  const cases = [
    [{ status: 'idle' }, null],
    [{ status: 'checking' }, null],
    [{ status: 'up-to-date' }, null],
    [{ status: 'downloading', version: '2.0.0', percent: 40 }, null],
    [{ status: 'unavailable', message: 'x' }, null],
    [{ status: 'error', failure: 'check', manual: false, message: MESSAGES.check }, null],
    [{ status: 'error', failure: 'download', manual: false, message: MESSAGES.download }, null],
    [{ status: 'error', failure: 'download', manual: true, message: MESSAGES.download }, { view: 'failed', message: MESSAGES.download }],
    [{ status: 'error', failure: 'install', manual: true, message: 'm' }, { view: 'failed', message: 'm' }],
    [{ status: 'ready', version: '2.0.0', message: MESSAGES.ready }, { view: 'ready' }],
    [{ status: 'ready', version: '2.0.0', phase: 'restarting', message: MESSAGES.restarting }, { view: 'restarting' }],
    [{ status: 'ready', version: '2.0.0', message: MESSAGES.postponed }, { view: 'ready', note: 'Update postponed', noteDetail: MESSAGES.postponed }],
    [{ status: 'ready', version: '2.0.0', message: MESSAGES.stalled }, { view: 'ready', note: 'Update postponed', noteDetail: MESSAGES.stalled }],
  ]
  for (const [state, expected] of cases) assert.deepEqual(headerView(state), expected, JSON.stringify(state))
})

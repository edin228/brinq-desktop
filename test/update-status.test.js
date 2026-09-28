const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createUpdateStatus } = require('../src/update-status')

function fixture({ packaged = true, dirty = false, installFailure = false, asyncInstallFailure = false } = {}) {
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
  updater.quitAndInstall = () => {
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
    if (dirty && windows.length) {
      windows[0].webContents.emit('will-prevent-unload')
      return
    }
    windows = []
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    app.emit('will-quit', event)
    if (!event.defaultPrevented) { exited = true; app.emit('quit', {}, 0) }
  }
  const owner = createUpdateStatus({ app, updater, schedule: (fn) => scheduled.push(fn), onChange: (state) => changes.push(state), restoreWindow: () => { restored++ } })
  const window = { webContents: new EventEmitter() }
  windows.push(window)
  app.emit('browser-window-created', {}, window)
  return { app, updater, owner, changes, window, flush() { while (scheduled.length) scheduled.shift()() }, get restored() { return restored }, get installs() { return installs }, get quits() { return quits }, get exited() { return exited } }
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
  assert.match(f.owner.getState().message, /Restart canceled/)
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

  function installedFixture({ file = missing, dirty = false, mac = false, managed = true } = {}) {
    const app = new EventEmitter()
    app.isPackaged = true
    const frame = new EventEmitter()
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
      if (windowsOpen && dirty) { frame.emit('will-prevent-unload'); return }
      windowsOpen = false
      const quitting = event()
      app.emit('will-quit', quitting)
      if (!quitting.defaultPrevented) exited = true
    }
    electron.autoUpdater.quitAndInstall = () => {
      assert.equal(windowsOpen, false)
      installs++
      setImmediate(app.quit)
    }
    const updater = new (mac ? MacUpdater : NsisUpdater)(null, { version: '1.2.5', quit: app.quit })
    updater.logger = null
    updater.on('error', () => { errors++ })
    if (mac) updater.squirrelDownloadedUpdate = true
    else updater.downloadedUpdateHelper = { file, downloadedFileInfo: { isAdminRightsRequired: false } }
    // Stub only OS execution. Installed BaseUpdater.quitAndInstall and
    // NsisUpdater.doInstall, including the ENOENT fallback, remain real.
    updater.spawnLog = async () => {
      spawns++
      if (file === missing) throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' })
      assert.equal(windowsOpen, false)
      installs++
      return true
    }
    const owner = managed ? createUpdateStatus({ app, updater, restoreWindow: () => { restored++; windowsOpen = true } }) : null
    if (owner) {
      app.emit('browser-window-created', {}, { webContents: frame })
      updater.emit('update-downloaded', { version: '2.0.0' })
    }
    return { app, updater, owner, snapshot: () => ({ exited, restored, spawns, opens, installs, errors }) }
  }

  await t.test('reproduces the installed ENOENT/openPath contract without Brinq protection', async () => {
    const f = installedFixture({ managed: false })
    f.updater.quitAndInstall()
    await settle()
    assert.deepEqual(f.snapshot(), { exited: true, restored: 0, spawns: 1, opens: 1, installs: 0, errors: 0 })
  })
  for (const [label, file] of [['missing', missing], ['directory', directory], ['absent metadata', null]]) {
    await t.test(`${label} installer recovers without invoking native execution`, async () => {
      const f = installedFixture({ file })
      f.owner.restart()
      await settle()
      assert.deepEqual(f.snapshot(), { exited: false, restored: 1, spawns: 0, opens: 0, installs: 0, errors: 0 })
      assert.equal(f.owner.getState().status, 'error')
      assert.equal(f.updater.autoInstallOnAppQuit, false)
      assert.equal(f.app.isQuitting, false)
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
})

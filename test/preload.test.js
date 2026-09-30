const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const { EventEmitter } = require('node:events')
const source = fs.readFileSync(require.resolve('../src/preload'), 'utf8')
// A minimal page: a root element whose class list changes like next-themes,
// and a MutationObserver that tests trigger by hand.
function fakePage({ rootReady = true, classes = [] } = {}) {
  const page = new EventEmitter()
  const classList = new Set(classes)
  const root = { classList: { contains: (name) => classList.has(name) } }
  page.observers = []
  page.document = {
    documentElement: rootReady ? root : null,
    addEventListener: (name, fn) => page.once(`document:${name}`, fn),
  }
  page.window = { addEventListener: (name, fn) => page.once(`window:${name}`, fn) }
  page.MutationObserver = class {
    constructor(callback) { this.callback = callback; this.connected = false; page.observers.push(this) }
    observe(target, options) { this.target = target; this.options = options; this.connected = true }
    disconnect() { this.connected = false }
  }
  page.setClasses = (...names) => {
    classList.clear()
    for (const name of names) classList.add(name)
    for (const observer of page.observers) if (observer.connected) observer.callback([])
  }
  page.ready = () => { page.document.documentElement = root; page.emit('document:DOMContentLoaded') }
  return page
}

function load(protocol = 'http:', isMainFrame = true, page = fakePage()) {
  let api
  const ipc = new EventEmitter()
  const calls = []
  ipc.send = (...args) => { calls.push(args) }
  ipc.invoke = (...args) => { calls.push(args); return Promise.resolve({ ok: true }) }
  vm.runInNewContext(source, {
    require: () => ({ contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'electronAPI'); api = value } }, ipcRenderer: ipc }),
    process: { isMainFrame }, location: { protocol },
    document: page.document, window: page.window, MutationObserver: page.MutationObserver,
  })
  return { api, ipc, calls, page }
}

test('preload exposes fixed file and legacy methods and strips IPC events', async () => {
  const { api, ipc, calls } = load()
  assert.deepEqual(Object.keys(api).sort(), ['getUpdateStatus', 'checkForUpdates', 'restartToUpdate', 'onUpdateStatus', 'getDesktopState', 'changeMode', 'getFileCapabilities', 'openFile', 'saveFileAs', 'cancelFileOperation', 'notify', 'setBadgeCount', 'setMode', 'onNavigateEmail', 'onMailto', 'getFileEmail', 'saveFileAttachment', 'openFileAttachment', 'openEmailAttachment', 'saveEmailAttachment'].sort())
  api.notify('Title', 'Body', { uid: 'one' }); api.setBadgeCount(2); api.setMode('email')
  await api.getFileEmail('viewer'); await api.saveFileAttachment('viewer', 1); await api.openFileAttachment('viewer', 2)
  await api.openEmailAttachment('email', 'attachment', 'test.pdf'); await api.saveEmailAttachment('email', 'attachment', 'test.pdf')
  assert.deepEqual(calls.map(call => call[0]), ['notify', 'badge-count', 'set-mode', 'get-file-email', 'save-file-attachment', 'open-file-attachment', 'open-email-attachment', 'save-email-attachment'])
  await api.getFileCapabilities()
  await api.openFile({ kind: 'brinq-file', uid: 'one' }, 'operation')
  await api.saveFileAs({ kind: 'brinq-file', uid: 'one' }, 'operation')
  await api.cancelFileOperation('operation')
  assert.deepEqual(calls.slice(-4).map(call => call[0]), ['file-capabilities', 'open-file', 'save-file-as', 'cancel-file-operation'])
  for (const [method, channel] of [['onNavigateEmail', 'navigate-email'], ['onMailto', 'mailto']]) {
    const received = []
    const off = api[method]((...args) => received.push(args))
    ipc.emit(channel, { sender: 'privileged' }, 'payload')
    off(); ipc.emit(channel, {}, 'ignored')
    assert.deepEqual(received, [['payload']])
    assert.equal(ipc.listenerCount(channel), 0)
  }
})

test('inherited print preload, opaque documents and subframes expose no bridge', () => {
  for (const protocol of ['about:', 'blob:', 'file:', 'data:']) assert.equal(load(protocol).api, undefined)
  assert.equal(load('https:', false).api, undefined)
})

 test('subscription signals follow listener attachment and final removal; state APIs acknowledge requests', async () => {
  const { api, ipc, calls } = load()
  ipc.send = (...args) => {
    if (args[0] === 'email-listener-state') assert.equal(ipc.listenerCount(args[1]) > 0, args[2])
    calls.push(args)
  }
  const offOne = api.onMailto(() => {})
  const offTwo = api.onMailto(() => {})
  offOne(); offOne(); offTwo()
  assert.deepEqual(calls, [['email-listener-state', 'mailto', true], ['email-listener-state', 'mailto', false]])
  await api.getDesktopState()
  await api.changeMode('full')
  assert.deepEqual(calls.slice(-2), [['desktop-state'], ['change-mode', 'full']])
})


test('update bridge returns results and removes status listeners', async () => {
  const { api, ipc, calls } = load()
  await api.getUpdateStatus()
  await api.checkForUpdates()
  await api.restartToUpdate()
  assert.deepEqual(calls, [['update-status'], ['check-for-updates'], ['restart-to-update']])
  const received = []
  const off = api.onUpdateStatus((state) => received.push(state))
  ipc.emit('update-status', { sender: 'main' }, { status: 'ready' })
  off()
  ipc.emit('update-status', {}, { status: 'error' })
  assert.deepEqual(received, [{ status: 'ready' }])
})

const themeSends = (calls) => calls.filter((call) => call[0] === 'theme-changed').map((call) => call[1])

test('the app preload reports an unambiguous theme on start and on change, once each', () => {
  const page = fakePage({ classes: ['dark'] })
  const { calls } = load('https:', true, page)
  assert.deepEqual(themeSends(calls), ['dark'])
  assert.equal(JSON.stringify(page.observers[0].options), JSON.stringify({ attributes: true, attributeFilter: ['class'] }))
  page.setClasses('dark')
  page.setClasses('light')
  page.setClasses('light', 'font-body')
  page.setClasses('light', 'dark')
  page.setClasses()
  page.setClasses('dark')
  assert.deepEqual(themeSends(calls), ['dark', 'light', 'dark'])
})

test('theme reporting waits for a theme class and for the root element', () => {
  const page = fakePage({ rootReady: false })
  const { calls } = load('http:', true, page)
  assert.deepEqual(themeSends(calls), [])
  assert.equal(page.observers.length, 0)
  page.ready()
  assert.deepEqual(themeSends(calls), [])
  page.setClasses('light')
  assert.deepEqual(themeSends(calls), ['light'])
})

test('a theme request re-reports even when unchanged; pagehide stops observing', () => {
  const page = fakePage({ classes: ['light'] })
  const { calls, ipc } = load('http:', true, page)
  ipc.emit('theme-request', { sender: 'main' })
  ipc.emit('theme-request', { sender: 'main' })
  assert.deepEqual(themeSends(calls), ['light', 'light', 'light'])
  page.emit('window:pagehide')
  assert.equal(page.observers[0].connected, false)
  page.setClasses('dark')
  assert.deepEqual(themeSends(calls), ['light', 'light', 'light'])
})

test('subframes and non-web documents never observe or report a theme', () => {
  for (const [protocol, isMainFrame] of [['https:', false], ['about:', true], ['blob:', true], ['file:', true]]) {
    const page = fakePage({ classes: ['dark'] })
    const { calls, ipc } = load(protocol, isMainFrame, page)
    ipc.emit('theme-request', {})
    assert.deepEqual(themeSends(calls), [])
    assert.equal(page.observers.length, 0)
  }
})

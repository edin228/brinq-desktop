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
    // Capture listeners persist; other listeners here are one-shot.
    addEventListener: (name, fn, options) => (options === true || options?.capture
      ? page.on(`document:${name}`, fn) : page.once(`document:${name}`, fn)),
  }
  class Element {
    constructor(parent = null) { this.parent = parent }
    closest() {
      for (let node = this; node; node = node.parent) {
        if (node instanceof HTMLAnchorElement && 'href' in node.attrs) return node
      }
      return null
    }
  }
  class HTMLAnchorElement extends Element {
    constructor({ attrs = {}, text = '', origin = 'https://brinq.io', path = '/clients/42?view=policies' } = {}) {
      super(null)
      this.attrs = { href: path, ...attrs }
      this.innerText = text
      this.origin = origin
      this.href = `${origin}${path}`
    }
    getAttribute(name) { return name in this.attrs ? this.attrs[name] : null }
    hasAttribute(name) { return name in this.attrs }
  }
  page.Element = Element
  page.HTMLAnchorElement = HTMLAnchorElement
  page.fire = (type, props) => page.emit(`document:${type}`, {
    isTrusted: true, defaultPrevented: false, altKey: false, shiftKey: false, ctrlKey: false,
    metaKey: false, repeat: false, isComposing: false, detail: 1, button: 0, ...props,
  })
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

function load(protocol = 'http:', isMainFrame = true, page = fakePage(), platform = 'linux') {
  let api
  const ipc = new EventEmitter()
  const calls = []
  ipc.send = (...args) => { calls.push(args) }
  ipc.invoke = (...args) => { calls.push(args); return Promise.resolve({ ok: true }) }
  ipc.sendSync = (...args) => { calls.push(['sync', ...args]); return true }
  vm.runInNewContext(source, {
    require: () => ({ contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'electronAPI'); api = value } }, ipcRenderer: ipc }),
    process: { isMainFrame, platform }, location: { protocol, origin: 'https://brinq.io' },
    document: page.document, window: page.window, MutationObserver: page.MutationObserver,
    Element: page.Element, HTMLAnchorElement: page.HTMLAnchorElement,
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

test('browser sign-in methods exist only on Windows and only invoke their fixed channels', async () => {
  const methods = ['startBrowserSignIn', 'cancelBrowserSignIn', 'takeBrowserSignIn']
  for (const platform of ['darwin', 'linux']) {
    const { api } = load('https:', true, fakePage(), platform)
    for (const method of methods) assert.equal(api[method], undefined, `${platform} ${method}`)
  }
  const { api, calls } = load('https:', true, fakePage(), 'win32')
  await api.startBrowserSignIn('https://evil.test')
  await api.cancelBrowserSignIn('ignored')
  await api.takeBrowserSignIn('ignored')
  assert.deepEqual(calls.slice(-3), [['browser-sign-in-start'], ['browser-sign-in-cancel'], ['browser-sign-in-take']])
  for (const protocol of ['about:', 'blob:']) assert.equal(load(protocol, true, fakePage(), 'win32').api, undefined)
  assert.equal(load('https:', false, fakePage(), 'win32').api, undefined)
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

const labelSends = (calls) => calls.filter((call) => call[0] === 'sync' && call[1] === 'link-label').map((call) => call[2])

test('Ctrl+click, middle-click and Ctrl+Enter send the link label synchronously', () => {
  const page = fakePage()
  const { calls } = load('https:', true, page)
  const anchor = new page.HTMLAnchorElement({ attrs: { 'data-tab-label': '  Acme \n Holdings ' }, text: 'SERVICE_CENTER Acme' })
  const child = new page.Element(anchor)
  page.fire('click', { target: child, ctrlKey: true })
  page.fire('click', { target: child, metaKey: true })
  page.fire('auxclick', { target: anchor, button: 1 })
  page.fire('keydown', { target: anchor, key: 'Enter', ctrlKey: true })
  const expected = { href: 'https://brinq.io/clients/42?view=policies', label: 'Acme Holdings' }
  assert.equal(JSON.stringify(labelSends(calls)), JSON.stringify([expected, expected, expected, expected]))
})

test('a link without a label uses its visible text, capped at 120 characters', () => {
  const page = fakePage()
  const { calls } = load('https:', true, page)
  page.fire('click', { target: new page.HTMLAnchorElement({ text: '  Blue   Ridge\nBakery ' }), ctrlKey: true })
  page.fire('click', { target: new page.HTMLAnchorElement({ attrs: { 'data-tab-label': '  ' }, text: 'Fallback text' }), ctrlKey: true })
  page.fire('click', { target: new page.HTMLAnchorElement({ text: '😀'.repeat(130) }), ctrlKey: true })
  const labels = labelSends(calls).map((payload) => payload.label)
  assert.deepEqual(labels.slice(0, 2), ['Blue Ridge Bakery', 'Fallback text'])
  assert.equal([...labels[2]].length, 120)
})

test('ordinary, untrusted, handled or non-link input sends no label', () => {
  const page = fakePage()
  const { calls } = load('https:', true, page)
  const anchor = new page.HTMLAnchorElement({ text: 'Acme' })
  for (const [type, props] of [
    ['click', { target: anchor }],
    ['click', { target: anchor, ctrlKey: true, detail: 0 }],
    ['click', { target: anchor, ctrlKey: true, shiftKey: true }],
    ['click', { target: anchor, ctrlKey: true, altKey: true }],
    ['click', { target: anchor, ctrlKey: true, isTrusted: false }],
    ['click', { target: anchor, ctrlKey: true, defaultPrevented: true }],
    ['click', { target: anchor, ctrlKey: true, button: 2 }],
    ['auxclick', { target: anchor, button: 2 }],
    ['keydown', { target: anchor, key: 'Enter' }],
    ['keydown', { target: anchor, key: 'Enter', ctrlKey: true, repeat: true }],
    ['keydown', { target: anchor, key: 'Enter', ctrlKey: true, isComposing: true }],
    ['keydown', { target: anchor, key: 'a', ctrlKey: true }],
    ['click', { target: { nodeType: 3 }, ctrlKey: true }],
    ['click', { target: new page.Element(), ctrlKey: true }],
    ['click', { target: new page.HTMLAnchorElement({ attrs: { download: '' }, text: 'File' }), ctrlKey: true }],
    ['click', { target: new page.HTMLAnchorElement({ origin: 'https://evil.test', text: 'Elsewhere' }), ctrlKey: true }],
    ['click', { target: new page.HTMLAnchorElement({ text: '   ' }), ctrlKey: true }],
  ]) page.fire(type, props)
  assert.deepEqual(labelSends(calls), [])
})

test('a failed synchronous send never breaks the page, and other documents send nothing', () => {
  const page = fakePage()
  const { ipc } = load('https:', true, page)
  ipc.sendSync = () => { throw new Error('closed') }
  assert.doesNotThrow(() => page.fire('click', { target: new page.HTMLAnchorElement({ text: 'Acme' }), ctrlKey: true }))
  for (const [protocol, isMainFrame] of [['https:', false], ['file:', true], ['about:', true]]) {
    const other = fakePage()
    const { calls } = load(protocol, isMainFrame, other)
    other.fire('click', { target: new other.HTMLAnchorElement({ text: 'Acme' }), ctrlKey: true })
    assert.deepEqual(labelSends(calls), [])
  }
})

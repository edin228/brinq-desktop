const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

test('recovery preload has only argument-free retry and denies non-file documents/subframes', async () => {
  const source = fs.readFileSync(require.resolve('../src/recovery-preload'), 'utf8')
  for (const [protocol, isMainFrame] of [['file:', true], ['https:', true], ['file:', false], ['about:', true]]) {
    let api
    const calls = []
    vm.runInNewContext(source, {
      process: { isMainFrame }, location: { protocol },
      require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { api = value } }, ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }) } } }),
    })
    if (protocol === 'file:' && isMainFrame) {
      assert.deepEqual(Object.keys(api), ['retry'])
      await api.retry('https://untrusted.test', '/etc/passwd')
      assert.deepEqual(calls, [['retry-app-load']])
    } else assert.equal(api, undefined)
  }
})

function recoveryFixture() {
  const source = fs.readFileSync(require.resolve('../src/main'), 'utf8')
  const functions = source.slice(source.indexOf('function approvedAppUrl('), source.indexOf('function createWindow('))
  const handlers = new Map()
  const urls = []
  const frame = { parent: null, detached: false, url: 'file:///app/src/offline.html' }
  const contents = { mainFrame: frame, isDestroyed: () => false, getURL: () => frame.url }
  let resolve
  const context = {
    URL, Promise, BASE_ORIGIN: 'https://brinq.io', RECOVERY_URL: frame.url,
    recoveryWindow: { webContents: contents, isDestroyed: () => false }, recoveryRetry: null,
    mainWindow: { isDestroyed: () => false, loadURL: (url) => { urls.push(url); return new Promise((done) => { resolve = done }) } },
    intendedAppUrl: 'https://brinq.io/clients/123?standalone=full',
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
  }
  vm.createContext(context); vm.runInContext(functions, context)
  return { context, urls, frame, contents, retry: handlers.get('retry-app-load'), resolve: () => resolve() }
}

test('only live recovery top frame can retry; supplied destinations cannot change approved route', async () => {
  const f = recoveryFixture()
  const event = { sender: f.contents, senderFrame: f.frame }
  for (const denied of [{ ...event, sender: {} }, { ...event, senderFrame: { ...f.frame } }, { sender: {}, senderFrame: {} }]) {
    assert.equal(f.retry(denied).ok, false)
  }
  f.frame.url = 'https://brinq.io/'
  assert.equal(f.retry(event).ok, false)
  f.frame.url = 'file:///app/src/offline.html'
  const pending = f.retry(event, 'https://evil.test')
  assert.equal(f.retry(event), pending)
  assert.deepEqual(f.urls, ['https://brinq.io/clients/123?standalone=full'])
  f.resolve()
  assert.equal((await pending).ok, true)
  f.context.intendedAppUrl = 'file:///etc/passwd'
  assert.equal((await f.retry(event)).ok, false)
  assert.equal(f.urls.length, 1)
})

test('local Retry reports failure and can be used again', async () => {
  let click
  const button = { disabled: false, addEventListener: (_event, fn) => { click = fn } }
  const status = { textContent: '' }
  let attempts = 0
  const context = {
    document: { getElementById: (id) => id === 'retry' ? button : status },
    window: { brinqRecovery: { retry: async () => { attempts++; return { ok: false, error: 'Still unable to connect.' } } } },
  }
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/offline'), 'utf8'), context)
  await click()
  assert.equal(button.disabled, false)
  assert.equal(status.textContent, 'Still unable to connect.')
  await click()
  assert.equal(attempts, 2)
})

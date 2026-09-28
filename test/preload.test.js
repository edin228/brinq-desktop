const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const { EventEmitter } = require('node:events')
const source = fs.readFileSync(require.resolve('../src/preload'), 'utf8')
function load(protocol = 'http:', isMainFrame = true) {
  let api
  const ipc = new EventEmitter()
  const calls = []
  ipc.send = (...args) => { calls.push(args) }
  ipc.invoke = (...args) => { calls.push(args); return Promise.resolve({ ok: true }) }
  vm.runInNewContext(source, {
    require: () => ({ contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'electronAPI'); api = value } }, ipcRenderer: ipc }),
    process: { isMainFrame }, location: { protocol },
  })
  return { api, ipc, calls }
}

test('preload exposes only fixed legacy methods and strips IPC events', async () => {
  const { api, ipc, calls } = load()
  assert.deepEqual(Object.keys(api).sort(), ['notify', 'setBadgeCount', 'setMode', 'onNavigateEmail', 'onMailto', 'getFileEmail', 'saveFileAttachment', 'openFileAttachment', 'openEmailAttachment', 'saveEmailAttachment'].sort())
  api.notify('Title', 'Body', { uid: 'one' }); api.setBadgeCount(2); api.setMode('email')
  await api.getFileEmail('viewer'); await api.saveFileAttachment('viewer', 1); await api.openFileAttachment('viewer', 2)
  await api.openEmailAttachment('email', 'attachment', 'test.pdf'); await api.saveEmailAttachment('email', 'attachment', 'test.pdf')
  assert.deepEqual(calls.map(call => call[0]), ['notify', 'badge-count', 'set-mode', 'get-file-email', 'save-file-attachment', 'open-file-attachment', 'open-email-attachment', 'save-email-attachment'])
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

const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const { EventEmitter } = require('node:events')
const source = fs.readFileSync(require.resolve('../src/shell-preload'), 'utf8')

function load(protocol = 'file:', isMainFrame = true, state = { selectedId: 1 }) {
  let api
  const ipc = new EventEmitter()
  const calls = []
  ipc.send = (...args) => { calls.push(args) }
  ipc.invoke = (...args) => { calls.push(args); return Promise.resolve(state) }
  vm.runInNewContext(source, {
    require: () => ({ contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'brinqTabs'); api = value } }, ipcRenderer: ipc }),
    process: { isMainFrame }, location: { protocol },
  })
  return { api, ipc, calls }
}

test('the strip bridge exposes fixed tab commands only', () => {
  const { api, calls } = load()
  assert.deepEqual(Object.keys(api).sort(), ['close', 'home', 'move', 'newTab', 'onState', 'reload', 'retry', 'select'])
  api.select(4, true); api.select(5, 'yes'); api.close(4); api.retry(4); api.newTab(); api.home(true); api.reload(); api.move(4, 2)
  assert.equal(JSON.stringify(calls), JSON.stringify([
    ['tabs:command', 'select', 4, { focus: true }],
    ['tabs:command', 'select', 5, { focus: false }],
    ['tabs:command', 'close', 4, null],
    ['tabs:command', 'retry', 4, null],
    ['tabs:command', 'new', null, null],
    ['tabs:command', 'home', null, { focus: true }],
    ['tabs:command', 'reload', null, null],
    ['tabs:command', 'move', 4, { position: 2 }],
  ]))
})

test('state subscribes before asking for a snapshot and strips IPC events', async () => {
  const snapshot = { selectedId: 3 }
  const { api, ipc, calls } = load('file:', true, snapshot)
  const received = []
  const off = api.onState((state) => received.push(state))
  assert.equal(ipc.listenerCount('tabs:state'), 1)
  assert.deepEqual(calls, [['tabs:state']])
  ipc.emit('tabs:state', { sender: 'main' }, { selectedId: 2 })
  await Promise.resolve()
  assert.deepEqual(received, [{ selectedId: 2 }, snapshot])
  off()
  assert.equal(ipc.listenerCount('tabs:state'), 0)
})

test('web pages, other documents and subframes get no strip bridge', () => {
  for (const [protocol, isMainFrame] of [['https:', true], ['http:', true], ['about:', true], ['file:', false]]) {
    assert.equal(load(protocol, isMainFrame).api, undefined)
  }
})

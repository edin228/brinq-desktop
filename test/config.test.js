const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')

test('new profiles default to full and saved choices survive without a mode rewrite', () => {
  for (const saved of [undefined, 'email', 'full']) {
    const writes = []
    const module = { exports: {} }
    vm.runInNewContext(fs.readFileSync(require.resolve('../src/config'), 'utf8'), {
      module,
      require(name) {
        if (name === 'electron-store') return class {
          constructor({ defaults }) { this.values = { ...defaults, ...(saved ? { mode: saved } : {}) } }
          get(key) { return this.values[key] }
          set(key, value) { writes.push([key, value]); this.values[key] = value }
        }
        if (name === 'electron') return { app: { isPackaged: false } }
        if (name === './startup-tabs') return require('../src/startup-tabs')
        return require('../src/window-security')
      },
    })
    assert.equal(module.exports.getMode(), saved || 'full')
    assert.deepEqual(writes, [])
    module.exports.setMode('email')
    assert.equal(module.exports.getMode(), 'email')
  }
})

test('saved header theme is light by default, validated, and corrupt values fall back', () => {
  for (const [saved, expected] of [[undefined, 'light'], ['dark', 'dark'], ['light', 'light'], ['purple', 'light'], [42, 'light']]) {
    const writes = []
    const module = { exports: {} }
    vm.runInNewContext(fs.readFileSync(require.resolve('../src/config'), 'utf8'), {
      module,
      require(name) {
        if (name === 'electron-store') return class {
          constructor({ defaults }) { this.values = { ...defaults, ...(saved !== undefined ? { theme: saved } : {}) } }
          get(key) { return this.values[key] }
          set(key, value) { writes.push([key, value]); this.values[key] = value }
        }
        if (name === 'electron') return { app: { isPackaged: false } }
        if (name === './startup-tabs') return require('../src/startup-tabs')
        return require('../src/window-security')
      },
    })
    assert.equal(module.exports.getTheme(), expected)
    module.exports.setTheme('<script>')
    module.exports.setTheme('dark')
    assert.deepEqual(writes, [['theme', 'dark']])
    assert.equal(module.exports.getTheme(), 'dark')
  }
})

test('startup choice and last session read safely and save in one store write', () => {
  const writes = []
  const module = { exports: {} }
  const values = { startup: { choice: 'pages', pages: ['email'] }, lastSession: { userId: 'u-1', tabs: [{ url: 'https://brinq.io/emails', title: 'x' }], selectedIndex: 0 } }
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/config'), 'utf8'), {
    module,
    require(name) {
      if (name === 'electron-store') return class {
        constructor({ defaults }) { this.values = { ...defaults, ...values } }
        get(key) { return this.values[key] }
        set(key, value) {
          writes.push(typeof key === 'string' ? { [key]: value } : key)
          if (typeof key === 'string') this.values[key] = value
          else Object.assign(this.values, key)
        }
      }
      if (name === 'electron') return { app: { isPackaged: false } }
      if (name === './startup-tabs') return require('../src/startup-tabs')
      return require('../src/window-security')
    },
  })
  const config = module.exports
  assert.deepEqual(config.getStartup(), { choice: 'pages', pages: ['email'] })
  assert.deepEqual(config.getLastSession(), { userId: 'u-1', tabs: [{ url: 'https://brinq.io/emails' }] }, 'titles and selection are dropped')
  config.saveStartup({ choice: 'home', pages: ['email'] }, { clearSession: true })
  // Objects built inside the VM have another realm's prototype; compare by value.
  const plain = (value) => JSON.parse(JSON.stringify(value))
  assert.deepEqual(plain(writes), [{ startup: { choice: 'home', pages: ['email'] }, lastSession: null }], 'one write')
  assert.equal(config.getLastSession(), null)
  config.saveStartup({ choice: 'last', pages: [] })
  assert.deepEqual(plain(writes.at(-1)), { startup: { choice: 'last', pages: [] } })
})

test('a corrupt startup value means Home only', () => {
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/config'), 'utf8'), {
    module,
    require(name) {
      if (name === 'electron-store') return class {
        constructor({ defaults }) { this.values = { ...defaults, startup: { choice: 'everything' }, lastSession: 'x' } }
        get(key) { return this.values[key] }
        set() {}
      }
      if (name === 'electron') return { app: { isPackaged: false } }
      if (name === './startup-tabs') return require('../src/startup-tabs')
      return require('../src/window-security')
    },
  })
  assert.deepEqual(module.exports.getStartup(), { choice: 'home', pages: [] })
  assert.equal(module.exports.getLastSession(), null)
})

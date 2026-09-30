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

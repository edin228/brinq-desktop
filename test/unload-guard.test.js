const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { confirmLeave, guardWindowUnload } = require('../src/unload-guard')

// A standalone window (an email pop-out) closes the way Electron closes one:
// a page with unsaved work (`dirty`) runs its beforeunload veto, emitted as
// will-prevent-unload, and the window closes only if a listener lets it go.
function popout({ dirty = false, minimized = false } = {}) {
  const webContents = new EventEmitter()
  const window = Object.assign(new EventEmitter(), {
    webContents, dirty, minimized, destroyed: false, shown: 0, restored: 0,
    isDestroyed() { return this.destroyed },
    isMinimized() { return this.minimized },
    restore() { this.restored++; this.minimized = false },
    show() { this.shown++ },
    // Close button, Alt+F4, Cmd+W and quit all reach this path.
    close() { if (this.unload()) this.destroyed = true },
    reload() { return this.unload() },
    unload() {
      if (!this.dirty) return true
      let leave = false
      webContents.emit('will-prevent-unload', { preventDefault() { leave = true } })
      return leave
    },
  })
  return window
}

function fixture({ choice = 1, ...options } = {}) {
  const window = popout(options)
  const dialogs = []
  const dialog = { showMessageBoxSync: (owner, opts) => { dialogs.push([owner, opts]); return choice } }
  let stays = 0
  guardWindowUnload({ window, dialog, onStay: () => { stays++ } })
  return { window, dialogs, get stays() { return stays } }
}

test('a pop-out without unsaved changes closes without a prompt', () => {
  const f = fixture()
  f.window.close()
  assert.equal(f.window.isDestroyed(), true)
  assert.equal(f.dialogs.length, 0)
  assert.equal(f.stays, 0)
})

test('closing a pop-out with unsaved changes asks, and Leave closes it', () => {
  const f = fixture({ dirty: true, choice: 0 })
  f.window.close()
  assert.equal(f.dialogs.length, 1)
  assert.equal(f.dialogs[0][0], f.window, 'the prompt belongs to the pop-out')
  assert.equal(f.dialogs[0][1].message, 'Discard unsaved changes?')
  assert.equal(f.window.isDestroyed(), true)
  assert.equal(f.stays, 0)
})

test('Stay keeps the pop-out and its page open, and a later Leave closes it', () => {
  const f = fixture({ dirty: true, choice: 1 })
  f.window.close()
  assert.equal(f.dialogs.length, 1)
  assert.equal(f.window.isDestroyed(), false)
  assert.equal(f.stays, 1, 'Stay is reported so a quit or restart stops')
  f.dialogs.length = 0
  f.window.close()
  assert.equal(f.dialogs.length, 1, 'every close asks again')
  assert.equal(f.window.isDestroyed(), false)
})

test('the prompt also guards reloading a pop-out with unsaved changes', () => {
  const stay = fixture({ dirty: true, choice: 1 })
  assert.equal(stay.window.reload(), false)
  const leave = fixture({ dirty: true, choice: 0 })
  assert.equal(leave.window.reload(), true)
  assert.equal(stay.dialogs.length + leave.dialogs.length, 2)
})

test('a minimized pop-out is restored and shown before it asks', () => {
  const f = fixture({ dirty: true, minimized: true })
  f.window.close()
  assert.equal(f.window.restored, 1)
  assert.equal(f.window.shown, 1)
  assert.equal(f.window.isMinimized(), false)
})

test('a destroyed window still gets an unowned prompt rather than a silent veto', () => {
  const f = fixture({ dirty: true, choice: 0 })
  f.window.destroyed = true
  let leave = false
  f.window.webContents.emit('will-prevent-unload', { preventDefault() { leave = true } })
  assert.equal(f.dialogs[0][0], undefined)
  assert.equal(f.window.shown, 0)
  assert.equal(leave, true)
})

test('the prompt is the same on every platform: Leave or Stay, with Stay the safe default', () => {
  const dialogs = []
  const dialog = { showMessageBoxSync: (owner, options) => { dialogs.push(options); return 1 } }
  assert.equal(confirmLeave(dialog, undefined), false)
  const [options] = dialogs
  assert.deepEqual(options.buttons, ['Leave', 'Stay'])
  assert.equal(options.defaultId, 1)
  assert.equal(options.cancelId, 1, 'Escape or closing the prompt keeps the page')
  assert.equal(options.noLink, true)
  assert.equal(options.message, 'Discard unsaved changes?')
  assert.match(options.detail, /not been saved/)
  // Only the first button leaves; any other answer stays.
  assert.equal(confirmLeave({ showMessageBoxSync: () => 0 }), true)
  assert.equal(confirmLeave({ showMessageBoxSync: () => -1 }), false)
})

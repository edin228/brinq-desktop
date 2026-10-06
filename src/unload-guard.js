// A page's beforeunload handler (an unsaved draft, for example) asks to keep
// the page when it would close, reload or navigate away. Electron shows no
// prompt for it: an unhandled will-prevent-unload is a silent veto, so a
// window with unsaved work would ignore its close button. These ask instead.

// Asks whether to discard the page's unsaved changes. True means Leave.
function confirmLeave(dialog, owner) {
  const choice = dialog.showMessageBoxSync(owner, {
    type: 'question',
    buttons: ['Leave', 'Stay'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: 'Unsaved changes',
    message: 'Discard unsaved changes?',
    detail: 'Changes you made on this page have not been saved. Leave to discard them, or Stay to keep editing.',
  })
  return choice === 0
}

// Guards a standalone window's own page (email pop-outs and other windows;
// tabs have their own guard in tab-window.js). Leave lets the page unload;
// Stay keeps it and calls onStay, since a kept page also stops a quit.
function guardWindowUnload({ window, dialog, onStay = () => {} }) {
  window.webContents.on('will-prevent-unload', (event) => {
    const owner = window.isDestroyed() ? undefined : window
    if (owner) {
      // Show the page the question is about.
      if (owner.isMinimized()) owner.restore()
      owner.show()
    }
    if (confirmLeave(dialog, owner)) {
      event.preventDefault()
      return
    }
    onStay()
  })
}

module.exports = { confirmLeave, guardWindowUnload }

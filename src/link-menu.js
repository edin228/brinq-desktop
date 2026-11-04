const { shareableUrl } = require('./tabs')

// Right-clicking a Brinq link (the sidebar navigation, or any app link in the
// page) offers what a browser does: open it in a new tab, or copy it. Only
// validated app pages get the menu, only for app URLs in their top document.
// Anything else keeps Electron's default (no menu).
function createLinkMenu({ security, Menu, clipboard, openTab, canOpenTab = () => true, windowFor }) {
  function show(contents, params) {
    if (!params || typeof params.linkURL !== 'string' || !params.linkURL) return false
    // Electron 44 may report no frame; only a click in the top document counts.
    if (!params.frame || params.frame !== contents.mainFrame) return false
    if (!security.validateSender({ sender: contents, senderFrame: params.frame })) return false
    const link = params.linkURL
    const shared = shareableUrl(link, security.isAppUrl)
    if (!shared) return false
    const quietly = (action) => () => { try { Promise.resolve(action()).catch(() => {}) } catch {} }
    Menu.buildFromTemplate([
      // Like Ctrl+click and a browser's "Open link in new tab": a background tab.
      { label: 'Open in new tab', enabled: canOpenTab(), click: quietly(() => openTab({ opener: contents, url: link, background: true })) },
      { label: 'Copy link', click: quietly(() => clipboard.writeText(shared)) },
    ]).popup({ window: windowFor(contents) || undefined })
    return true
  }

  function attach(contents) {
    contents.on('context-menu', (_event, params) => { show(contents, params) })
  }

  return { attach, show }
}

module.exports = { createLinkMenu }

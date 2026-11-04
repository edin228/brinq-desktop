const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createWindowSecurity } = require('../src/window-security')
const { createLinkMenu } = require('../src/link-menu')
const BASE = 'http://localhost:3004'

function fixture({ canOpenTab = true } = {}) {
  const security = createWindowSecurity({ baseUrl: BASE, preloadPath: '/preload', openExternal() {} })
  const menus = [], tabs = [], copied = [], owner = { id: 'host' }
  const Menu = { buildFromTemplate: (template) => ({ popup: (options) => menus.push({ template, options }) }) }
  const linkMenu = createLinkMenu({
    security, Menu, clipboard: { writeText: (text) => copied.push(text) },
    openTab: (args) => tabs.push(args), canOpenTab: () => canOpenTab, windowFor: () => owner,
  })
  function page(role = 'main', url = `${BASE}/clients/one`) {
    const contents = new EventEmitter()
    const frame = { url, origin: new URL(url).origin, parent: null, detached: false }
    Object.assign(contents, {
      mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false, setWindowOpenHandler() {},
      session: { setPermissionCheckHandler() {}, setPermissionRequestHandler() {} },
    })
    const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false })
    if (role) security.register(contents, role, role === 'viewer' ? url : undefined, window)
    linkMenu.attach(contents)
    return contents
  }
  const click = (contents, params) => contents.emit('context-menu', {}, { frame: contents.mainFrame, ...params })
  return { menus, tabs, copied, owner, page, click }
}

test('right-clicking a sidebar link offers Open in new tab and Copy link', () => {
  const f = fixture()
  const contents = f.page()
  f.click(contents, { linkURL: `${BASE}/clients?view=renewals&standalone=full#top` })
  assert.equal(f.menus.length, 1)
  const [open, copy] = f.menus[0].template
  assert.deepEqual([open.label, copy.label], ['Open in new tab', 'Copy link'])
  assert.equal(f.menus[0].options.window, f.owner)
  open.click()
  assert.deepEqual(f.tabs, [{ opener: contents, url: `${BASE}/clients?view=renewals&standalone=full#top`, background: true }])
  copy.click()
  // The copied link opens normally in a colleague's browser: no desktop-only mode.
  assert.deepEqual(f.copied, [`${BASE}/clients?view=renewals#top`])
})

test('no menu for non-links, external links, subframes or pages without app authority', () => {
  const f = fixture()
  const app = f.page()
  f.click(app, { linkURL: '' })
  f.click(app, {})
  f.click(app, { linkURL: 'https://example.com/elsewhere' })
  f.click(app, { linkURL: 'javascript:alert(1)' })
  f.click(app, { linkURL: `${BASE}/clients`, frame: { url: `${BASE}/frame` } })
  f.click(f.page(null), { linkURL: `${BASE}/clients` })
  f.click(f.page('viewer', `${BASE}/email/file-viewer?viewerId=v`), { linkURL: `${BASE}/clients` })
  assert.equal(f.menus.length, 0)
})

test('Open in new tab is disabled until the tab window exists, Copy link still works', () => {
  const f = fixture({ canOpenTab: false })
  f.click(f.page('app'), { linkURL: `${BASE}/emails` })
  const [open, copy] = f.menus[0].template
  assert.equal(open.enabled, false)
  copy.click()
  assert.deepEqual(f.copied, [`${BASE}/emails`])
})

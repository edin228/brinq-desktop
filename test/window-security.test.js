const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createWindowSecurity, resolveBaseUrl } = require('../src/window-security')

function fixture(role = 'main', url = 'http://localhost:3004/emails') {
  const external = []
  const policy = createWindowSecurity({ baseUrl: 'http://localhost:3004', preloadPath: '/preload.js', openExternal: url => external.push(url) })
  const session = {
    setPermissionCheckHandler(fn) { this.check = fn },
    setPermissionRequestHandler(fn) { this.request = fn },
  }
  function windowAt(value = url) {
    const wc = new EventEmitter()
    Object.assign(wc, {
      id: 42, mainFrame: { url: value, origin: 'http://localhost:3004', parent: null, detached: false },
      session, isDestroyed: () => false, getURL: () => wc.mainFrame.url,
      setWindowOpenHandler(fn) { this.popup = fn },
    })
    const window = new EventEmitter()
    Object.assign(window, { webContents: wc, destroyed: false, isDestroyed() { return this.destroyed } })
    return window
  }
  const window = windowAt()
  policy.register(window.webContents, role, url, window)
  const wc = window.webContents
  return { policy, window, wc, event: { sender: wc, senderFrame: wc.mainFrame }, external, session, windowAt }
}

test('only live registered top documents have authority', () => {
  const f = fixture()
  assert.equal(f.policy.validateSender(f.event), true)
  for (const frame of [null, { ...f.wc.mainFrame }, { ...f.wc.mainFrame, parent: f.wc.mainFrame }]) {
    assert.equal(f.policy.validateSender({ ...f.event, senderFrame: frame }), false)
  }
  for (const url of ['https://evil.test', 'http://localhost:3004.evil.test', 'file:///tmp/x', 'about:blank', 'blob:http://localhost:3004/id', 'http://user@localhost:3004/']) {
    f.wc.mainFrame.url = url
    assert.equal(f.policy.validateSender(f.event), false, url)
  }
  f.wc.mainFrame.url = 'http://localhost:3004/emails'
  f.wc.mainFrame.origin = 'null'
  assert.equal(f.policy.validateSender(f.event), false)
  f.wc.mainFrame.origin = 'http://localhost:3004'
  f.wc.mainFrame.detached = true
  assert.equal(f.policy.validateSender(f.event), false)
  f.wc.mainFrame.detached = false
  assert.equal(f.policy.validateSender({ sender: f.windowAt().webContents, senderFrame: f.wc.mainFrame }), false)
  f.window.emit('closed')
  assert.equal(f.policy.validateSender(f.event), false)
})

test('navigation invalidates pending native actions even after returning to the same URL', () => {
  const f = fixture()
  const authorized = f.policy.captureSender(f.event)
  assert.equal(authorized(), true)
  f.wc.emit('did-start-navigation', {}, f.wc.getURL(), false, true)
  assert.equal(f.policy.validateSender(f.event), false)
  f.wc.emit('did-frame-navigate', {}, f.wc.getURL(), 200, 'OK', true)
  assert.equal(f.policy.validateSender(f.event), true)
  assert.equal(authorized(), false)
  f.wc.emit('destroyed')
  assert.equal(f.policy.validateSender(f.event), false)
})

test('viewer authority is limited to its exact document and role', () => {
  const f = fixture('viewer', 'http://localhost:3004/email/file-viewer?viewerId=one')
  assert.equal(f.policy.validateSender(f.event), false)
  assert.equal(f.policy.validateSender(f.event, ['viewer']), true)
  assert.equal(f.policy.validateViewerSender(f.event, { windowId: 42 }), true)
  assert.equal(f.policy.validateViewerSender(f.event, { windowId: 99 }), false)
  assert.equal(f.policy.validateViewerSender(f.event, undefined), false)
  f.wc.mainFrame.url = 'http://localhost:3004/email/file-viewer?viewerId=two'
  assert.equal(f.policy.validateSender(f.event, ['viewer']), false)
})

test('navigation allows app routes and callbacks; blocks schemes and external redirects', () => {
  for (const role of ['main', 'app', 'viewer']) {
    const f = fixture(role)
    function navigate(target, redirect = false) {
      let prevented = false
      f.wc.emit(redirect ? 'will-redirect' : 'will-navigate', { preventDefault() { prevented = true } }, target, false, true)
      return prevented
    }
    assert.equal(navigate(f.wc.getURL()), false)
    if (role !== 'viewer') assert.equal(navigate('http://localhost:3004/api/auth/callback/azure-ad'), false)
    for (const url of ['file:///tmp/test', 'javascript:alert(1)', 'data:text/html,x']) assert.equal(navigate(url), true)
    assert.deepEqual(f.external, [])
    assert.equal(navigate('https://example.com', true), true)
    assert.deepEqual(f.external, [])
    assert.equal(navigate('https://example.com'), true)
    assert.deepEqual(f.external, ['https://example.com'])
  }
})

test('email, client and form popouts are registered; print and blob windows have no native authority', () => {
  const f = fixture()
  for (const route of ['/email/popout?id=1', '/clients/abc', '/forms/xyz']) {
    const url = `http://localhost:3004${route}`
    const options = f.wc.popup({ url })
    assert.equal(options.action, 'allow')
    assert.equal(options.overrideBrowserWindowOptions.webPreferences.sandbox, true)
    const child = f.windowAt(url)
    f.wc.emit('did-create-window', child, { url })
    assert.equal(f.policy.validateSender({ sender: child.webContents, senderFrame: child.webContents.mainFrame }), true)
  }
  for (const url of ['about:blank', 'blob:http://localhost:3004/id']) {
    const options = f.wc.popup({ url })
    assert.equal(options.action, 'allow')
    assert.equal(options.overrideBrowserWindowOptions.webPreferences.preload, '')
    const child = f.windowAt(url)
    f.wc.emit('did-create-window', child, { url })
    assert.equal(f.policy.validateSender({ sender: child.webContents, senderFrame: child.webContents.mainFrame }), false)
    assert.equal(child.webContents.popup({ url: 'http://localhost:3004/emails' }).action, 'deny')
    let blocked = false
    child.webContents.emit('will-navigate', { preventDefault() { blocked = true } }, 'http://localhost:3004/emails')
    assert.equal(blocked, true)
  }
  for (const url of ['file:///tmp/x', 'data:text/html,x', 'javascript:alert(1)', 'blob:https://evil.test/id']) assert.equal(f.wc.popup({ url }).action, 'deny')
})

test('permission check and request require the registered trusted main frame and clipboard write', () => {
  const f = fixture()
  const details = { isMainFrame: true, requestingUrl: f.wc.getURL() }
  assert.equal(f.session.check(f.wc, 'clipboard-sanitized-write', 'http://localhost:3004', details), true)
  let granted
  f.session.request(f.wc, 'clipboard-sanitized-write', value => { granted = value }, details)
  assert.equal(granted, true)
  for (const permission of ['clipboard-read', 'notifications', 'media', 'geolocation', 'unknown']) assert.equal(f.session.check(f.wc, permission, 'http://localhost:3004', details), false)
  for (const bad of [{ ...details, isMainFrame: false }, { ...details, requestingUrl: 'https://evil.test' }, {}]) assert.equal(f.session.check(f.wc, 'clipboard-sanitized-write', 'http://localhost:3004', bad), false)
  assert.equal(f.session.check(null, 'clipboard-sanitized-write', 'http://localhost:3004', details), false)
})

test('only unpackaged development accepts a loopback origin override', () => {
  for (const value of ['http://localhost:3004', 'http://127.0.0.1:3004', 'http://[::1]:3004']) {
    assert.equal(resolveBaseUrl({ isPackaged: false, env: { NODE_ENV: 'development', BRINQ_DEV_URL: value } }), value)
  }
  for (const value of ['https://evil.test', 'http://localhost.evil.test:3004', 'file:///tmp', 'http://user@localhost:3004', 'http://localhost:3004/path', 'http://localhost:3004?x=1']) {
    assert.throws(() => resolveBaseUrl({ isPackaged: false, env: { NODE_ENV: 'development', BRINQ_DEV_URL: value } }))
  }
  assert.equal(resolveBaseUrl({ isPackaged: true, env: { NODE_ENV: 'development', BRINQ_DEV_URL: 'http://localhost:3004' } }), 'https://brinq.io')
  assert.equal(resolveBaseUrl({ isPackaged: false, env: {} }), 'https://brinq.io')
})

function tabHost(available = true) {
  const calls = []
  const contents = { id: 'tab' }
  return { calls, contents, available: () => available, openTab(args) { calls.push(args); return contents } }
}

test('ordinary app link and _blank opens become tabs through the tab host', () => {
  for (const role of ['main', 'app']) {
    const f = fixture(role)
    const host = tabHost()
    f.policy.setTabHost(host)
    const url = 'http://localhost:3004/clients/42?view=policies'
    for (const [disposition, background, extra] of [
      ['background-tab', true, {}],
      ['foreground-tab', false, {}],
      ['foreground-tab', false, { frameName: '_blank', features: 'noopener,noreferrer' }],
    ]) {
      const referrer = { url: f.wc.getURL(), policy: 'default' }
      const result = f.wc.popup({ url, disposition, referrer, frameName: '', features: '', ...extra })
      assert.equal(result.action, 'allow')
      assert.equal(result.outlivesOpener, true)
      assert.equal(result.overrideBrowserWindowOptions.webPreferences.sandbox, true)
      assert.equal(result.overrideBrowserWindowOptions.webPreferences.preload, '/preload.js')
      const options = { webPreferences: { openerSandboxFlags: 8 } }
      assert.equal(result.createWindow(options), host.contents)
      const call = host.calls.at(-1)
      assert.equal(call.opener, f.wc)
      assert.equal(call.url, url)
      assert.equal(call.background, background)
      assert.equal(call.options, options)
      assert.equal(call.referrer, referrer)
    }
  }
})

test('pop-outs, posts, other dispositions and non-app openers keep windows', () => {
  const url = 'http://localhost:3004/email/1'
  const windowCases = [
    { disposition: 'new-window' }, { disposition: 'default' }, { disposition: 'other' },
    { disposition: 'foreground-tab', frameName: 'email-1' },
    { disposition: 'foreground-tab', features: 'width=1100,height=700' },
    { disposition: 'foreground-tab', features: 'popup' },
    { disposition: 'background-tab', postBody: { data: [] } },
  ]
  const f = fixture()
  const host = tabHost()
  f.policy.setTabHost(host)
  for (const details of windowCases) {
    const result = f.wc.popup({ url, frameName: '', features: '', ...details })
    assert.equal(result.action, 'allow', JSON.stringify(details))
    assert.equal(result.createWindow, undefined, JSON.stringify(details))
    assert.equal(result.overrideBrowserWindowOptions.width, 1100)
  }
  const unavailable = fixture()
  unavailable.policy.setTabHost(tabHost(false))
  assert.equal(unavailable.wc.popup({ url, disposition: 'background-tab' }).createWindow, undefined)
  assert.equal(fixture().wc.popup({ url, disposition: 'background-tab' }).createWindow, undefined)
  const viewer = fixture('viewer', 'http://localhost:3004/email/file-viewer?viewerId=one')
  viewer.policy.setTabHost(host)
  assert.equal(viewer.wc.popup({ url, disposition: 'background-tab' }).createWindow, undefined)
  for (const target of ['about:blank', 'blob:http://localhost:3004/id', 'https://example.com']) {
    assert.equal(f.wc.popup({ url: target, disposition: 'background-tab' }).createWindow, undefined)
  }
  assert.deepEqual(f.external, ['https://example.com'])
  assert.equal(host.calls.length, 0)
})

test('pages sharing one owner lose authority with it and add one close listener', () => {
  const f = fixture()
  const pages = Array.from({ length: 15 }, (_, index) => {
    const page = f.windowAt(`http://localhost:3004/clients/${index}`).webContents
    f.policy.register(page, 'app', undefined, f.window)
    return page
  })
  assert.equal(f.window.listenerCount('closed'), 1)
  const valid = (wc) => f.policy.validateSender({ sender: wc, senderFrame: wc.mainFrame })
  assert.equal(pages.every(valid), true)
  f.window.destroyed = true
  assert.equal(pages.some(valid), false)
  f.window.destroyed = false
  f.window.emit('closed')
  assert.equal(pages.some(valid), false)
  assert.deepEqual(f.policy.appContents(), [])
})

test('app page enumeration covers tabs and app windows, never viewers or presentations', () => {
  const f = fixture()
  const tab = f.windowAt('http://localhost:3004/clients/1').webContents
  f.policy.register(tab, 'app', undefined, f.window)
  const popout = f.windowAt('http://localhost:3004/email/1')
  f.policy.register(popout.webContents, 'app', undefined, popout)
  const viewer = f.windowAt('http://localhost:3004/email/file-viewer?viewerId=one')
  f.policy.register(viewer.webContents, 'viewer', viewer.webContents.getURL(), viewer)
  const print = f.windowAt('about:blank')
  f.policy.register(print.webContents, 'presentation', undefined, print)
  assert.deepEqual(f.policy.appContents(), [f.wc, tab, popout.webContents])
  tab.emit('did-start-navigation', {}, tab.getURL(), false, true)
  assert.deepEqual(f.policy.appContents(), [f.wc, popout.webContents])
  popout.webContents.emit('destroyed')
  assert.deepEqual(f.policy.appContents(), [f.wc])
})

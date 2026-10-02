const crypto = require('crypto')

// Brinq Desktop can sign in through the system browser, where browser password
// managers work. The PKCE verifier stays in main-process memory; brinq.io only
// sees its S256 challenge and a state value. The browser returns a one-time code
// through brinq://sign-in, and only Home's login page may take code + verifier
// to redeem them with a same-origin request, like password login.
// Fifteen minutes is an unmeasured default for finishing sign-in in the browser;
// on expiry the login page asks the user to start again.
const REQUEST_LIFETIME_MS = 15 * 60 * 1000
const LOGIN_PATH = '/login'

const base64url = (bytes) => Buffer.from(bytes).toString('base64url')

function createBrowserSignIn({ baseUrl, openExternal, now = Date.now, randomBytes = crypto.randomBytes }) {
  let pending = null
  let result = null

  function start() {
    if (pending && pending.expiresAt <= now()) pending = null
    if (!pending) {
      result = null
      const verifier = base64url(randomBytes(32))
      pending = {
        state: base64url(randomBytes(32)),
        verifier,
        challenge: base64url(crypto.createHash('sha256').update(verifier, 'ascii').digest()),
        expiresAt: now() + REQUEST_LIFETIME_MS,
        opening: null,
      }
    }
    const request = pending
    // Double clicks share one browser open.
    if (request.opening) return request.opening
    const url = new URL('/desktop-sign-in', baseUrl)
    url.searchParams.set('challenge', request.challenge)
    url.searchParams.set('state', request.state)
    request.opening = Promise.resolve()
      .then(() => openExternal(url.href))
      .then(
        () => pending === request
          ? { ok: true, expiresAt: request.expiresAt }
          : { ok: false, error: 'This sign-in was cancelled.' },
        () => ({ ok: false, error: 'Brinq could not open your browser. Check your default browser, then try again.' }),
      )
      .finally(() => { request.opening = null })
    return request.opening
  }

  function cancel() {
    pending = null
    result = null
  }

  // Unknown or stale callbacks leave the pending request alone.
  function receive({ code, state }) {
    if (!pending || state !== pending.state) return false
    const request = pending
    pending = null
    result = request.expiresAt > now()
      ? { code, verifier: request.verifier, expiresAt: request.expiresAt }
      : { error: 'expired' }
    return true
  }

  function take() {
    const value = result
    result = null
    if (!value) return null
    if (value.error || value.expiresAt <= now()) return { error: 'expired' }
    return { code: value.code, verifier: value.verifier }
  }

  return { start, cancel, receive, take }
}

function isLoginUrl(value, origin) {
  try {
    const url = new URL(value)
    return url.origin === origin && url.pathname === LOGIN_PATH
  } catch {
    return false
  }
}

// Only Home's live, validated login document holds browser sign-in authority.
function installBrowserSignIn({ ipcMain, security, homeContents, selectHome, baseUrl, openExternal, now, randomBytes }) {
  const origin = new URL(baseUrl).origin
  const signIn = createBrowserSignIn({ baseUrl, openExternal, now, randomBytes })
  const onHomeLogin = (contents, frame = contents?.mainFrame) =>
    !!contents && contents === homeContents() &&
    security.validateSender({ sender: contents, senderFrame: frame }, ['main']) &&
    isLoginUrl(frame.url, origin) && isLoginUrl(contents.getURL(), origin)
  const authorized = (event) => onHomeLogin(event.sender, event.senderFrame)

  ipcMain.handle('browser-sign-in-start', async (event) => {
    if (!authorized(event)) return { ok: false, error: 'Unauthorized sender.' }
    const current = security.captureSender(event, ['main'])
    const outcome = await signIn.start()
    return current() ? outcome : { ok: false, error: 'The sign-in page changed. Start again.' }
  })
  ipcMain.handle('browser-sign-in-cancel', (event) => {
    if (authorized(event)) signIn.cancel()
  })
  ipcMain.handle('browser-sign-in-take', (event) => (authorized(event) ? signIn.take() : null))

  return {
    // Returns true when the callback belonged to this app's pending request.
    receive(data) {
      if (!signIn.receive(data)) return false
      const home = homeContents()
      if (!onHomeLogin(home)) {
        signIn.cancel()
        return true
      }
      selectHome()
      home.loadURL(new URL(`${LOGIN_PATH}?desktopSignIn=complete`, baseUrl).href).catch(() => {})
      return true
    },
    // Leaving login (for example after password sign-in) abandons the request,
    // so a late browser callback cannot replace the chosen account.
    watchHome(contents) {
      const leave = (url) => { if (!isLoginUrl(url, origin)) signIn.cancel() }
      contents.on('did-frame-navigate', (_event, url, _code, _text, isMainFrame) => { if (isMainFrame) leave(url) })
      contents.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) leave(url) })
      contents.once('destroyed', () => signIn.cancel())
    },
  }
}

module.exports = { createBrowserSignIn, installBrowserSignIn, REQUEST_LIFETIME_MS }

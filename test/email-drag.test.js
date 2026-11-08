const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { EventEmitter } = require('node:events')
const { createEmailDrag, emailDragFilename } = require('../src/email-drag')
const { scheduleTempCleanup, RETAIN_MS } = require('../src/temp-cleanup')
const { resolveSource, resolveEmailMessage, SOURCE_KINDS } = require('../src/file-sources')
const { cleanupProfileTemp, MAX_EMAIL_BYTES } = require('../src/attachment-files')
const { createWindowSecurity } = require('../src/window-security')

const BASE = 'http://localhost:3004'
const UID = '0e3a1f00-0000-4000-8000-00000000e001'
const OTHER = '0e3a1f00-0000-4000-8000-00000000e002'
const MIME = Buffer.from('From: sender@example.com\r\nSubject: Renewal\r\n\r\nSynthetic body\r\n')
const HOUR = 60 * 60 * 1000
const tick = () => new Promise(resolve => setTimeout(resolve, 20))

function eml(body = MIME, headers = {}) {
  return new Response(body, { headers: {
    'content-type': 'message/rfc822', 'content-length': String(body.length),
    'content-disposition': 'attachment; filename="Renewal.eml"', ...headers,
  } })
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const syncChmod = (file, mode, done) => { try { fs.chmodSync(file, mode) } catch { /* gone */ } done() }
const syncUnlink = (file, done) => { try { fs.unlinkSync(file); done(null) } catch (error) { done(error) } }

/** A fake clock driving the real retention scheduler. */
function clock() {
  let now = 0
  const timers = []
  return {
    schedule: (fn, ms) => { const timer = { at: now + ms, fn, cleared: false, unref() {} }; timers.push(timer); return timer },
    clear: (timer) => { if (timer) timer.cleared = true },
    async advance(ms) {
      now += ms
      for (let due; (due = timers.find(t => !t.cleared && !t.ran && t.at <= now));) {
        due.ran = true
        due.fn()
        await tick() // chmod/unlink callbacks
      }
    },
  }
}

async function fixture(t, { platform = 'win32', markOrigin, files, icon } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'brinq-drag-test-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const tempDir = path.join(root, 'profile-temp')
  const time = clock()
  const requests = [], drags = [], logs = [], marks = []
  let fetcher = () => eml()
  const security = createWindowSecurity({ baseUrl: BASE, preloadPath: '/preload', openExternal() {} })
  // Desktop's windows share one session (cookies included), as Electron's default session does.
  const session = {
    cookies: new EventEmitter(),
    setPermissionCheckHandler() {}, setPermissionRequestHandler() {},
    fetch: async (url, options) => { requests.push([url, options]); return fetcher(url, options) },
  }
  function addWindow() {
    const sender = new EventEmitter()
    const frame = { url: `${BASE}/emails`, origin: BASE, parent: null, detached: false }
    Object.assign(sender, {
      mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false, setWindowOpenHandler() {},
      session,
      startDrag: (item) => {
        drags.push(item)
        // The file must be complete and closed when Windows reads it.
        assert.ok(fs.readFileSync(item.file).length > 0)
        return sender.onDrag?.(item)
      },
    })
    const owner = new EventEmitter()
    Object.assign(owner, { webContents: sender, isDestroyed: () => false })
    security.register(sender, 'main', undefined, owner)
    return { sender, senderFrame: frame, owner }
  }
  const dragIcon = icon ?? { isEmpty: () => false }
  const drag = createEmailDrag({
    baseUrl: BASE, security, tempDir, platform, icon: dragIcon,
    markOrigin: markOrigin ?? (async (file, origin) => { marks.push([file, origin]); return true }),
    scheduleCleanup: (file, options) => scheduleTempCleanup(file, {
      ...options, schedule: time.schedule, clear: time.clear,
      // Synchronous, so a deletion that starts inside a native drag is visible at once.
      unlinkWith: { chmod: syncChmod, unlink: syncUnlink, schedule: time.schedule },
    }),
    log: fields => logs.push(fields),
    schedule: time.schedule,
    ...(files ? { files } : {}),
  })
  const event = addWindow()
  async function staged() {
    const dir = path.join(tempDir, 'drag')
    try {
      const out = []
      for (const sub of await fsp.readdir(dir)) for (const name of await fsp.readdir(path.join(dir, sub))) out.push(path.join(dir, sub, name))
      return out
    } catch (e) { if (e.code === 'ENOENT') return []; throw e }
  }
  return { root, tempDir, time, requests, drags, logs, marks, drag, event, addWindow, staged, icon: dragIcon, session,
    fetchWith(fn) { fetcher = fn },
    prepare: (uid = UID, ev = event) => drag.prepare(ev, uid),
    start: (uid = UID, ev = event) => drag.start(ev, uid),
  }
}

// ── Authority and input ──────────────────────────────────────────────────────

test('nothing is fetched or written for another platform, a bad sender or a bad email id', async t => {
  const other = await fixture(t, { platform: 'linux' })
  assert.deepEqual(await other.prepare(), { state: 'failed', code: 'unavailable' })
  assert.deepEqual(other.start(), { state: 'failed', code: 'unavailable' })

  const f = await fixture(t)
  const subframe = { ...f.event, senderFrame: { ...f.event.senderFrame, parent: {} } }
  const foreign = { ...f.event, senderFrame: { ...f.event.senderFrame, origin: 'https://evil.test' } }
  const unregistered = { sender: Object.assign(new EventEmitter(), f.event.sender), senderFrame: f.event.senderFrame }
  for (const ev of [subframe, foreign, unregistered]) {
    assert.deepEqual(await f.drag.prepare(ev, UID), { state: 'failed', code: 'unavailable' })
    assert.deepEqual(f.drag.start(ev, UID), { state: 'failed', code: 'unavailable' })
  }
  for (const uid of ['', '../secret', 'http://evil.test/x', 'a\u0000b', { path: '/etc/passwd' }, ['x'], 42, undefined]) {
    assert.deepEqual(await f.drag.prepare(f.event, uid), { state: 'failed', code: 'unavailable' }, String(uid))
    assert.deepEqual(f.drag.start(f.event, uid), { state: 'failed', code: 'unavailable' }, String(uid))
  }
  assert.deepEqual(f.requests, [])
  assert.deepEqual(await f.staged(), [])
})

test('the .eml route is a drag-only source: generic file actions and capabilities never see it', () => {
  assert.equal(resolveEmailMessage(BASE, UID).url, `${BASE}/api/email-sync/emails/${UID}/eml`)
  assert.equal(resolveEmailMessage(BASE, '%2E%2E'), null)
  assert.equal(SOURCE_KINDS.includes('email-message'), false)
  assert.equal(resolveSource(BASE, { kind: 'email-message', emailUid: UID }), null)
})

test('an empty drag icon never reports ready', async t => {
  const f = await fixture(t, { icon: { isEmpty: () => true } })
  assert.deepEqual(await f.prepare(), { state: 'failed', code: 'unavailable' })
  assert.deepEqual(f.requests, [])
})

// ── Staging ──────────────────────────────────────────────────────────────────

test('stages the exact bytes privately, marked, through the page session; the page learns no path', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.prepare(), { state: 'ready' })

  const [[url, options]] = f.requests
  assert.equal(url, `${BASE}/api/email-sync/emails/${UID}/eml`)
  assert.equal(options.credentials, 'include')
  assert.equal(options.redirect, 'error')
  const [file] = await f.staged()
  assert.equal(path.basename(file), 'Renewal.eml')
  assert.deepEqual(fs.readFileSync(file), MIME)
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(f.marks, [[file, BASE]])

  assert.deepEqual(f.start(), { state: 'started' })
  assert.deepEqual(f.drags, [{ file, icon: f.icon }])
  for (const entry of f.logs) assert.doesNotMatch(JSON.stringify(entry), /Renewal|e001|localhost|\.eml/)
})

test('maps every refusal to a safe typed state without saving anything', async t => {
  const cases = [
    [() => json(401, { detail: 'Not authenticated' }), { state: 'failed', code: 'signed-out' }],
    [() => json(403, { detail: 'Forbidden' }), { state: 'failed', code: 'not-found' }],
    [() => json(404, { detail: 'Email not found' }), { state: 'failed', code: 'not-found' }],
    [() => json(409, { detail: { code: 'email_is_draft', message: 'x' } }), { state: 'failed', code: 'draft' }],
    [() => json(409, { detail: { code: 'email_not_ready', message: 'x' } }), { state: 'failed', code: 'not-sent' }],
    [() => json(413, { detail: { code: 'email_too_large', limit_bytes: MAX_EMAIL_BYTES, observed_bytes: MAX_EMAIL_BYTES + 9 } }),
      { state: 'too-large', limitBytes: MAX_EMAIL_BYTES, observedBytes: MAX_EMAIL_BYTES + 9 }],
    [() => json(429, { error: 'Rate limit exceeded: 30 per 1 minute', retry_after_seconds: 41 }), { state: 'failed', code: 'rate-limited', retryAfterSeconds: 41 }],
    [() => json(502, { detail: 'provider-secret-9c1e' }), { state: 'failed', code: 'provider' }],
    [() => Object.defineProperty(eml(), 'redirected', { value: true }), { state: 'failed', code: 'unavailable' }],
    [() => Object.defineProperty(eml(), 'url', { value: 'https://evil.test/x.eml' }), { state: 'failed', code: 'unavailable' }],
    [() => new Response('<!doctype html><title>Sign in</title>', { headers: { 'content-type': 'text/html' } }), { state: 'failed', code: 'signed-out' }],
    [() => new Response(null, { headers: { 'content-type': 'message/rfc822' } }), { state: 'failed', code: 'provider' }],
    [() => eml(MIME, { 'content-length': String(MIME.length + 10) }), { state: 'failed', code: 'provider' }],
    [() => eml(MIME, { 'content-length': '-1' }), { state: 'failed', code: 'provider' }],
    [() => eml(MIME, { 'content-length': 'abc' }), { state: 'failed', code: 'provider' }],
  ]
  for (const [answer, expected] of cases) {
    const f = await fixture(t)
    f.fetchWith(answer)
    const result = await f.prepare()
    assert.deepEqual(result, expected)
    assert.doesNotMatch(JSON.stringify(result), /secret|evil|Sign in/)
    assert.deepEqual(await f.staged(), [])
    assert.equal(f.drags.length, 0)
  }
})

test('accepts MIME parameters, and holds the 25 MiB cap by header and by stream', async t => {
  const f = await fixture(t)
  f.fetchWith(() => eml(MIME, { 'content-type': 'Message/RFC822; charset=utf-8' }))
  assert.deepEqual(await f.prepare(), { state: 'ready' })

  const exact = Buffer.alloc(MAX_EMAIL_BYTES, 0x61)
  const g = await fixture(t)
  g.fetchWith(() => eml(exact))
  assert.deepEqual(await g.prepare(), { state: 'ready' })
  assert.equal(fs.statSync((await g.staged())[0]).size, MAX_EMAIL_BYTES)

  const h = await fixture(t)
  h.fetchWith(() => eml(Buffer.alloc(MAX_EMAIL_BYTES + 1, 0x61)))
  assert.deepEqual(await h.prepare(), { state: 'too-large', limitBytes: MAX_EMAIL_BYTES, observedBytes: MAX_EMAIL_BYTES + 1 })

  // A missing length header cannot carry an oversized stream past the cap.
  const i = await fixture(t)
  i.fetchWith(() => new Response(Buffer.alloc(MAX_EMAIL_BYTES + 1, 0x61), { headers: { 'content-type': 'message/rfc822' } }))
  const result = await i.prepare()
  assert.equal(result.state, 'too-large')
  assert.ok(result.observedBytes > MAX_EMAIL_BYTES)
  assert.deepEqual(await i.staged(), [])
})

test('file protection and disk failures publish nothing', async t => {
  for (const markOrigin of [async () => false, async () => { throw new Error('no ADS') }]) {
    const f = await fixture(t, { markOrigin })
    assert.deepEqual(await f.prepare(), { state: 'failed', code: 'protection' })
    assert.deepEqual(await f.staged(), [])
  }
  for (const failing of ['mkdir', 'open']) {
    const files = { ...fsp, [failing]: async () => { throw Object.assign(new Error('full'), { code: failing === 'open' ? 'EEXIST' : 'ENOSPC' }) } }
    const f = await fixture(t, { files })
    assert.deepEqual(await f.prepare(), { state: 'failed', code: 'disk' })
  }
})

// ── Current email, races and lifecycle ───────────────────────────────────────

function deferredFetch(f) {
  const waiting = []
  f.fetchWith((url, options) => new Promise((resolve, reject) => {
    waiting.push({ url, resolve, reject })
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  }))
  return waiting
}

test('identical prepares share one fetch; switching email aborts the old one at once', async t => {
  const f = await fixture(t)
  const waiting = deferredFetch(f)
  const first = f.prepare(UID)
  const second = f.prepare(UID)
  assert.equal(waiting.length, 1)
  waiting[0].resolve(eml())
  assert.deepEqual(await first, { state: 'ready' })
  assert.deepEqual(await second, { state: 'ready' })
  assert.deepEqual(await f.prepare(UID), { state: 'ready' }) // still current: no refetch
  assert.equal(f.requests.length, 1)

  const g = await fixture(t)
  const pending = deferredFetch(g)
  const a1 = g.prepare(UID)
  const b = g.prepare(OTHER)
  assert.deepEqual(await a1, { state: 'released' }) // aborted immediately
  pending[1].resolve(eml())
  assert.deepEqual(await b, { state: 'ready' })
})

test('A→B→A with late answers never revives stale readiness or deletes the newer file', async t => {
  const f = await fixture(t)
  const pending = deferredFetch(f)
  const a1 = f.prepare(UID)
  const b = f.prepare(OTHER)
  const a2 = f.prepare(UID)
  assert.equal(pending.length, 3)
  pending[2].resolve(eml(Buffer.from('From: newest@example.com\r\n\r\nA2\r\n')))
  assert.deepEqual(await a2, { state: 'ready' })
  assert.deepEqual(await a1, { state: 'released' })
  assert.deepEqual(await b, { state: 'released' })
  await tick()
  const files = await f.staged()
  assert.equal(files.length, 1)
  assert.match(fs.readFileSync(files[0], 'utf8'), /A2/)
  assert.deepEqual(f.start(UID), { state: 'started' })
  assert.deepEqual(f.start(OTHER), { state: 'preparing' })
})

test('release, navigation, a crashed renderer and a closed window end the entry; a subframe or fragment does not', async t => {
  for (const [label, end] of [
    ['release', f => f.prepare(null)],
    ['navigation', f => f.event.sender.emit('did-start-navigation', {}, `${BASE}/home`, false, true)],
    ['renderer gone', f => f.event.sender.emit('render-process-gone', {}, { reason: 'crashed' })],
    ['window closed', f => f.event.sender.emit('destroyed')],
  ]) {
    const f = await fixture(t)
    await f.prepare()
    await end(f)
    await tick()
    assert.deepEqual(await f.staged(), [], `${label}: a never-dragged file is deleted`)
    assert.equal(f.drags.length, 0)
  }
  const f = await fixture(t)
  await f.prepare()
  f.event.sender.emit('did-start-navigation', {}, `${BASE}/emails#thread`, true, true)
  f.event.sender.emit('did-start-navigation', {}, `${BASE}/frame`, false, false)
  assert.deepEqual(f.start(), { state: 'started' })
})

test('after an aborted navigation the page can prepare again; the old entry stays dead', async t => {
  const f = await fixture(t)
  await f.prepare()
  const [old] = await f.staged()
  f.event.sender.emit('did-start-navigation', {}, 'mailto:client@example.com', false, true)
  f.event.sender.emit('did-stop-loading')
  await tick()
  assert.equal(fs.existsSync(old), false)
  assert.deepEqual(f.start(), { state: 'preparing' }) // a new file is fetched; no late drag
  await tick()
  assert.deepEqual(f.start(), { state: 'started' })
  assert.equal(f.requests.length, 2)
})

test("each window has its own current email; one never drags another's file", async t => {
  const f = await fixture(t)
  const second = f.addWindow()
  await f.prepare(UID)
  const [first] = await f.staged()
  assert.deepEqual(f.start(UID, second), { state: 'preparing' })
  assert.deepEqual(f.drags, [])
  assert.deepEqual(await f.prepare(UID, second), { state: 'ready' })
  assert.deepEqual(f.start(UID, second), { state: 'started' })
  assert.notEqual(f.drags[0].file, first)
})

test('a missing staged file or a failing startDrag is reported; a re-prepare recovers', async t => {
  const f = await fixture(t)
  await f.prepare()
  await fsp.rm((await f.staged())[0])
  assert.deepEqual(f.start(), { state: 'preparing' })
  await tick()
  assert.deepEqual(f.start(), { state: 'started' })

  const g = await fixture(t)
  await g.prepare()
  g.event.sender.onDrag = () => { throw new Error('OLE failure') }
  assert.deepEqual(g.start(), { state: 'failed', code: 'unavailable' })
  // The OS may hold it: the file is retained, even past a release.
  const [file] = await g.staged()
  await g.prepare(null)
  assert.ok(fs.existsSync(file))
})

test('a failed cleanup is reported and retried, including one that fails while staging fails', async t => {
  let failures = 1
  const rm = async (...args) => {
    if (failures > 0) { failures -= 1; throw Object.assign(new Error('busy'), { code: 'EBUSY' }) }
    return fsp.rm(...args)
  }
  const f = await fixture(t, { files: { ...fsp, rm } })
  await f.prepare()
  assert.deepEqual(await f.prepare(null), { state: 'failed', code: 'disk' })
  assert.equal((await f.staged()).length, 1, 'still there, still owned')
  await f.time.advance(15000)
  await tick()
  assert.deepEqual(await f.staged(), [], 'the retry removed it')

  // Origin marking fails, then its cleanup fails: the release still knows the file.
  failures = 1
  const g = await fixture(t, { files: { ...fsp, rm }, markOrigin: async () => false })
  assert.deepEqual(await g.prepare(), { state: 'failed', code: 'protection' })
  assert.equal((await g.staged()).length, 1)
  assert.deepEqual(await g.prepare(null), { state: 'released' }) // the release's own attempt succeeds
  assert.deepEqual(await g.staged(), [])
})

test('a sign-out or new sign-in in any window ends every staged email in that session', async t => {
  const f = await fixture(t)
  const popout = f.addWindow()
  await f.prepare(UID)
  await f.prepare(OTHER, popout)
  f.start(OTHER, popout) // handed to the OS: keeps its retention
  const [handed] = f.drags.map(d => d.file)

  f.session.cookies.emit('changed', {}, { name: 'brinq-csrf', domain: 'localhost' }, 'explicit', false)
  f.session.cookies.emit('changed', {}, { name: '__Host-brinq-session', domain: 'other.example' }, 'explicit', true)
  assert.deepEqual(f.start(UID), { state: 'started' }, 'unrelated cookies change nothing')

  f.session.cookies.emit('changed', {}, { name: '__Host-brinq-session', domain: 'localhost' }, 'explicit', true)
  await tick()
  assert.deepEqual(f.start(OTHER, popout), { state: 'preparing' })
  assert.ok(fs.existsSync(handed), 'a file already dragged keeps its 24-hour retention')
  f.session.cookies.emit('changed', {}, { name: 'brinq-session-dev', domain: '.localhost' }, 'overwrite', false)
  await tick()
  assert.equal(f.drags.length, 2, 'no drag starts from a staged file of the earlier session')
})

// ── Retention (DR-1 (A)) ─────────────────────────────────────────────────────

test('a dragged file lives 24 hours after its last drag, through every page event', async t => {
  const f = await fixture(t)
  await f.prepare()
  const [file] = await f.staged()
  f.start()
  await f.time.advance(23 * HOUR)
  assert.deepEqual(f.start(), { state: 'started' }) // a repeat drag reuses the file, no refetch
  assert.equal(f.requests.length, 1)
  // Leaving the email, the page and the window never shortens retention.
  await f.prepare(OTHER)
  f.event.sender.emit('did-start-navigation', {}, `${BASE}/home`, false, true)
  f.event.sender.emit('destroyed')
  await tick()
  await f.time.advance(2 * HOUR) // past the first deadline
  assert.ok(fs.existsSync(file), 'the repeat drag replaced the old deadline')
  await f.time.advance(RETAIN_MS - 2 * HOUR - 1)
  assert.ok(fs.existsSync(file))
  await f.time.advance(1)
  assert.equal(fs.existsSync(file), false)
})

test('expiry makes the file undraggable first, then waits for a native drag in progress', async t => {
  const f = await fixture(t)
  await f.prepare()
  const [file] = await f.staged()
  f.start()
  await f.time.advance(RETAIN_MS)
  assert.equal(fs.existsSync(file), false)
  assert.deepEqual(f.start(), { state: 'preparing' }) // a new gesture prepares a fresh file
  await tick()
  const [fresh] = await f.staged()
  assert.notEqual(fresh, file)

  // The deadline passes while Windows' nested drag loop is still running.
  f.start()
  let duringDrag = null
  f.event.sender.onDrag = () => {
    void f.time.advance(RETAIN_MS) // the expiry callback runs now, inside the drag
    duringDrag = fs.existsSync(fresh)
  }
  f.start()
  assert.equal(duringDrag, true, 'pinned while the drag runs')
  await tick()
  assert.equal(fs.existsSync(fresh), false, 'deleted once the drag ends')
})

test('opened attachments keep the single-argument policy: four delete attempts after 24 hours', async t => {
  const time = clock()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'brinq-cleanup-test-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'opened.pdf')
  fs.writeFileSync(file, 'x')
  const unlinks = []
  const unlink = (target, done) => { unlinks.push(target); done(unlinks.length < 4 ? new Error('busy') : null) }
  const options = { schedule: time.schedule, clear: time.clear, unlinkWith: { chmod: fs.chmod, unlink, schedule: time.schedule } }
  scheduleTempCleanup(file, options)
  await time.advance(RETAIN_MS - 1)
  assert.deepEqual(unlinks, [])
  await time.advance(1)
  for (let i = 0; i < 4; i += 1) await time.advance(15000)
  assert.equal(unlinks.length, 4)
  const cancel = scheduleTempCleanup(file, options)
  cancel()
  await time.advance(RETAIN_MS * 2)
  assert.equal(unlinks.length, 4)
})

test('the startup sweep removes drag leftovers of any age, only for the locked profile', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'brinq-sweep-test-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const mine = path.join(root, 'mine'), other = path.join(root, 'other')
  for (const dir of [mine, other]) {
    fs.mkdirSync(path.join(dir, 'drag', 'abc'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'drag', 'abc', 'Recent.eml'), MIME)
  }
  await cleanupProfileTemp(mine, false)
  assert.ok(fs.existsSync(path.join(mine, 'drag', 'abc', 'Recent.eml')), 'no instance lock: untouched')
  await cleanupProfileTemp(mine, true)
  assert.equal(fs.existsSync(mine), false)
  assert.ok(fs.existsSync(path.join(other, 'drag', 'abc', 'Recent.eml')), 'another profile is never swept')
})

// ── File names ───────────────────────────────────────────────────────────────

test('names the file safely for Windows from the server disposition', () => {
  const name = (disposition) => emailDragFilename(disposition)
  const utf8 = (value) => `attachment; filename="x.eml"; filename*=UTF-8''${encodeURIComponent(value)}`
  assert.equal(name('attachment; filename="Renewal.eml"'), 'Renewal.eml')
  assert.equal(name(null), 'message.eml')
  assert.equal(name('attachment; filename=".eml"'), 'message.eml')
  assert.equal(name(utf8('Ünïcode 日本.eml')), 'Ünïcode 日本.eml')
  const separated = name(utf8('a/b\\c.eml'))
  assert.doesNotMatch(separated, /[\\/]/)
  assert.ok(separated.endsWith('c.eml'))
  assert.equal(name(utf8('Line\r\nbreak.eml')), 'Line__break.eml')
  assert.equal(name(utf8('Say "yes" now.eml')), 'Say _yes_ now.eml')
  assert.equal(name(utf8('report.txt:secret.eml')), 'report.txt_secret.eml')
  assert.equal(name(utf8('Quote. . .eml')), 'Quote.eml')
  for (const device of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9', 'CON.txt', 'nul ']) {
    assert.match(name(utf8(`${device}.eml`)), /^_/, device)
  }
  for (const device of ['COM\u00b9', 'lpt\u00b3']) assert.match(name(utf8(`${device}.eml`)), /^_/, device)
  assert.equal(name(utf8('CONSOLE.eml')), 'CONSOLE.eml')
  const long = name(utf8(`${'日'.repeat(100)}.eml`))
  assert.ok(Buffer.byteLength(long) <= 180)
  assert.ok(long.endsWith('.eml'))
  assert.ok(!long.includes('�'))
})

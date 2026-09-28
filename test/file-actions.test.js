const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { EventEmitter } = require('node:events')
const { randomUUID } = require('node:crypto')
const { createFileActions, MAX_OPEN_BYTES } = require('../src/file-actions')
const { createWindowSecurity } = require('../src/window-security')
const BASE = 'http://localhost:3004'
const SOURCE = { kind: 'ams360-document', clientId: 'client', documentId: 'document', filename: 'hint.pdf' }
const PDF = Buffer.from('%PDF-1.7\nfixture bytes\n%%EOF')
function pdf(extra = {}) { return new Response(PDF, { headers: { 'content-type': 'application/pdf', ...extra } }) }

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brinq-action-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const tempDir = path.join(root, 'private')
  const target = path.join(root, 'saved.pdf')
  const requests = [], opens = [], marks = [], retained = []
  let fetcher = () => pdf()
  const security = createWindowSecurity({ baseUrl: BASE, preloadPath: '/preload', openExternal() {} })
  function addWindow() {
    const sender = new EventEmitter()
    const frame = { url: `${BASE}/clients/one`, origin: BASE, parent: null, detached: false }
    Object.assign(sender, {
      mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false,
      setWindowOpenHandler() {},
      session: {
        setPermissionCheckHandler() {}, setPermissionRequestHandler() {},
        fetch: async (url, options) => { requests.push([url, options]); return fetcher(url, options) },
      },
    })
    const window = new EventEmitter()
    Object.assign(window, { webContents: sender, isDestroyed: () => false })
    security.register(window, 'main')
    return { sender, senderFrame: frame }
  }
  const event = addWindow()
  const actions = createFileActions({
    baseUrl: BASE, security, tempDir, platform: 'linux',
    showSaveDialog: async () => ({ canceled: false, filePath: target }),
    openPath: async file => { opens.push(file); return '' },
    markOrigin: async (file, origin) => { marks.push([file, origin]); return false },
    scheduleCleanup: file => retained.push(file),
    ...overrides,
  })
  async function tempFiles() { try { return await fs.readdir(tempDir) } catch (e) { if (e.code === 'ENOENT') return []; throw e } }
  return { root, tempDir, target, actions, event, addWindow, requests, opens, marks, retained, tempFiles,
    fetchWith(fn) { fetcher = fn },
    open(source = SOURCE, id = randomUUID()) { return actions.open(event, source, id) },
    save(source = SOURCE, id = randomUUID()) { return actions.save(event, source, id) },
  }
}

test('Open streams complete private bytes and invokes the OS once using server filename authority', async t => {
  const f = await fixture(t)
  f.fetchWith(() => pdf({ 'content-disposition': 'attachment; filename="server.pdf"', 'content-length': String(PDF.length) }))
  const result = await f.open({ ...SOURCE, filename: 'renderer.exe' })
  assert.equal(result.ok, true)
  assert.equal(f.opens.length, 1)
  assert.match(f.opens[0], /server\.pdf$/)
  assert.deepEqual(await fs.readFile(f.opens[0]), PDF)
  assert.equal((await fs.stat(f.opens[0])).mode & 0o777, 0o600)
  assert.equal((await fs.stat(f.tempDir)).mode & 0o777, 0o700)
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0][1].credentials, 'include')
  assert.equal(f.requests[0][1].redirect, 'error')
  assert.equal(f.requests[0][1].signal instanceof AbortSignal, true)
  assert.deepEqual(f.retained, f.opens)
  assert.equal(f.marks[0][1], BASE)
})

test('Save As stages beside the chosen target, then replaces it without opening', async t => {
  const f = await fixture(t)
  await fs.writeFile(f.target, 'original')
  assert.equal((await f.save()).ok, true)
  assert.deepEqual(await fs.readFile(f.target), PDF)
  assert.equal(f.opens.length, 0)
  assert.equal(path.dirname(f.marks[0][0]), path.dirname(f.target))
  assert.match(f.marks[0][0], /\.partial$/)
  assert.deepEqual(await fs.readdir(f.root), ['saved.pdf'])
})

test('fresh Brinq storage links are resolved on each action and fetched only through the local proxy', async t => {
  const f = await fixture(t)
  let link = 0
  f.fetchWith(url => url.includes('/api/files/') ? Response.json({ url: `https://cdn.brinq.io/document?signature=${++link}` }) : pdf())
  const source = { kind: 'brinq-file', uid: 'file', filename: 'policy.pdf' }
  assert.equal((await f.open(source)).ok, true)
  assert.equal((await f.open(source)).ok, true)
  assert.equal(f.requests.length, 4)
  for (const [url] of f.requests) assert.equal(new URL(url).origin, BASE)
  assert.notEqual(f.requests[1][0], f.requests[3][0])
})

test('invalid links, malformed/oversized metadata, and redirects never produce a file', async t => {
  for (const response of [Response.json({ url: 'https://evil.test/secret' }), Response.json({ url: 'file:///tmp/a' }), Response.json({}),
    new Response('{broken', { headers: { 'content-type': 'application/json' } }),
    new Response('x'.repeat(65537), { headers: { 'content-type': 'application/json' } }),
    new Response('<html>login', { headers: { 'content-type': 'text/html' } }),
    new Response(null, { status: 302, headers: { location: 'https://evil.test' } })]) {
    const f = await fixture(t)
    f.fetchWith(() => response)
    assert.equal((await f.open({ kind: 'brinq-file', uid: 'one' })).ok, false)
    assert.equal(f.requests.length, 1)
    assert.equal(f.opens.length, 0)
    assert.deepEqual(await f.tempFiles(), [])
  }
  const f = await fixture(t)
  const redirected = pdf()
  Object.defineProperties(redirected, { redirected: { value: true }, url: { value: 'https://evil.test/secret' } })
  f.fetchWith(() => redirected)
  const result = await f.open()
  assert.equal(result.ok, false)
  assert.equal(result.error.includes('secret'), false)
})

test('expired, forbidden and removed files return useful distinct results', async t => {
  for (const [status, code] of [[401, 'session'], [403, 'permission'], [404, 'not-found'], [500, 'network']]) {
    const f = await fixture(t)
    f.fetchWith(() => new Response('private provider details', { status }))
    const result = await f.open()
    assert.equal(result.code, code)
    assert.equal(result.error.includes('private provider'), false)
    assert.equal(f.opens.length, 0)
  }
})

test('Open rejects unsafe extensions, conflicting MIME and renderer-only unknown-byte names', async t => {
  for (const headers of [
    { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="active.exe"' },
    { 'content-type': 'text/html', 'content-disposition': 'attachment; filename="disguised.pdf"' },
    { 'content-type': 'image/png', 'content-disposition': 'attachment; filename="wrong.pdf"' },
    { 'content-type': 'application/octet-stream' },
  ]) {
    const f = await fixture(t)
    f.fetchWith(() => new Response(PDF, { headers }))
    assert.equal((await f.open()).code, 'unsupported')
    assert.equal(f.opens.length, 0)
    assert.deepEqual(await f.tempFiles(), [])
  }
})

test('extensionless AMS PDFs and DOCX get the MIME extension and preserve the server basename', async t => {
  for (const [mime, extension, bytes] of [['application/pdf', 'pdf', PDF], ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx', 'PK fixture']]) {
    const f = await fixture(t)
    f.fetchWith(() => new Response(bytes, { headers: { 'content-type': mime, 'content-disposition': 'attachment; filename="AMS policy"' } }))
    assert.equal((await f.open()).ok, true)
    assert.equal(f.opens[0].endsWith(`AMS policy.${extension}`), true)
  }
})

test('login/error responses are refused while intentional HTML and storage HTML remain Save As only', async t => {
  const f = await fixture(t)
  f.fetchWith(() => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }))
  assert.equal((await f.save()).code, 'session')
  f.fetchWith(() => new Response('<html>login</html>', { headers: { 'content-type': 'application/pdf' } }))
  assert.equal((await f.open()).code, 'session')
  f.fetchWith(() => new Response('<html>saved page</html>', { headers: { 'content-type': 'text/html', 'content-disposition': 'attachment; filename="page.html"' } }))
  assert.equal((await f.open()).code, 'unsupported')
  assert.equal((await f.save()).ok, true)
  f.fetchWith(url => url.includes('/api/files/') ? Response.json({ url: 'https://cdn.brinq.io/page.html' }) : new Response('<html>storage page</html>', { headers: { 'content-type': 'text/html' } }))
  const source = { kind: 'brinq-file', uid: 'file', filename: 'page.html' }
  assert.equal((await f.save(source)).ok, true)
  assert.equal((await f.open(source)).code, 'unsupported')
})

test('partial failures and incorrect lengths preserve an existing save target and remove staging', async t => {
  for (const response of [
    pdf({ 'content-length': String(PDF.length + 1) }), pdf({ 'content-length': '1' }),
    pdf({ 'content-length': '-1' }),
    new Response(new ReadableStream({ start(controller) { controller.enqueue(PDF); controller.error(new Error('private provider failure')) } }), { headers: { 'content-type': 'application/pdf' } }),
  ]) {
    const f = await fixture(t)
    await fs.writeFile(f.target, 'original')
    f.fetchWith(() => response)
    const result = await f.save()
    assert.equal(result.ok, false)
    assert.equal(result.error.includes('private provider'), false)
    assert.equal(await fs.readFile(f.target, 'utf8'), 'original')
    assert.deepEqual(await fs.readdir(f.root), ['saved.pdf'])
    assert.equal(f.opens.length, 0)
  }
})

test('canceled dialog cancels the response and leaves no output', async t => {
  let bodyCanceled = false
  const f = await fixture(t, { showSaveDialog: async () => ({ canceled: true }) })
  f.fetchWith(() => new Response(new ReadableStream({ cancel() { bodyCanceled = true } }), { headers: { 'content-type': 'application/pdf' } }))
  assert.equal((await f.save()).canceled, true)
  assert.equal(bodyCanceled, true)
  assert.deepEqual(await fs.readdir(f.root), [])
})

test('one active operation per window, cancel before headers, and another window cannot cancel it', async t => {
  const f = await fixture(t)
  let started
  const startedPromise = new Promise(resolve => { started = resolve })
  f.fetchWith((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    started()
  }))
  const id = randomUUID()
  const operation = f.open(SOURCE, id)
  await startedPromise
  assert.equal((await f.open()).code, 'busy')
  assert.equal(f.actions.cancel(f.addWindow(), id), false)
  assert.equal(f.actions.cancel(f.event, randomUUID()), false)
  assert.equal(f.actions.cancel(f.event, id), true)
  assert.equal((await operation).canceled, true)
  assert.equal(f.actions.cancel(f.event, id), false)
  f.fetchWith(() => pdf())
  assert.equal((await f.open()).ok, true)
  assert.equal(f.event.sender.listenerCount('did-start-navigation'), 1)
})

test('midstream source replacement cancels writes and cleans partial files', async t => {
  const f = await fixture(t)
  const id = randomUUID()
  let pulls = 0
  f.fetchWith(() => new Response(new ReadableStream({ pull(controller) {
    controller.enqueue(PDF)
    if (++pulls === 3) f.actions.cancel(f.event, id)
  } }), { headers: { 'content-type': 'application/pdf' } }))
  assert.equal((await f.open(SOURCE, id)).canceled, true)
  assert.equal(f.opens.length, 0)
  assert.deepEqual(await f.tempFiles(), [])
})

test('navigation or window destruction aborts an in-flight request', async t => {
  for (const trigger of ['did-start-navigation', 'destroyed']) {
    const f = await fixture(t)
    f.fetchWith((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      queueMicrotask(() => f.event.sender.emit(trigger, {}, `${BASE}/other`, false, true))
    }))
    assert.equal((await f.open()).canceled, true)
    assert.equal(f.opens.length, 0)
  }
})

test('cancellation immediately before native open or save replacement prevents either side effect', async t => {
  for (const mode of ['open', 'save']) {
    let f
    const id = randomUUID()
    f = await fixture(t, { markOrigin: async () => { f.actions.cancel(f.event, id); return true } })
    await fs.writeFile(f.target, 'original')
    assert.equal((await f[mode](SOURCE, id)).canceled, true)
    assert.equal(await fs.readFile(f.target, 'utf8'), 'original')
    assert.equal(f.opens.length, 0)
    assert.deepEqual(await f.tempFiles(), [])
    assert.equal((await fs.readdir(f.root)).some(name => name.endsWith('.partial')), false)
  }
})

test('OS protection or native launch failures clean failed Open files and preserve save targets', async t => {
  for (const mode of ['open', 'save']) {
    const f = await fixture(t, { platform: 'win32', markOrigin: async () => { throw new Error('secret OS path') } })
    await fs.writeFile(f.target, 'original')
    assert.equal((await f[mode]()).code, 'protection')
    assert.equal(await fs.readFile(f.target, 'utf8'), 'original')
    assert.deepEqual(await f.tempFiles(), [])
  }
  for (const openPath of [async () => 'OS internal detail', async () => { throw new Error('OS internal detail') }]) {
    const f = await fixture(t, { openPath })
    const result = await f.open()
    assert.equal(result.code, 'os-open')
    assert.equal(result.error.includes('internal detail'), false)
    assert.deepEqual(await f.tempFiles(), [])
  }
})

test('untrusted frames and malformed operation IDs never fetch or open', async t => {
  const f = await fixture(t)
  const foreign = { ...f.event, senderFrame: { ...f.event.senderFrame } }
  assert.equal((await f.actions.open(foreign, SOURCE, randomUUID())).code, 'permission')
  assert.equal((await f.open(SOURCE, 'not-a-uuid')).code, 'invalid')
  assert.equal((await f.open({ ...SOURCE, url: 'file:///tmp/a' })).code, 'invalid')
  assert.equal(f.requests.length, 0)
})

function generatedResponse(size, onPull = () => {}, declared = true) {
  let sent = 0
  return new Response(new ReadableStream({ pull(controller) {
    onPull()
    if (sent === size) { controller.close(); return }
    const chunk = Buffer.alloc(Math.min(64 * 1024, size - sent), 0x20)
    if (sent === 0) PDF.copy(chunk)
    sent += chunk.length
    controller.enqueue(chunk)
  } }), { headers: { 'content-type': 'application/pdf', ...(declared ? { 'content-length': String(size) } : {}) } })
}

test('50 MiB Open boundary is streamed; larger Save As succeeds without buffering the file', async t => {
  const f = await fixture(t)
  const before = process.memoryUsage()
  let peakRss = before.rss, peakExternal = before.external
  const measure = () => { const value = process.memoryUsage(); peakRss = Math.max(peakRss, value.rss); peakExternal = Math.max(peakExternal, value.external) }
  f.fetchWith(() => generatedResponse(MAX_OPEN_BYTES, measure))
  assert.equal((await f.open()).ok, true)
  assert.equal((await fs.stat(f.opens[0])).size, MAX_OPEN_BYTES)
  f.fetchWith(() => generatedResponse(MAX_OPEN_BYTES + 1, measure))
  const declaredLimit = await f.open()
  assert.equal(declaredLimit.code, 'limit')
  assert.equal(declaredLimit.observedBytes, MAX_OPEN_BYTES + 1)
  f.fetchWith(() => generatedResponse(MAX_OPEN_BYTES + 1, measure, false))
  const streamedLimit = await f.open()
  assert.equal(streamedLimit.code, 'limit')
  assert.equal(streamedLimit.observedBytes, MAX_OPEN_BYTES + 1)
  assert.equal((await f.tempFiles()).length, 1)
  f.fetchWith(() => generatedResponse(MAX_OPEN_BYTES + 1024 * 1024, measure))
  assert.equal((await f.save()).ok, true)
  assert.equal((await fs.stat(f.target)).size, MAX_OPEN_BYTES + 1024 * 1024)
  assert.equal(f.opens.length, 1)
  t.diagnostic(`Generated 50 MiB Open / 51 MiB Save: peak RSS delta ${peakRss - before.rss} bytes; peak external-memory delta ${peakExternal - before.external} bytes. Streams used 64 KiB fixture chunks.`)
})

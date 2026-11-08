const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')
const { validIdentifier, resolveEmailMessage } = require('./file-sources')
const {
  filenameFromContentDisposition, truncateFilenameBytes, ensurePrivateDirectory,
  readResponseWithLimit, markFileAsInternetOrigin, MAX_EMAIL_BYTES,
} = require('./attachment-files')

// Drag the open email out of Brinq as an .eml file
// (brinq-mono research/plans/email-drag-out-desktop.md, D.3).
//
// One current staged email per sender page: `prepare` fetches it through the
// page's own session into a private per-profile directory and marks it as
// downloaded from the internet; `start` hands that file to the OS drag. The
// renderer names only an email uid and never learns a path, URL or provider
// detail.
//
// Retention (DR-1 (A)): a file handed to the OS follows the opened-attachment
// policy. It is deleted 24 hours after its last drag (each drag replaces the
// deadline) and the startup sweep removes leftovers. Leaving the email, the
// page or the app never deletes it early. A staged file never handed to the OS
// is deleted as soon as it stops being current.

const MAX_NOTE_BYTES = 64 * 1024
// Windows device names refuse to be file names, with or without an extension.
const DEVICE_STEM = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const FILENAME_BYTES = 180

class DragFailure extends Error {
  constructor(status) { super(status.code || status.state); this.status = status }
}
const failed = (code, extra = {}) => ({ state: 'failed', code, ...extra })
const refuse = (status) => { throw new DragFailure(status) }

/** A safe Windows file name for the email: one `.eml` basename within the 180-byte budget. */
function emailDragFilename(disposition) {
  // Strips path parts, controls, `<>:"/\\|?*` (the ADS colon included).
  const name = filenameFromContentDisposition(disposition, 'message.eml')
  let stem = name.replace(/\.eml$/i, '').replace(/[. ]+$/, '').trim()
  if (!stem || /^[_. ]+$/.test(stem)) stem = 'message'
  if (DEVICE_STEM.test(stem.split('.')[0].trim())) stem = `_${stem}`
  return truncateFilenameBytes(`${stem}.eml`, FILENAME_BYTES)
}

function isRfc822(contentType) {
  return (contentType || '').split(';')[0].trim().toLowerCase() === 'message/rfc822'
}

async function readNote(response) {
  if (!(response.headers.get('content-type') || '').toLowerCase().includes('application/json')) return null
  try { return JSON.parse((await readResponseWithLimit(response, MAX_NOTE_BYTES)).toString('utf8')) } catch { return null }
}

const safeInt = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : undefined)

function createEmailDrag({
  baseUrl, security, tempDir, scheduleCleanup, icon,
  markOrigin = markFileAsInternetOrigin, platform = process.platform,
  log = () => {}, files = fs.promises,
}) {
  const origin = new URL(baseUrl).origin
  const dragDir = path.join(tempDir, 'drag')
  /** sender webContents -> its current entry */
  const current = new Map()
  /** senders whose lifecycle listeners are attached (once per sender, never per preparation) */
  const watched = new Set()
  /** file path -> { cancel, pins, proceed } for files handed to the OS */
  const handedOff = new Map()
  let nextGeneration = 0

  // `icon` is a nativeImage, or a function returning one (loaded lazily after app ready).
  const dragIcon = () => (typeof icon === 'function' ? icon() : icon)
  const iconReady = () => { try { const image = dragIcon(); return !!image && !image.isEmpty() } catch { return false } }
  const note = (fields) => { try { log({ event: 'email-drag', ...fields }) } catch { /* never changes a result */ } }

  async function removeStaged(entry) {
    if (!entry.dir || handedOff.has(entry.path)) return true
    try {
      await files.rm(entry.dir, { recursive: true, force: true })
      return true
    } catch {
      note({ outcome: 'cleanup-failed' })
      return false
    }
  }

  // Retire the sender's entry: it can never be dragged again. A file already
  // handed to the OS keeps its scheduled deletion; anything else goes now.
  function retire(sender) {
    const entry = current.get(sender)
    if (!entry) return Promise.resolve(true)
    current.delete(sender)
    entry.retired = true
    entry.controller.abort()
    return entry.pending ? entry.pending.then(() => removeStaged(entry)) : removeStaged(entry)
  }

  function watch(sender) {
    if (watched.has(sender)) return
    watched.add(sender)
    const leave = () => { void retire(sender) }
    // A reload or new document (not a fragment or subframe change) ends the entry.
    const navigate = (_event, _url, sameDocument, mainFrame) => { if (mainFrame && !sameDocument) leave() }
    sender.on('did-start-navigation', navigate)
    sender.on('render-process-gone', leave)
    sender.once('destroyed', () => {
      leave()
      sender.removeListener('did-start-navigation', navigate)
      sender.removeListener('render-process-gone', leave)
      watched.delete(sender)
    })
  }

  // Hand-off retention: the latest drag sets the deadline; expiry first makes
  // the file undraggable, then deletes it once no native drag still pins it.
  function retainHandedOff(file) {
    const item = handedOff.get(file) || { cancel: null, pins: 0, proceed: null }
    handedOff.set(file, item)
    item.cancel?.()
    item.proceed = null
    item.cancel = scheduleCleanup(file, {
      onExpire: (proceed) => {
        for (const [sender, entry] of current) {
          if (entry.path === file) { current.delete(sender); entry.retired = true }
        }
        if (item.pins > 0) item.proceed = proceed
        else { handedOff.delete(file); proceed() }
      },
    })
    return item
  }

  async function stage(entry, sender) {
    const started = Date.now()
    const { signal } = entry.controller
    const check = () => {
      if (signal.aborted || entry.retired || current.get(sender) !== entry || !entry.stillAuthorized()) refuse({ state: 'released' })
    }
    let response
    try {
      check()
      response = await sender.session.fetch(entry.url, { credentials: 'include', redirect: 'error', signal })
      check()
      if (response.redirected || (response.url && new URL(response.url).origin !== origin)) refuse(failed('unavailable'))
      if (!response.ok) {
        const body = await readNote(response)
        check()
        const code = body?.detail?.code
        if (response.status === 401) refuse(failed('signed-out'))
        if (response.status === 403 || response.status === 404) refuse(failed('not-found'))
        if (response.status === 409) refuse(failed(code === 'email_is_draft' ? 'draft' : 'not-sent'))
        if (response.status === 413) {
          refuse({ state: 'too-large', limitBytes: safeInt(body?.detail?.limit_bytes) ?? MAX_EMAIL_BYTES,
            ...(safeInt(body?.detail?.observed_bytes) ? { observedBytes: body.detail.observed_bytes } : {}) })
        }
        if (response.status === 429) {
          const wait = safeInt(body?.retry_after_seconds)
          refuse(failed('rate-limited', wait ? { retryAfterSeconds: wait } : {}))
        }
        refuse(failed('provider'))
      }
      // A sign-in page or error JSON is never saved as an email.
      if (!isRfc822(response.headers.get('content-type'))) refuse(failed('signed-out'))
      if (!response.body) refuse(failed('provider'))
      const header = response.headers.get('content-length')
      const declared = header === null ? null : Number(header)
      if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0)) refuse(failed('provider'))
      if (declared !== null && declared > MAX_EMAIL_BYTES) refuse({ state: 'too-large', limitBytes: MAX_EMAIL_BYTES, observedBytes: declared })
      let bytes
      try { bytes = await readResponseWithLimit(response, MAX_EMAIL_BYTES) } catch (error) {
        check()
        if (error?.observedBytes) refuse({ state: 'too-large', limitBytes: MAX_EMAIL_BYTES, observedBytes: error.observedBytes })
        refuse(failed('provider'))
      }
      check()
      // Fetch decodes compressed bodies, whose wire length is not the file length.
      if (!response.headers.get('content-encoding') && declared !== null && bytes.length !== declared) refuse(failed('provider'))
      if (!bytes.length) refuse(failed('provider'))
      const filename = emailDragFilename(response.headers.get('content-disposition'))

      try {
        await ensurePrivateDirectory(tempDir)
        await ensurePrivateDirectory(dragDir)
        check()
        entry.dir = path.join(dragDir, randomUUID())
        await files.mkdir(entry.dir, { mode: 0o700 })
        entry.path = path.join(entry.dir, filename)
        const handle = await files.open(entry.path, 'wx', 0o600)
        try { await handle.writeFile(bytes) } finally { await handle.close() }
      } catch (error) {
        if (error instanceof DragFailure) throw error
        check()
        refuse(failed('disk'))
      }
      check()
      let marked = false
      try { marked = await markOrigin(entry.path, origin) } catch { marked = false }
      // Windows always gets the downloaded-from-the-internet mark, .eml included.
      if (!marked && platform === 'win32') refuse(failed('protection'))
      check()
      entry.state = 'ready'
      note({ outcome: 'ready', bytes: bytes.length, ms: Date.now() - started })
      return { state: 'ready' }
    } catch (error) {
      const status = error instanceof DragFailure ? error.status
        : (signal.aborted || entry.retired) ? { state: 'released' } : failed('unavailable')
      entry.state = status.state
      entry.result = status
      await removeStaged(entry)
      entry.dir = entry.path = null
      note({ outcome: status.code || status.state, ms: Date.now() - started })
      return status
    } finally {
      try { await response?.body?.cancel() } catch { /* already consumed or closed */ }
      entry.pending = null
    }
  }

  async function prepare(event, uid) {
    if (platform !== 'win32' || !security.validateSender(event)) return failed('unavailable')
    const sender = event.sender
    if (uid === null) {
      const removed = await retire(sender)
      return removed ? { state: 'released' } : failed('disk')
    }
    const source = resolveEmailMessage(baseUrl, uid)
    if (!source || !iconReady()) return failed('unavailable')
    const existing = current.get(sender)
    if (existing && existing.uid === uid && !existing.retired && existing.stillAuthorized() &&
        existing.frame === event.senderFrame) {
      // Identical requests share the running preparation or the ready file.
      if (existing.pending) return existing.pending
      if (existing.state === 'ready' && existing.path && fs.existsSync(existing.path)) return { state: 'ready' }
    }
    // The new entry is current at once; the old one is cleaned up behind it.
    void retire(sender)
    watch(sender)
    const entry = {
      uid, url: source.url, generation: ++nextGeneration, state: 'preparing', frame: event.senderFrame,
      controller: new AbortController(), stillAuthorized: security.captureSender(event),
      pending: null, dir: null, path: null, retired: false,
    }
    current.set(sender, entry)
    entry.pending = stage(entry, sender)
    return entry.pending
  }

  // Everything before startDrag is synchronous: Windows needs the drag to start
  // inside the renderer's dragstart, and the file must already exist.
  function start(event, uid) {
    if (platform !== 'win32' || !security.validateSender(event) || !validIdentifier(uid)) return failed('unavailable')
    const sender = event.sender
    const entry = current.get(sender)
    const usable = entry && entry.uid === uid && !entry.retired && entry.state === 'ready' &&
      entry.frame === event.senderFrame && entry.stillAuthorized() && iconReady()
    if (usable && fs.existsSync(entry.path)) {
      const item = retainHandedOff(entry.path)
      item.pins += 1
      try {
        sender.startDrag({ file: entry.path, icon: dragIcon() })
      } catch {
        // The OS may already hold the file; it stays retained conservatively.
        note({ outcome: 'start-failed' })
        return failed('unavailable')
      } finally {
        item.pins -= 1
        if (item.pins === 0 && item.proceed) {
          const proceed = item.proceed
          handedOff.delete(entry.path)
          proceed()
        }
      }
      note({ outcome: 'started' })
      return { state: 'started' }
    }
    // Not ready (or the file is gone): prepare, and never start a drag later.
    if (entry && entry.uid === uid && entry.pending && !entry.retired) return { state: 'preparing' }
    void prepare(event, uid)
    return { state: 'preparing' }
  }

  return { prepare, start, filename: emailDragFilename }
}

module.exports = { createEmailDrag, emailDragFilename }

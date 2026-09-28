const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')
const { Readable, Transform } = require('stream')
const { pipeline } = require('stream/promises')
const { SOURCE_KINDS, resolveSource, storageProxyUrl } = require('./file-sources')
const {
  responseFileInfo, ensurePrivateDirectory, markFileAsInternetOrigin,
  requiresInternetOriginProtection, readResponseWithLimit,
} = require('./attachment-files')

// Preserve the existing email Open envelope. Save As streams without this cap.
const MAX_OPEN_BYTES = 50 * 1024 * 1024
// The existing link owner returns one signed storage URL. 64 KiB gives that
// small JSON contract ample headroom while bounding malformed server responses.
const MAX_METADATA_BYTES = 64 * 1024
const CAPABILITIES = Object.freeze({ version: 1, sourceKinds: SOURCE_KINDS, cancellation: true })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

class FileFailure extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; this.extra = extra }
}
const fail = (code, message, extra) => { throw new FileFailure(code, message, extra) }
const canceled = () => fail('canceled', 'File operation canceled.')

async function cancelBody(response) {
  try { await response?.body?.cancel() } catch { /* Pipeline may already own or close the body. */ }
}

function createFileActions({ baseUrl, security, tempDir, showSaveDialog, openPath,
  markOrigin = markFileAsInternetOrigin, platform = process.platform,
  scheduleCleanup,
}) {
  const active = new Map()
  const origin = new URL(baseUrl).origin

  function cancel(event, operationId) {
    if (!security.validateSender(event)) return false
    const operation = active.get(event.sender)
    if (!operation || operation.id !== operationId || operation.frame !== event.senderFrame) return false
    operation.controller.abort()
    return true
  }

  async function perform(event, source, operationId, mode) {
    if (!security.validateSender(event)) return result('permission', 'This window cannot access native files.')
    const resolved = resolveSource(baseUrl, source)
    if (!resolved || !UUID.test(operationId)) return result('invalid', 'Invalid file request. Refresh the page and try again.')
    if (active.has(event.sender)) return result('busy', 'A file operation is in progress in this window. Try again when it finishes.')
    const operation = { id: operationId, frame: event.senderFrame, controller: new AbortController() }
    active.set(event.sender, operation)
    const signal = operation.controller.signal
    const stillAuthorized = security.captureSender(event)
    const check = () => { if (signal.aborted || !stillAuthorized()) canceled() }
    const abort = () => operation.controller.abort()
    const navigate = (_event, _url, sameDocument, mainFrame) => { if (mainFrame && !sameDocument) abort() }
    event.sender.on('destroyed', abort)
    event.sender.on('did-start-navigation', navigate)
    let response
    let stagingPath
    let stageCreated = false
    let retained = false

    async function fetchResponse(url) {
      check()
      const value = await event.sender.session.fetch(url, { credentials: 'include', redirect: 'error', signal })
      response = value
      check()
      if (value.redirected || (value.url && new URL(value.url).origin !== origin)) fail('network', 'The file request was redirected. Refresh and try again.')
      if (!value.ok) {
        if (value.status === 401) fail('session', 'Your session expired. Sign in and try again.')
        if (value.status === 403) fail('permission', 'You no longer have access to this file. Refresh the page or contact your administrator.')
        if (value.status === 404) fail('not-found', 'This file is no longer available. Refresh the page and try again.')
        fail('network', 'The file could not be downloaded. Try again.')
      }
      return value
    }

    try {
      await fetchResponse(resolved.url)
      if (resolved.storageLink) {
        if (!(response.headers.get('content-type') || '').toLowerCase().includes('application/json')) fail('session', 'The file link is unavailable. Sign in again and retry.')
        const declared = Number(response.headers.get('content-length') || 0)
        if (declared > MAX_METADATA_BYTES) fail('metadata', 'The file link response exceeds the 64 KiB metadata limit. Refresh and try again.', { limitBytes: MAX_METADATA_BYTES, observedBytes: declared })
        let metadata
        try { metadata = JSON.parse((await readResponseWithLimit(response, MAX_METADATA_BYTES)).toString('utf8')) }
        catch (error) { check(); fail('metadata', 'The file link response is invalid or exceeds the 64 KiB metadata limit. Refresh and try again.', { limitBytes: MAX_METADATA_BYTES, ...(error.observedBytes ? { observedBytes: error.observedBytes } : {}) }) }
        const proxyUrl = storageProxyUrl(baseUrl, metadata?.url)
        if (!proxyUrl) fail('metadata', 'The file link is invalid. Refresh the page and try again.')
        await fetchResponse(proxyUrl)
      }
      const info = responseFileInfo(response.headers, resolved.filename)
      const activeMime = info.mime === 'text/html' || info.mime === 'application/xhtml+xml' || info.mime === 'application/json' || info.mime.endsWith('+json')
      if (!resolved.storageLink && activeMime && !info.attachment) fail('session', 'The server returned a page instead of a file. Sign in and try again.')
      if (mode === 'open' && !info.canOpen) fail('unsupported', 'This file type cannot be opened directly. Use Save As to save this file.')
      if (!response.body) fail('network', 'The file response was empty. Try again.')
      const headerLength = response.headers.get('content-length')
      const declared = headerLength === null ? null : Number(headerLength)
      if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0)) fail('network', 'The file size was invalid. Try again.')
      if (mode === 'open' && declared > MAX_OPEN_BYTES) limit(declared)
      let target
      if (mode === 'save') {
        const selection = await showSaveDialog(event.sender, { defaultPath: info.filename })
        check()
        if (selection.canceled || !selection.filePath) canceled()
        target = selection.filePath
        stagingPath = path.join(path.dirname(target), `.brinq-${randomUUID()}.partial`)
      } else {
        await ensurePrivateDirectory(tempDir)
        check()
        stagingPath = path.join(tempDir, `${randomUUID()}-${info.filename}`)
      }
      // Open exclusively before streaming so cleanup never deletes someone else's file.
      const handle = await fs.promises.open(stagingPath, 'wx', 0o600)
      stageCreated = true
      let total = 0
      let prefix = Buffer.alloc(0)
      const measure = new Transform({
        transform(chunk, _encoding, callback) {
          total += chunk.length
          if (prefix.length < 512) prefix = Buffer.concat([prefix, chunk.subarray(0, 512 - prefix.length)])
          if (mode === 'open' && total > MAX_OPEN_BYTES) {
            callback(new FileFailure('limit', 'This file exceeds the 50 MiB Open limit. Use Save As to save this file.', { limitBytes: MAX_OPEN_BYTES, observedBytes: total }))
          } else callback(null, chunk)
        },
      })
      await pipeline(Readable.fromWeb(response.body), measure, handle.createWriteStream(), { signal })
      check()
      // Fetch transparently decompresses encoded responses; their wire length is
      // not the decoded file length. Compare only identity-encoded responses.
      if (!response.headers.get('content-encoding') && declared !== null && total !== declared) fail('network', 'The file download was incomplete. Try again.')
      const text = prefix.toString('utf8').trimStart()
      if (!resolved.storageLink && (!info.attachment || !activeMime) && /^(?:<!doctype\s+html|<html\b|<body\b|\{\s*"(?:error|detail)"\s*:)/i.test(text)) fail('session', 'The server returned an error instead of a file. Sign in and try again.')
      if (mode === 'open' && /^(?:<!doctype\s+html|<html\b|<body\b|\{\s*"(?:error|detail)"\s*:)/i.test(text)) fail('unsupported', 'The downloaded content cannot be opened directly. Use Save As to save this file.')
      try {
        const marked = await markOrigin(stagingPath, origin)
        if (!marked && requiresInternetOriginProtection(info.filename, platform)) fail('protection', 'OS security protection could not be applied. Try Save As on a supported disk.')
      } catch { fail('protection', 'OS security protection could not be applied. Try Save As on a supported disk.') }
      check()
      if (mode === 'open') {
        let error
        try { error = await openPath(stagingPath) } catch { error = true }
        if (error) fail('os-open', 'No application could open this file. Install an application for this file type or use Save As.')
        retained = true
        scheduleCleanup(stagingPath)
      } else {
        await fs.promises.rename(stagingPath, target)
        retained = true
      }
      return { ok: true, code: 'ok', canceled: false, unsafe: false }
    } catch (error) {
      if (signal.aborted || !stillAuthorized()) return result('canceled', 'File operation canceled.')
      if (error instanceof FileFailure) return result(error.code, error.message, error.extra)
      if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) return result('permission', 'The file could not be written. Choose a writable folder and try again.')
      return result('network', 'The file could not be downloaded or saved. Check your connection and available disk space, then try again.')
    } finally {
      await cancelBody(response)
      let cleanupFailed = false
      if (stageCreated && !retained) {
        await fs.promises.rm(stagingPath, { force: true }).catch(() => { cleanupFailed = true })
      }
      event.sender.removeListener('destroyed', abort)
      event.sender.removeListener('did-start-navigation', navigate)
      active.delete(event.sender)
      if (cleanupFailed) return result('cleanup', 'The incomplete local copy could not be removed. Close applications using this file and try again.')
    }
  }
  return {
    open: (event, source, id) => perform(event, source, id, 'open'),
    save: (event, source, id) => perform(event, source, id, 'save'),
    cancel,
  }
}

function result(code, error, extra = {}) {
  return { ok: false, code, error, canceled: code === 'canceled', unsafe: code === 'unsupported', ...extra }
}
function limit(observedBytes) {
  fail('limit', 'This file exceeds the 50 MiB Open limit. Use Save As to save this file.', { limitBytes: MAX_OPEN_BYTES, observedBytes })
}

module.exports = { createFileActions, CAPABILITIES, MAX_OPEN_BYTES }

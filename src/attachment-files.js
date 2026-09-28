const path = require('path')

const SAFE_OPEN_EXTENSIONS = new Set([
  '.pdf',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff',
  '.txt', '.csv',
  '.docx', '.xlsx', '.pptx',
  '.eml', '.msg',
])

// The email viewer parses the complete file in memory and already enforces this cap.
const MAX_EMAIL_BYTES = 25 * 1024 * 1024

function isEmailFilename(filename) {
  return ['.eml', '.msg'].includes(path.extname(filename).toLowerCase())
}

function sanitizeDownloadName(filename, fallback = 'attachment') {
  const fallbackName =
    typeof fallback === 'number' ? `attachment-${fallback}` : fallback
  const base = path.basename(filename || fallbackName)
  return base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || fallbackName
}

function filenameFromContentDisposition(disposition, fallback) {
  if (typeof disposition !== 'string') {
    return sanitizeDownloadName(fallback)
  }

  const extendedMatch = disposition.match(
    /filename\*\s*=\s*([^']*)'[^']*'([^;\r\n]+)/i,
  )
  if (extendedMatch && extendedMatch[1].toLowerCase() === 'utf-8') {
    try {
      return sanitizeDownloadName(decodeURIComponent(extendedMatch[2].trim()))
    } catch {
      return sanitizeDownloadName(extendedMatch[2].trim(), fallback)
    }
  }

  const quotedMatch = disposition.match(
    /filename\s*=\s*"((?:\\.|[^"\\])*)"/i,
  )
  if (quotedMatch) {
    return sanitizeDownloadName(
      quotedMatch[1].replace(/\\(.)/g, '$1'),
      fallback,
    )
  }

  const unquotedMatch = disposition.match(/filename\s*=\s*([^;\r\n]+)/i)
  return sanitizeDownloadName(unquotedMatch?.[1]?.trim(), fallback)
}

function isSafeOpenFilename(filename) {
  return SAFE_OPEN_EXTENSIONS.has(path.extname(filename).toLowerCase())
}

function truncateFilenameBytes(filename, maxBytes) {
  if (Buffer.byteLength(filename, 'utf8') <= maxBytes) return filename

  const extension = path.extname(filename)
  const extensionBytes = Buffer.byteLength(extension, 'utf8')
  const stemBudget = Math.max(1, maxBytes - extensionBytes)
  let stem = ''

  for (const character of Array.from(path.basename(filename, extension))) {
    if (Buffer.byteLength(stem + character, 'utf8') > stemBudget) break
    stem += character
  }

  return `${stem || 'attachment'}${extension}`
}

function buildSyncedAttachmentUrl(baseUrl, emailUid, attachmentId) {
  if (
    !require('./file-sources').validIdentifier(emailUid) ||
    !require('./file-sources').validIdentifier(attachmentId, 4096)
  ) {
    return null
  }

  return (
    `${baseUrl}/api/email-sync/synced-emails/` +
    `${encodeURIComponent(emailUid)}/attachments/` +
    `${encodeURIComponent(attachmentId)}/download`
  )
}

async function readResponseWithLimit(response, maxBytes) {
  if (!response.body) throw new Error('Attachment response was empty.')

  const reader = response.body.getReader()
  const chunks = []
  let totalBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel()
        const error = new Error('Attachment exceeds the 50MB limit.')
        error.observedBytes = totalBytes
        throw error
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }

  return Buffer.concat(chunks, totalBytes)
}

module.exports = {
  buildSyncedAttachmentUrl,
  filenameFromContentDisposition,
  isSafeOpenFilename,
  readResponseWithLimit,
  sanitizeDownloadName,
  truncateFilenameBytes,
  isEmailFilename,
  MAX_EMAIL_BYTES,
}

const MIME_EXTENSIONS = {
  'application/pdf': ['.pdf'],
  'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'],
  'image/gif': ['.gif'], 'image/bmp': ['.bmp'], 'image/webp': ['.webp'],
  'image/tiff': ['.tiff'], 'text/plain': ['.txt', '.csv'], 'text/csv': ['.csv'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
  'message/rfc822': ['.eml'],
  'application/vnd.ms-outlook': ['.msg'],
}

function responseFileInfo(headers, hint) {
  const disposition = headers.get('content-disposition') || ''
  const serverName = filenameFromContentDisposition(disposition, '')
  const authoritative = !!serverName
  const mime = (headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  let filename = serverName || sanitizeDownloadName(hint || 'attachment')
  const extensions = MIME_EXTENSIONS[mime]
  if (!path.extname(filename) && extensions) filename += extensions[0]
  const extension = path.extname(filename).toLowerCase()
  const generic = !mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream'
  return {
    filename: truncateFilenameBytes(filename, 180),
    mime,
    attachment: /^attachment(?:\s*;|\s*$)/i.test(disposition),
    canOpen: isSafeOpenFilename(filename) &&
      (!!extensions?.includes(extension) || (generic && authoritative)),
  }
}

function profileTempDir(tempDir, profile) {
  const { createHash } = require('crypto')
  return path.join(tempDir, `brinq-viewer-${createHash('sha256').update(path.resolve(profile)).digest('hex')}`)
}

async function ensurePrivateDirectory(directory) {
  const fs = require('fs').promises
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const stats = await fs.lstat(directory)
  if (!stats.isDirectory() || stats.isSymbolicLink() ||
      (typeof process.getuid === 'function' && stats.uid !== process.getuid())) {
    throw new Error('Attachment temp path is not a private directory.')
  }
  if (process.platform !== 'win32') await fs.chmod(directory, 0o700)
}

async function cleanupProfileTemp(directory, hasInstanceLock) {
  if (hasInstanceLock) await require('fs').promises.rm(directory, { recursive: true, force: true })
}

async function markFileAsInternetOrigin(filePath, sourceUrl, {
  platform = process.platform,
  writeFile = require('fs').promises.writeFile,
  execFile = require('util').promisify(require('child_process').execFile),
} = {}) {
  if (platform === 'win32') {
    await writeFile(`${filePath}:Zone.Identifier`,
      `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${new URL(sourceUrl).origin}\r\n`, { mode: 0o600 })
    return true
  }
  if (platform === 'darwin') {
    const timestamp = Math.floor(Date.now() / 1000).toString(16)
    const quarantine = `0083;${timestamp};Brinq;${require('crypto').randomUUID()}`
    await execFile('/usr/bin/xattr', ['-w', 'com.apple.quarantine', quarantine, filePath])
    return true
  }
  return false
}

function requiresInternetOriginProtection(filename, platform = process.platform) {
  return ['win32', 'darwin'].includes(platform) &&
    ['.csv', '.docx', '.xlsx', '.pptx'].includes(path.extname(filename).toLowerCase())
}

Object.assign(module.exports, {
  responseFileInfo, profileTempDir, ensurePrivateDirectory, cleanupProfileTemp,
  markFileAsInternetOrigin, requiresInternetOriginProtection,
})

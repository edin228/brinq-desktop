const path = require('path')

const SAFE_OPEN_EXTENSIONS = new Set([
  '.pdf',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff',
  '.txt', '.csv',
  '.docx', '.xlsx', '.pptx',
])

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
    typeof emailUid !== 'string' ||
    !emailUid.trim() ||
    emailUid.length > 512 ||
    typeof attachmentId !== 'string' ||
    !attachmentId.trim() ||
    attachmentId.length > 4096
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
        throw new Error('Attachment exceeds the 50MB limit.')
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
}

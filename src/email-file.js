// Parses .eml and .msg files for the Brinq email viewer. Pure Node: no Electron.
const fs = require('fs')
const path = require('path')
const { simpleParser } = require('mailparser')
const MsgReader = require('@kenjiuno/msgreader').default
const { decompressRTF } = require('@kenjiuno/decompressrtf')
const { deEncapsulateSync } = require('rtf-stream-parser')
const iconv = require('iconv-lite')
const { sanitizeDownloadName, MAX_EMAIL_BYTES } = require('./attachment-files')
const { msgAddresses } = require('./msg-addresses')

function escapeHtml(text = '') {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// .msg file helpers
// ---------------------------------------------------------------------------
function decodeRtfText(value, charset) {
  const source = Buffer.isBuffer(value) ? value : Buffer.from(value)
  const encoding =
    charset && iconv.encodingExists(charset) ? charset : 'windows-1252'
  return iconv.decode(source, encoding)
}

function normalizeCid(value = '') {
  return String(value).trim().replace(/^<|>$/g, '').toLowerCase()
}

function replaceCidUrls(html, cidMap) {
  return html.replace(/cid:([^"'\s)]+)/gi, (match, rawCid) => {
    return cidMap.get(normalizeCid(rawCid)) || match
  })
}

async function parseMsgFile(buffer) {
  let reader
  let data

  try {
    reader = new MsgReader(buffer)
    // Exposes the sent-representing name/address msgreader does not map.
    reader.parserConfig = { includeRawProps: true }
    data = reader.getFileData()
  } catch {
    throw new Error(
      'This email file could not be parsed. It may be malformed or use an unsupported format.',
    )
  }

  if (!data || data.error) {
    throw new Error(
      'This email file could not be parsed. It may be malformed or use an unsupported format.',
    )
  }

  if (
    data.messageClass &&
    !String(data.messageClass).toLowerCase().startsWith('ipm.note')
  ) {
    throw new Error('This .msg file is not an email message.')
  }

  // --- Body extraction pipeline ---
  // Priority: HTML string → HTML bytes → de-encapsulated RTF HTML → plain text
  let bodyHtml = null
  let bodyText = data.body || ''

  if (data.bodyHtml) {
    bodyHtml = data.bodyHtml
  } else if (data.html?.length) {
    bodyHtml = Buffer.from(data.html).toString('utf-8')
  }

  if (!bodyHtml && data.compressedRtf?.length) {
    try {
      const rtfBytes = decompressRTF(data.compressedRtf)
      const result = deEncapsulateSync(Buffer.from(rtfBytes), {
        decode: (value, charset) => decodeRtfText(value, charset),
      })

      if (result.mode === 'html' && result.text) {
        bodyHtml =
          typeof result.text === 'string'
            ? result.text
            : Buffer.from(result.text).toString('utf-8')
      } else if (result.mode === 'text' && result.text && !bodyText) {
        bodyText =
          typeof result.text === 'string'
            ? result.text
            : decodeRtfText(result.text)
      }
    } catch {
      // RTF may be malformed or may not contain encapsulated HTML/text
    }
  }

  // --- Attachments and CID resolution ---
  const visibleAttachments = []
  const cidMap = new Map()

  for (const [sourceIndex, att] of (data.attachments || []).entries()) {
    let attachment
    try {
      attachment = reader.getAttachment(att)
    } catch {
      continue
    }

    const contentBuffer = attachment?.content
      ? Buffer.from(attachment.content)
      : Buffer.alloc(0)
    const filename =
      attachment?.fileName ||
      att.fileName ||
      att.fileNameShort ||
      `attachment-${sourceIndex}`
    const contentType = att.attachMimeTag || 'application/octet-stream'
    const normalizedCid = normalizeCid(att.pidContentId)

    if (normalizedCid && contentBuffer.length > 0) {
      cidMap.set(
        normalizedCid,
        `data:${contentType};base64,${contentBuffer.toString('base64')}`,
      )
    }

    if (att.attachmentHidden) continue

    const attachmentIndex = visibleAttachments.length
    visibleAttachments.push({
      raw: {
        content: contentBuffer,
        filename,
        contentType,
      },
      metadata: {
        index: attachmentIndex,
        filename: sanitizeDownloadName(filename, attachmentIndex),
        size: contentBuffer.length,
        contentType,
      },
    })
  }

  if (bodyHtml && cidMap.size > 0) {
    bodyHtml = replaceCidUrls(bodyHtml, cidMap)
  }

  if (!bodyHtml) {
    bodyHtml = `<pre>${escapeHtml(bodyText)}</pre>`
  }

  // --- Addresses: SMTP only, never an Exchange X.500 legacyDN ---
  const { from, to, cc, bcc } = await msgAddresses(data, { simpleParser })

  const dateStr = data.clientSubmitTime || data.messageDeliveryTime || null
  let date = null
  if (dateStr) {
    const parsedDate = new Date(dateStr)
    if (!Number.isNaN(parsedDate.getTime())) {
      date = parsedDate.toISOString()
    }
  }

  return {
    metadata: {
      subject: data.subject || '(No Subject)',
      from,
      to,
      cc,
      bcc,
      date,
      bodyHtml,
      text: bodyText,
      attachments: visibleAttachments.map((entry) => entry.metadata),
    },
    rawAttachments: visibleAttachments.map((entry) => entry.raw),
  }
}

// ---------------------------------------------------------------------------
// Email file parsing — routes .eml and .msg
// ---------------------------------------------------------------------------
async function parseEmailFile(filePath) {
  const stats = await fs.promises.stat(filePath)
  if (!stats.isFile()) throw new Error('Selected path is not a file.')
  if (stats.size > MAX_EMAIL_BYTES) {
    throw new Error(
      `Email file exceeds ${MAX_EMAIL_BYTES / (1024 * 1024)} MiB limit.`,
    )
  }

  const buffer = await fs.promises.readFile(filePath)
  const ext = path.extname(filePath).toLowerCase()

  if (ext === '.msg') {
    return await parseMsgFile(buffer)
  }

  // .eml parsing
  let parsed
  try {
    parsed = await simpleParser(buffer)
  } catch {
    throw new Error(
      'This email file could not be parsed. It may be malformed or use an unsupported format.',
    )
  }

  const attachments = (parsed.attachments || []).map((a, index) => ({
    index,
    filename: sanitizeDownloadName(a.filename, index),
    size: a.size || 0,
    contentType: a.contentType || 'application/octet-stream',
  }))

  return {
    metadata: {
      subject: parsed.subject || '(No Subject)',
      from: parsed.from?.value || [],
      to: parsed.to?.value || [],
      cc: parsed.cc?.value || [],
      bcc: parsed.bcc?.value || [],
      date: parsed.date?.toISOString() || null,
      bodyHtml:
        parsed.html ||
        parsed.textAsHtml ||
        `<pre>${escapeHtml(parsed.text || '')}</pre>`,
      text: parsed.text || '',
      attachments,
    },
    rawAttachments: parsed.attachments || [],
  }
}

module.exports = { parseEmailFile }

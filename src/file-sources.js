// These routes mirror the authenticated Next API owners. Renderer input never
// supplies a URL, request method, credentials, or headers.
const SOURCE_FIELDS = {
  'brinq-file': ['uid'],
  'ams360-attachment': ['clientId', 'uid'],
  'ams360-document': ['clientId', 'documentId'],
  'ams360-activity-attachment': ['clientId', 'activityId', 'ref', 'refKind'],
  'marketing-attachment': ['projectUid', 'uid'],
  'sms-attachment': ['uid'],
  'synced-email-attachment': ['emailUid', 'attachmentId'],
  'client-email-attachment': ['clientId', 'emailUid', 'attachmentId'],
}
const SOURCE_KINDS = Object.freeze(Object.keys(SOURCE_FIELDS))

function validIdentifier(value, maxLength = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) return false
  try { encodeURIComponent(value) } catch { return false }
  let decoded = value
  // Nested encodings must not turn opaque IDs into traversal or control bytes.
  while (true) {
    if (/[\x00-\x1f\x7f]/.test(decoded) || /^[a-z][a-z\d+.-]*:/i.test(decoded) ||
        decoded.split(/[\\/]/).some(part => part === '.' || part === '..')) return false
    let next
    try { next = decodeURIComponent(decoded) } catch { return !/%[0-9a-f]{2}/i.test(decoded) }
    if (next === decoded) return true
    decoded = next
  }
}

function resolveSource(baseUrl, source) {
  const fields = source && Object.hasOwn(SOURCE_FIELDS, source.kind) && SOURCE_FIELDS[source.kind]
  if (!fields || typeof source !== 'object' || Array.isArray(source) ||
      Object.keys(source).some(key => !['kind', 'filename', ...fields].includes(key)) ||
      fields.some(key => !validIdentifier(source[key], key === 'attachmentId' ? 4096 : 512)) ||
      (source.filename !== undefined && typeof source.filename !== 'string')) return null
  if (source.kind === 'ams360-activity-attachment' && !['attachment', 'data'].includes(source.refKind)) return null
  const ids = Object.fromEntries(fields.map(key => [key, encodeURIComponent(source[key])]))
  let route
  switch (source.kind) {
    case 'brinq-file': route = `/api/files/${ids.uid}`; break
    case 'ams360-attachment': route = `/api/clients/${ids.clientId}/ams360-attachments/${ids.uid}/data`; break
    case 'ams360-document': route = `/api/clients/${ids.clientId}/ams360-documents/${ids.documentId}/data`; break
    case 'ams360-activity-attachment': route = `/api/clients/${ids.clientId}/ams360-activities/${ids.activityId}/attachments/${ids.ref}/data?kind=${ids.refKind}`; break
    case 'marketing-attachment': route = `/api/marketing-projects/${ids.projectUid}/attachments/${ids.uid}/download`; break
    case 'sms-attachment': route = `/api/messaging/sms/attachments/${ids.uid}/download`; break
    case 'synced-email-attachment': route = `/api/email-sync/synced-emails/${ids.emailUid}/attachments/${ids.attachmentId}/download`; break
    // A client's email read through client visibility, not mailbox ownership.
    case 'client-email-attachment': route = `/api/email-sync/clients/${ids.clientId}/emails/${ids.emailUid}/attachments/${ids.attachmentId}/download`; break
  }
  return { url: new URL(route, baseUrl).href, storageLink: source.kind === 'brinq-file' || source.kind === 'marketing-attachment', filename: source.filename }
}

// The open email as an .eml file, for the email drag-out only (email-drag.js).
// It is not a SOURCE_KINDS entry: the generic open/save/view file actions and
// their capability list never offer it, so the page cannot turn it into a
// renderer-chosen download. Reading it needs read access to the email.
const EMAIL_MESSAGE_KIND = 'email-message'
function resolveEmailMessage(baseUrl, emailUid) {
  if (!validIdentifier(emailUid)) return null
  return { kind: EMAIL_MESSAGE_KIND, url: new URL(`/api/email-sync/emails/${encodeURIComponent(emailUid)}/eml`, baseUrl).href }
}

// Brinq keeps files in one DigitalOcean Spaces bucket, `brinq` in sfo2, and
// its presigned links are path-style (sfo2.digitaloceanspaces.com/brinq/…).
// This mirrors frontend/utils/brinqStorageUrl.ts, which the web
// /api/download-proxy enforces; keep the two aligned.
const BRINQ_SPACES_BUCKET = 'brinq'
const BRINQ_SPACES_HOST = 'sfo2.digitaloceanspaces.com'
const BUCKET_HOSTS = new Set([
  `${BRINQ_SPACES_BUCKET}.${BRINQ_SPACES_HOST}`,
  `${BRINQ_SPACES_BUCKET}.sfo2.cdn.digitaloceanspaces.com`,
])

// The parsed link when it names an object in Brinq's bucket, else null.
function brinqStorageUrl(value) {
  if (typeof value !== 'string') return null
  let url
  try { url = new URL(value) } catch { return null }
  // The parser lowercases the host, drops the default port and resolves dot
  // segments (encoded ones too), so exact comparisons below are safe.
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
  if (BUCKET_HOSTS.has(url.hostname)) return url
  // The path-style host serves every bucket; the first segment is the bucket.
  // Its key must hold no dot segment even after percent-decoding.
  if (url.hostname !== BRINQ_SPACES_HOST || !url.pathname.startsWith(`/${BRINQ_SPACES_BUCKET}/`)) return null
  let key
  try { key = decodeURIComponent(url.pathname.slice(BRINQ_SPACES_BUCKET.length + 2)) } catch { return null }
  return key.split('/').some(segment => segment === '.' || segment === '..') ? null : url
}

function storageProxyUrl(baseUrl, value) {
  const url = brinqStorageUrl(value)
  if (!url) return null
  const proxy = new URL('/api/download-proxy', baseUrl)
  proxy.searchParams.set('url', url.href)
  return proxy.href
}

module.exports = { SOURCE_KINDS, EMAIL_MESSAGE_KIND, validIdentifier, resolveSource, resolveEmailMessage, storageProxyUrl }

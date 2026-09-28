// These routes mirror the authenticated Next API owners. Renderer input never
// supplies a URL, request method, credentials, or headers.
const SOURCE_FIELDS = {
  'brinq-file': ['uid'],
  'ams360-attachment': ['clientId', 'uid'],
  'ams360-document': ['clientId', 'documentId'],
  'synced-email-attachment': ['emailUid', 'attachmentId'],
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
  const ids = Object.fromEntries(fields.map(key => [key, encodeURIComponent(source[key])]))
  let route
  switch (source.kind) {
    case 'brinq-file': route = `/api/files/${ids.uid}`; break
    case 'ams360-attachment': route = `/api/clients/${ids.clientId}/ams360-attachments/${ids.uid}/data`; break
    case 'ams360-document': route = `/api/clients/${ids.clientId}/ams360-documents/${ids.documentId}/data`; break
    case 'synced-email-attachment': route = `/api/email-sync/synced-emails/${ids.emailUid}/attachments/${ids.attachmentId}/download`; break
  }
  return { url: new URL(route, baseUrl).href, storageLink: source.kind === 'brinq-file', filename: source.filename }
}

function storageProxyUrl(baseUrl, value) {
  if (typeof value !== 'string') return null
  let url
  try { url = new URL(value) } catch { return null }
  // Keep this list aligned with frontend/pages/api/download-proxy.ts.
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      ![/\.digitaloceanspaces\.com$/i, /(^|\.)s3([.-][a-z0-9-]+)?\.amazonaws\.com$/i,
        /^cdn\.brinq\.io$/i].some(pattern => pattern.test(url.hostname))) return null
  const proxy = new URL('/api/download-proxy', baseUrl)
  proxy.searchParams.set('url', url.href)
  return proxy.href
}

module.exports = { SOURCE_KINDS, validIdentifier, resolveSource, storageProxyUrl }

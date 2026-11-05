// Display addresses for an Outlook .msg, as read by @kenjiuno/msgreader with
// `parserConfig.includeRawProps`. Internal Exchange senders and recipients
// carry an X.500 legacyDN ("/O=EXCHANGELABS/...") as their email address; only
// an SMTP address is ever shown, otherwise the display name alone.
const SMTP = /^[^\s@<>"()[\],;:]+@[^\s@<>"()[\],;:]+\.[^\s@<>"()[\],;:]+$/

// An X.500 legacyDN can end in something address-shaped
// ("/o=Org/.../cn=user@example.com"); it is never an SMTP address.
const LEGACY_DN = /^\/|\/cn=/i

function smtpAddress(...candidates) {
  for (const candidate of candidates) {
    const value = typeof candidate === 'string' ? candidate.trim().replace(/^smtp:/i, '') : ''
    if (!LEGACY_DN.test(value) && SMTP.test(value)) return value
  }
  return ''
}

// Root properties msgreader does not name: PidTagSentRepresentingName (0x0042)
// and PidTagSentRepresentingEmailAddress (0x0065), in PT_UNICODE or PT_STRING8.
function rawString(data, id) {
  const value = data.rawProps?.find((prop) => prop.propertyTag?.startsWith(id))?.value
  return typeof value === 'string' ? value.trim() : ''
}

// A display name can itself be a legacyDN when Outlook had nothing better.
const displayName = (value) => {
  const name = typeof value === 'string' ? value.trim() : ''
  return /^\/o=/i.test(name) ? '' : name
}

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && !!a.trim() &&
  a.trim().toLowerCase() === b.trim().toLowerCase()

// Received mail keeps its RFC 5322 headers (PidTagTransportMessageHeaders).
async function transportHeaders(headers, simpleParser) {
  if (typeof headers !== 'string' || !headers.trim()) return {}
  try {
    return await simpleParser(`${headers.trim()}\r\n\r\n`)
  } catch {
    return {}
  }
}

async function msgAddresses(data, { simpleParser }) {
  const header = await transportHeaders(data.headers, simpleParser)
  const headerList = (field) => (Array.isArray(header[field]?.value) ? header[field].value : [])

  // Outlook shows the sent-representing mailbox as From. The sender is that
  // mailbox only when their addresses say so (a delegate can share its display
  // name), so only then may the sender's address stand in for it.
  const representingName = displayName(rawString(data, '0042'))
  const representingEmail = rawString(data, '0065')
  const representingSmtp = typeof data.sentRepresentingSmtpAddress === 'string' ? data.sentRepresentingSmtpAddress.trim() : ''
  const hasRepresenting = !!(representingName || representingEmail || representingSmtp)
  const senderIsMailbox = !hasRepresenting ||
    [representingEmail, representingSmtp].some((own) =>
      same(own, data.senderEmail) || same(own, data.senderSmtpAddress))
  const fromHeaders = headerList('from')
  const name = representingName || (senderIsMailbox ? displayName(data.senderName) : '') ||
    (fromHeaders.length === 1 ? displayName(fromHeaders[0].name) : '')
  // The transport From header is the author, i.e. the represented mailbox.
  const headerFrom = fromHeaders.length === 1 &&
    (!name || !fromHeaders[0].name || same(fromHeaders[0].name, name)) ? fromHeaders[0] : null
  const address = smtpAddress(
    representingSmtp,
    representingEmail,
    headerFrom?.address,
    ...(senderIsMailbox ? [data.senderSmtpAddress, data.senderEmail] : []),
  )
  const from = name || address ? [{ name, address }] : []

  // A header address is borrowed by display name only when that name is
  // unambiguous both among the header's entries and among the recipient rows.
  const nameCounts = (names) => names.reduce((counts, value) => {
    const key = (value || '').trim().toLowerCase()
    if (key) counts.set(key, (counts.get(key) || 0) + 1)
    return counts
  }, new Map())
  const recipientType = (recipient) => (recipient.recipType === 'cc' || recipient.recipType === 'bcc' ? recipient.recipType : 'to')
  const known = {}
  for (const type of ['to', 'cc', 'bcc']) {
    const entries = headerList(type).filter((entry) => entry.name && entry.address)
    const headerCounts = nameCounts(entries.map((entry) => entry.name))
    const rowCounts = nameCounts((data.recipients || []).filter((r) => recipientType(r) === type).map((r) => displayName(r.name)))
    known[type] = new Map(entries
      .filter((entry) => headerCounts.get(entry.name.trim().toLowerCase()) === 1 &&
        rowCounts.get(entry.name.trim().toLowerCase()) === 1)
      .map((entry) => [entry.name.trim().toLowerCase(), entry.address]))
  }
  const recipients = { to: [], cc: [], bcc: [] }
  for (const recipient of data.recipients || []) {
    const type = recipientType(recipient)
    const recipientName = displayName(recipient.name)
    const entry = {
      name: recipientName,
      address: smtpAddress(recipient.smtpAddress, recipient.email, known[type].get(recipientName.toLowerCase())),
    }
    if (entry.name || entry.address) recipients[type].push(entry)
  }
  return { from, ...recipients }
}

module.exports = { msgAddresses, smtpAddress }

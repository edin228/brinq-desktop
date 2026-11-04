// Display addresses for an Outlook .msg, as read by @kenjiuno/msgreader with
// `parserConfig.includeRawProps`. Internal Exchange senders and recipients
// carry an X.500 legacyDN ("/O=EXCHANGELABS/...") as their email address; only
// an SMTP address is ever shown, otherwise the display name alone.
const SMTP = /^[^\s@<>"()[\],;:]+@[^\s@<>"()[\],;:]+\.[^\s@<>"()[\],;:]+$/

function smtpAddress(...candidates) {
  for (const candidate of candidates) {
    const value = typeof candidate === 'string' ? candidate.trim().replace(/^smtp:/i, '') : ''
    if (SMTP.test(value)) return value
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

const sameName = (a, b) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()

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

  // Outlook shows the sent-representing mailbox as From; the sender differs
  // only when a delegate sent on its behalf.
  const representing = displayName(rawString(data, '0042'))
  const senderName = displayName(data.senderName)
  const name = representing || senderName || displayName(headerList('from')[0]?.name)
  const delegate = !!representing && !!senderName && !sameName(representing, senderName)
  const headerFrom = headerList('from').find((entry) => !name || !entry.name || sameName(entry.name, name))
  const address = smtpAddress(
    data.sentRepresentingSmtpAddress,
    rawString(data, '0065'),
    headerFrom?.address,
    ...(delegate ? [] : [data.senderSmtpAddress, data.senderEmail]),
  )
  const from = name || address ? [{ name, address }] : []

  const headerAddresses = (field) => new Map(headerList(field)
    .filter((entry) => entry.name && entry.address)
    .map((entry) => [entry.name.trim().toLowerCase(), entry.address]))
  const known = { to: headerAddresses('to'), cc: headerAddresses('cc'), bcc: headerAddresses('bcc') }
  const recipients = { to: [], cc: [], bcc: [] }
  for (const recipient of data.recipients || []) {
    const type = recipient.recipType === 'cc' || recipient.recipType === 'bcc' ? recipient.recipType : 'to'
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

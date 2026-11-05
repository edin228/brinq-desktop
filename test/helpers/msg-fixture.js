// Writes a minimal Outlook .msg (MS-OXMSG compound file) from scratch, so tests
// never need real mail. Strings are PT_UNICODE substorage streams.
const CFB = require('cfb')

const u16 = (text) => Buffer.from(`${text}`, 'utf16le')
const tag = (id) => `__substg1.0_${id}001F`

function propertyEntry(id, type, value) {
  const entry = Buffer.alloc(16)
  entry.writeUInt32LE(((id << 16) | type) >>> 0, 0)
  entry.writeUInt32LE(0x6, 4) // readable | writable
  entry.writeUInt32LE(value, 8)
  return entry
}

function buildMsg({
  messageClass = 'IPM.Note', subject = 'Fixture subject', body = 'Fixture body',
  sender = {}, representing = {}, headers, recipients = [],
} = {}) {
  const cfb = CFB.utils.cfb_new()
  const add = (name, content) => CFB.utils.cfb_add(cfb, `/${name}`, content)
  const rootHeader = Buffer.alloc(32)
  rootHeader.writeUInt32LE(recipients.length, 8)
  rootHeader.writeUInt32LE(0, 12)
  rootHeader.writeUInt32LE(recipients.length, 16)
  add('__properties_version1.0', rootHeader)
  const strings = {
    '001A': messageClass, '0037': subject, 1000: body,
    '0C1A': sender.name, '0C1E': sender.addressType, '0C1F': sender.email, '5D01': sender.smtp,
    '0042': representing.name, '0064': representing.addressType, '0065': representing.email, '5D02': representing.smtp,
    '007D': headers,
  }
  for (const [id, value] of Object.entries(strings)) if (value !== undefined) add(tag(id), u16(value))
  recipients.forEach((recipient, index) => {
    const dir = `__recip_version1.0_#${index.toString(16).toUpperCase().padStart(8, '0')}`
    const type = { to: 1, cc: 2, bcc: 3 }[recipient.type || 'to']
    add(`${dir}/__properties_version1.0`, Buffer.concat([Buffer.alloc(8), propertyEntry(0x0C15, 0x0003, type)]))
    const fields = { 3001: recipient.name, 3002: recipient.addressType, 3003: recipient.email, '39FE': recipient.smtp }
    for (const [id, value] of Object.entries(fields)) if (value !== undefined) add(`${dir}/${tag(id)}`, u16(value))
  })
  return Buffer.from(CFB.write(cfb, { type: 'buffer', fileType: 'cfb' }))
}

module.exports = { buildMsg }

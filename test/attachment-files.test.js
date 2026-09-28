const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildSyncedAttachmentUrl,
  filenameFromContentDisposition,
  isSafeOpenFilename,
  readResponseWithLimit,
  sanitizeDownloadName,
  truncateFilenameBytes,
} = require('../src/attachment-files')

test('sanitizes provider filenames without allowing path traversal', () => {
  assert.equal(sanitizeDownloadName('../../policy?.pdf'), 'policy_.pdf')
  assert.equal(sanitizeDownloadName('', 3), 'attachment-3')
})

test('prefers an RFC 5987 filename from content disposition', () => {
  assert.equal(
    filenameFromContentDisposition(
      `attachment; filename="fallback.pdf"; filename*=UTF-8''Policy%20R%C3%A9sum%C3%A9.pdf`,
      'attachment',
    ),
    'Policy Résumé.pdf',
  )
})

test('accepts whitespace, casing, and language in RFC 5987 filenames', () => {
  assert.equal(
    filenameFromContentDisposition(
      `attachment; FILENAME* = utf-8'en'Policy%20Final.pdf`,
      'attachment',
    ),
    'Policy Final.pdf',
  )
})

test('preserves semicolons and quoted pairs in quoted filenames', () => {
  assert.equal(
    filenameFromContentDisposition(
      'attachment; filename="Q1; \\"final\\".pdf"',
      'attachment',
    ),
    'Q1; _final_.pdf',
  )
})

test('recognizes only the direct-open extension allowlist', () => {
  assert.equal(isSafeOpenFilename('POLICY.DOCX'), true)
  assert.equal(isSafeOpenFilename('scan.pdf'), true)
  assert.equal(isSafeOpenFilename('received-email.EML'), true)
  assert.equal(isSafeOpenFilename('Outlook message.MSG'), true)
  assert.equal(isSafeOpenFilename('macro.docm'), false)
  assert.equal(isSafeOpenFilename('installer.exe'), false)
  assert.equal(isSafeOpenFilename('archive.zip'), false)
})

test('truncates UTF-8 filenames by bytes while preserving the extension', () => {
  const result = truncateFilenameBytes(`${'é'.repeat(200)}.pdf`, 40)

  assert.ok(Buffer.byteLength(result, 'utf8') <= 40)
  assert.equal(result.endsWith('.pdf'), true)
})

test('constructs a same-origin URL with opaque identifiers encoded', () => {
  assert.equal(
    buildSyncedAttachmentUrl('https://brinq.io', 'email/1', 'A/B?C#D'),
    'https://brinq.io/api/email-sync/synced-emails/email%2F1/attachments/A%2FB%3FC%23D/download',
  )
  assert.equal(buildSyncedAttachmentUrl('https://brinq.io', '', 'att-1'), null)
})

test('reads a streamed response without crossing the byte limit', async () => {
  const response = new Response(new Uint8Array([1, 2, 3, 4]))

  assert.deepEqual(await readResponseWithLimit(response, 4), Buffer.from([1, 2, 3, 4]))
})

test('aborts a streamed response as soon as it exceeds the byte limit', async () => {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        controller.enqueue(new Uint8Array([4, 5, 6]))
        controller.close()
      },
    }),
  )

  await assert.rejects(
    readResponseWithLimit(response, 5),
    /Attachment exceeds the 50MB limit/,
  )
})

const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const {
  responseFileInfo, profileTempDir, cleanupProfileTemp, ensurePrivateDirectory,
  markFileAsInternetOrigin, requiresInternetOriginProtection,
} = require('../src/attachment-files')

test('server names and compatible MIME govern opening, including extensionless AMS names', () => {
  function info(mime, disposition, hint = 'hint.pdf') {
    const headers = new Headers({ 'content-type': mime })
    if (disposition) headers.set('content-disposition', disposition)
    return responseFileInfo(headers, hint)
  }
  assert.equal(info('application/pdf', 'attachment; filename="AMS policy"').filename, 'AMS policy.pdf')
  assert.equal(info('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'attachment; filename="AMS policy"').filename, 'AMS policy.docx')
  assert.equal(info('application/pdf', undefined).canOpen, true)
  assert.equal(info('application/octet-stream', undefined).canOpen, false)
  assert.equal(info('application/octet-stream', 'attachment; filename=""').canOpen, false)
  assert.equal(info('application/octet-stream', 'attachment; filename="server.pdf"').canOpen, true)
  assert.equal(info('application/pdf', 'attachment; filename="server.exe"').canOpen, false)
  assert.equal(info('text/html', 'attachment; filename="server.pdf"').canOpen, false)
  assert.equal(info('image/png', 'attachment; filename="server.pdf"').canOpen, false)
  assert.equal(info('application/pdf', 'attachment; filename="server.pdf"', 'hint.exe').canOpen, true)
  assert.equal(info('message/rfc822', undefined, 'received-email.eml').canOpen, true)
  assert.equal(info('application/vnd.ms-outlook', 'attachment; filename="Outlook message.MSG"').canOpen, true)
  assert.equal(info('application/octet-stream', 'attachment; filename="fax.EML"').canOpen, true)
  assert.equal(info('application/octet-stream', 'attachment; filename="fax.MSG"').canOpen, true)
  assert.equal(info('application/octet-stream', undefined, 'fax.msg').canOpen, false)
  assert.equal(info('text/html', 'attachment; filename="fax.eml"').canOpen, false)
  assert.equal(info('application/pdf', 'attachment; filename="fax.msg"').canOpen, false)
})

test('profile cleanup cannot affect another profile or run without the instance lock', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brinq-profile-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const first = profileTempDir(root, '/profiles/first')
  const second = profileTempDir(root, '/profiles/second')
  assert.notEqual(first, second)
  for (const dir of [first, second]) { await ensurePrivateDirectory(dir); await fs.writeFile(path.join(dir, 'keep'), 'bytes') }
  await cleanupProfileTemp(first, false)
  assert.equal(await fs.readFile(path.join(first, 'keep'), 'utf8'), 'bytes')
  await cleanupProfileTemp(first, true)
  await assert.rejects(fs.stat(first), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(second, 'keep'), 'utf8'), 'bytes')
})

test('private temporary directory rejects symlinks', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brinq-dir-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const link = path.join(root, 'link')
  await fs.symlink(root, link)
  await assert.rejects(ensurePrivateDirectory(link), /private directory/)
})

test('Windows zone and macOS quarantine adapters use fixed safe provenance', async () => {
  const writes = [], commands = []
  assert.equal(await markFileAsInternetOrigin('/tmp/document', 'https://brinq.io/file?secret=token', { platform: 'win32', writeFile: async (...args) => writes.push(args) }), true)
  assert.equal(writes[0][0], '/tmp/document:Zone.Identifier')
  assert.match(writes[0][1], /ZoneId=3/)
  assert.match(writes[0][1], /HostUrl=https:\/\/brinq.io\r\n/)
  assert.equal(writes[0][1].includes('secret'), false)
  assert.equal(await markFileAsInternetOrigin('/tmp/document', 'https://brinq.io', { platform: 'darwin', execFile: async (...args) => commands.push(args) }), true)
  assert.equal(commands[0][0], '/usr/bin/xattr')
  assert.equal(commands[0][1][1], 'com.apple.quarantine')
  assert.equal(commands[0][1][3], '/tmp/document')
  assert.equal(await markFileAsInternetOrigin('/tmp/document', 'https://brinq.io', { platform: 'linux' }), false)
  assert.equal(requiresInternetOriginProtection('policy.docx', 'win32'), true)
  assert.equal(requiresInternetOriginProtection('policy.docx', 'linux'), false)
})

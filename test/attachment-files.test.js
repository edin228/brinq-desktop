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

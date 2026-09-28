const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveSource, storageProxyUrl, SOURCE_KINDS } = require('../src/file-sources')
const base = 'http://localhost:3004'

test('source identities select existing canonical Next routes without slash redirects', () => {
  const cases = [
    [{ kind: 'brinq-file', uid: 'file-uid' }, '/api/files/file-uid', true],
    [{ kind: 'ams360-attachment', clientId: 'client', uid: 'stored-uid' }, '/api/clients/client/ams360-attachments/stored-uid/data', false],
    [{ kind: 'ams360-document', clientId: 'client', documentId: 'DocAId' }, '/api/clients/client/ams360-documents/DocAId/data', false],
    [{ kind: 'synced-email-attachment', emailUid: 'email', attachmentId: 'A/B?C#D' }, '/api/email-sync/synced-emails/email/attachments/A%2FB%3FC%23D/download', false],
  ]
  assert.equal(SOURCE_KINDS.length, cases.length)
  for (const [source, route, storageLink] of cases) {
    assert.deepEqual(resolveSource(base, source), { url: base + route, storageLink, filename: undefined })
  }
})

test('unknown kinds, source confusion, traversal and renderer authority are rejected', () => {
  for (const source of [null, [], {}, { kind: 'toString' }, { kind: 'unknown' },
    { kind: 'ams360-document', clientId: 'client', uid: 'stored' },
    { kind: 'ams360-attachment', clientId: 'client', documentId: 'doc' }]) assert.equal(resolveSource(base, source), null)
  for (const uid of ['', ' ', '.', '..', '../path', 'a/../b', '%2e%2e', '%252e%252e', '%2e%2e%2fpath', '\\..\\file', 'https://evil.test', 'file:///tmp/x', 'a\0b', 'a%0Ab', '\ud800']) {
    assert.equal(resolveSource(base, { kind: 'brinq-file', uid }), null, uid)
  }
  for (const field of ['url', 'headers', 'method', 'cookie', 'token', 'path', 'bytes']) {
    assert.equal(resolveSource(base, { kind: 'brinq-file', uid: 'valid', [field]: 'malicious' }), null)
  }
})

test('only HTTPS storage links returned by source owners enter the same-origin proxy', () => {
  for (const url of ['https://brinq.sfo2.digitaloceanspaces.com/file?signature=secret', 'https://bucket.s3.us-east-1.amazonaws.com/file', 'https://cdn.brinq.io/file']) {
    const proxy = new URL(storageProxyUrl(base, url))
    assert.equal(proxy.origin, base)
    assert.equal(proxy.pathname, '/api/download-proxy')
    assert.equal(proxy.searchParams.get('url'), url)
  }
  for (const url of ['http://cdn.brinq.io/file', 'https://cdn.brinq.io.evil.test/file', 'https://evil.test/file', 'https://user:password@cdn.brinq.io/file', 'https://cdn.brinq.io:8443/file', '//cdn.brinq.io/file', 'file:///tmp/x', null]) {
    assert.equal(storageProxyUrl(base, url), null)
  }
})

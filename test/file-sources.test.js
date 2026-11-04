const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveSource, storageProxyUrl, SOURCE_KINDS } = require('../src/file-sources')
const base = 'http://localhost:3004'

test('source identities select existing canonical Next routes without slash redirects', () => {
  const cases = [
    [{ kind: 'brinq-file', uid: 'file-uid' }, '/api/files/file-uid', true],
    [{ kind: 'ams360-attachment', clientId: 'client', uid: 'stored-uid' }, '/api/clients/client/ams360-attachments/stored-uid/data', false],
    [{ kind: 'ams360-document', clientId: 'client', documentId: 'DocAId' }, '/api/clients/client/ams360-documents/DocAId/data', false],
    [{ kind: 'ams360-activity-attachment', clientId: 'client', activityId: 'activity +', ref: 'ref/&', refKind: 'attachment' }, '/api/clients/client/ams360-activities/activity%20%2B/attachments/ref%2F%26/data?kind=attachment', false],
    [{ kind: 'marketing-attachment', projectUid: 'project/&', uid: 'attachment +' }, '/api/marketing-projects/project%2F%26/attachments/attachment%20%2B/download', true],
    [{ kind: 'sms-attachment', uid: 'stored-uid' }, '/api/messaging/sms/attachments/stored-uid/download', false],
    [{ kind: 'synced-email-attachment', emailUid: 'email', attachmentId: 'A/B?C#D' }, '/api/email-sync/synced-emails/email/attachments/A%2FB%3FC%23D/download', false],
    [{ kind: 'client-email-attachment', clientId: '42', emailUid: 'email', attachmentId: 'A/B?C#D' }, '/api/email-sync/clients/42/emails/email/attachments/A%2FB%3FC%23D/download', false],
  ]
  assert.equal(SOURCE_KINDS.length, cases.length)
  for (const [source, route, storageLink] of cases) {
    assert.deepEqual(resolveSource(base, source), { url: base + route, storageLink, filename: undefined })
  }
})

test('unknown kinds, source confusion, traversal and renderer authority are rejected', () => {
  for (const source of [null, [], {}, { kind: 'toString' }, { kind: 'unknown' },
    { kind: 'ams360-document', clientId: 'client', uid: 'stored' },
    { kind: 'ams360-attachment', clientId: 'client', documentId: 'doc' },
    { kind: 'client-email-attachment', emailUid: 'email', attachmentId: 'id' },
    { kind: 'client-email-attachment', clientId: '../42', emailUid: 'email', attachmentId: 'id' }]) assert.equal(resolveSource(base, source), null)
  for (const uid of ['', ' ', '.', '..', '../path', 'a/../b', '%2e%2e', '%252e%252e', '%2e%2e%2fpath', '\\..\\file', 'https://evil.test', 'file:///tmp/x', 'a\0b', 'a%0Ab', '\ud800']) {
    assert.equal(resolveSource(base, { kind: 'brinq-file', uid }), null, uid)
  }
  for (const field of ['url', 'headers', 'method', 'cookie', 'token', 'path', 'bytes']) {
    assert.equal(resolveSource(base, { kind: 'brinq-file', uid: 'valid', [field]: 'malicious' }), null)
  }
})

test('only links into Brinq\'s storage bucket enter the same-origin proxy (aligned with the web check)', () => {
  for (const url of [
    'https://sfo2.digitaloceanspaces.com/brinq/agency/1/file.pdf?X-Amz-Signature=secret',
    'https://brinq.sfo2.digitaloceanspaces.com/agency/file.pdf?signature=secret',
    'https://brinq.sfo2.cdn.digitaloceanspaces.com/agency/file.pdf',
    'https://SFO2.DigitalOceanSpaces.com/brinq/upload%5Cname.pdf',
    'https://sfo2.digitaloceanspaces.com:443/brinq/file',
  ]) {
    const proxy = new URL(storageProxyUrl(base, url))
    assert.equal(proxy.origin, base)
    assert.equal(proxy.pathname, '/api/download-proxy')
    assert.equal(proxy.searchParams.get('url'), new URL(url).href, url)
  }
  for (const url of [
    // Hosts the old pre-check admitted: other buckets, other regions, S3, the CDN alias.
    'https://other.sfo2.digitaloceanspaces.com/file',
    'https://brinq.nyc3.digitaloceanspaces.com/file',
    'https://nyc3.digitaloceanspaces.com/brinq/file',
    'https://sfo2.digitaloceanspaces.com/other/file',
    'https://sfo2.digitaloceanspaces.com/brinqx/file',
    'https://sfo2.digitaloceanspaces.com/brinq',
    'https://bucket.s3.us-east-1.amazonaws.com/file',
    'https://cdn.brinq.io/file',
    // Leaving the bucket through the key, decoded or not.
    'https://sfo2.digitaloceanspaces.com/brinq/%2e%2e/other/file',
    'https://sfo2.digitaloceanspaces.com/brinq/a/%2E%2E%2Fb',
    'https://sfo2.digitaloceanspaces.com/brinq/%E0%A4%A',
    // Scheme, credentials, port and lookalike hosts.
    'http://sfo2.digitaloceanspaces.com/brinq/file',
    'https://user:password@sfo2.digitaloceanspaces.com/brinq/file',
    'https://sfo2.digitaloceanspaces.com:8443/brinq/file',
    'https://sfo2.digitaloceanspaces.com.evil.test/brinq/file',
    'https://brinq.sfo2.digitaloceanspaces.com.evil.test/file',
    '//sfo2.digitaloceanspaces.com/brinq/file',
    'https://evil.test/file', 'file:///tmp/x', '', null, 42,
  ]) {
    assert.equal(storageProxyUrl(base, url), null, String(url))
  }
})


test('AMS detail reference kind is explicit and cannot be confused with stored or document sources', () => {
  const source = { kind: 'ams360-activity-attachment', clientId: '1', activityId: 'transaction', ref: 'DataId', refKind: 'data' }
  assert.equal(resolveSource(base, source).url, base + '/api/clients/1/ams360-activities/transaction/attachments/DataId/data?kind=data')
  for (const refKind of [undefined, '', 'Data', 'document', 'attachment&kind=data']) assert.equal(resolveSource(base, { ...source, refKind }), null)
  for (const invalid of [
    { ...source, uid: 'stored' }, { ...source, kind: 'ams360-document' },
    { kind: 'marketing-attachment', uid: 'file-uid' },
    { kind: 'marketing-attachment', projectUid: 'project', attachmentId: 'attachment' },
    { kind: 'sms-attachment', uid: 'stored', download_url: 'https://provider.test/file' },
    { kind: 'sms-attachment', uid: 'https://provider.test/file' },
    { kind: 'sms-attachment', url: '/api/messaging/sms/shared-files/capability' },
  ]) assert.equal(resolveSource(base, invalid), null)
})

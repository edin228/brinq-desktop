const test = require('node:test')
const assert = require('node:assert/strict')
const { sanitizedLogger, cleanText } = require('../src/update-log')

test('update logs keep the first line, without stacks, feeds or URL queries', () => {
  const lines = []
  const logger = sanitizedLogger({ info: (...args) => lines.push(['info', ...args]), warn() {}, error: (...args) => lines.push(['error', ...args]), debug() {} })
  const feed = Object.assign(new Error('Cannot parse releases feed: Error: bad\n    at parse (x.js:1:1),\nXML:\n<feed><entry>secret</entry></feed>'), { code: 'ERR_UPDATER_INVALID_RELEASE_FEED' })
  logger.error(feed)
  logger.info('Download https://objects.githubusercontent.com/x/Brinq-Setup.exe?X-Amz-Signature=abc&token=s3cr3t#frag done')
  logger.error(`Error: ${new Error('offline').stack}`)
  logger.info({ kept: true })
  assert.deepEqual(lines, [
    ['error', 'Error: Cannot parse releases feed: Error: bad (ERR_UPDATER_INVALID_RELEASE_FEED)'],
    ['info', 'Download https://objects.githubusercontent.com/x/Brinq-Setup.exe done'],
    ['error', 'Error: Error: offline'],
    ['info', { kept: true }],
  ])
})

test('very long messages are cut short', () => {
  const text = cleanText('x'.repeat(1000))
  assert.equal(text.length, 301)
  assert.ok(text.endsWith('…'))
})

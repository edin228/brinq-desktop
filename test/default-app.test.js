const test = require('node:test')
const assert = require('node:assert/strict')
const { createDefaultAppResolver, regString } = require('../src/default-app')

const FILE_EXTS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts'
// reg.exe output as Windows prints it (CRLF, four-space separators).
const out = (key, name, value) => `\r\n${key}\r\n    ${name}    REG_SZ    ${value}\r\n\r\n`
const missing = () => Object.assign(new Error('ERROR: The system was unable to find the specified registry key or value.'), { code: 1 })

function resolver(registry) {
  const calls = []
  const execFile = async (file, args) => {
    assert.equal(file, 'reg')
    calls.push(args.slice(1).join(' '))
    const key = args[1]
    if (!(key in registry)) throw missing()
    const value = registry[key]
    if (value instanceof Error) throw value
    return { stdout: value }
  }
  return { defaultApp: createDefaultAppResolver({ execFile }), calls }
}

test('the user choice wins, including the newer UserChoiceLatest key', async () => {
  const latest = `${FILE_EXTS}\\.msg\\UserChoiceLatest`
  const { defaultApp } = resolver({
    [latest]: out(latest, 'ProgId', 'Outlook.File.msg.15'),
    [`${FILE_EXTS}\\.msg\\UserChoice`]: out('x', 'ProgId', 'Brinq.EmailFile'),
    'HKCR\\Outlook.File.msg.15': '\r\nHKEY_CLASSES_ROOT\\Outlook.File.msg.15\r\n',
  })
  assert.deepEqual(await defaultApp('.MSG'), { kind: 'app', progId: 'Outlook.File.msg.15' })
})

test('Brinq as the default mail app is recognized without opening another process', async () => {
  const choice = `${FILE_EXTS}\\.eml\\UserChoice`
  const { defaultApp, calls } = resolver({ [choice]: out(choice, 'ProgId', 'Brinq.EmailFile') })
  assert.deepEqual(await defaultApp('.eml'), { kind: 'brinq', progId: 'Brinq.EmailFile' })
  assert.equal(calls.some((call) => call.startsWith('HKCR\\Brinq')), false)
})

test('without a user choice, the registered class decides; a localized default name still parses', async () => {
  const { defaultApp } = resolver({
    'HKCR\\.msg': out('HKEY_CLASSES_ROOT\\.msg', '(Standard)', 'Outlook.File.msg.15'),
    'HKCR\\Outlook.File.msg.15': 'HKEY_CLASSES_ROOT\\Outlook.File.msg.15\r\n',
  })
  assert.deepEqual(await defaultApp('.msg'), { kind: 'app', progId: 'Outlook.File.msg.15' })
})

test('no default, or a default whose app is gone, is reported as none so Brinq can show the file', async () => {
  assert.deepEqual(await resolver({}).defaultApp('.msg'), { kind: 'none' })
  const { defaultApp } = resolver({ 'HKCR\\.msg': out('HKEY_CLASSES_ROOT\\.msg', '(Default)', 'Outlook.File.msg.15') })
  assert.deepEqual(await defaultApp('.msg'), { kind: 'none', progId: 'Outlook.File.msg.15' })
})

test('registry failures and unexpected values keep the plain OS open', async () => {
  const choice = `${FILE_EXTS}\\.msg\\UserChoiceLatest`
  assert.deepEqual(await resolver({ [choice]: Object.assign(new Error('timeout'), { killed: true }) }).defaultApp('.msg'), { kind: 'unknown' })
  assert.deepEqual(await resolver({ [choice]: out(choice, 'ProgId', 'Applications\\notepad.exe') }).defaultApp('.msg'), { kind: 'unknown' })
  assert.deepEqual(await resolver({}).defaultApp('.m$g'), { kind: 'unknown' })
})

test('regString reads the first string value, or a named one', () => {
  const text = '\r\nHKEY\\Key\r\n    Hash    REG_SZ    abc\r\n    ProgId    REG_SZ    Outlook.File.msg.15\r\n'
  assert.equal(regString(text, 'ProgId'), 'Outlook.File.msg.15')
  assert.equal(regString(text), 'abc')
  assert.equal(regString('nothing here'), '')
})

// Runs only on Windows (PR CI uses windows-latest): the real reg.exe output.
test('live Windows registry: text files have a default app, an unknown type has none', { skip: process.platform !== 'win32' }, async () => {
  const execFile = require('util').promisify(require('child_process').execFile)
  const defaultApp = createDefaultAppResolver({ execFile })
  assert.equal((await defaultApp('.txt')).kind, 'app')
  assert.equal((await defaultApp('.brinqnone')).kind, 'none')
})

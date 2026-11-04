// Windows only: which app would open a file type, read the way Explorer
// resolves it. The user's choice (UserChoiceLatest on newer Windows 11, else
// UserChoice) wins; otherwise the class registered for the extension. The
// class must still exist, or Windows would show its "How do you want to open
// this file?" picker instead of opening anything.
//
// Result kinds: 'brinq' (Brinq's own Open with entry), 'app' (another app),
// 'none' (Windows has no default and would ask), 'unknown' (could not read
// the registry; callers keep the plain OS open).
const BRINQ_EMAIL_PROGID = 'Brinq.EmailFile' // build/installer.nsh
const FILE_EXTS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts'
const PROG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const EXTENSION = /^\.[a-z0-9]{1,12}$/

// reg.exe prints `    <name>    REG_SZ    <value>`; the name of a default value
// is localized ("(Default)", "(Standard)"), so match on the type only.
function regString(stdout, name) {
  for (const line of String(stdout).split(/\r?\n/)) {
    const match = line.match(/^\s+(.+?)\s{4}REG_(?:EXPAND_)?SZ\s{4}(.*)$/)
    if (match && (name === undefined || match[1].trim().toLowerCase() === name.toLowerCase())) {
      return match[2].trim()
    }
  }
  return ''
}

function createDefaultAppResolver({ execFile, timeoutMs = 2000 }) {
  // reg.exe exits 1 when a key or value is missing; that is an answer, not a failure.
  async function query(args) {
    try {
      const { stdout } = await execFile('reg', ['query', ...args], { timeout: timeoutMs, windowsHide: true })
      return { found: true, stdout }
    } catch (error) {
      if (error && error.code === 1) return { found: false, stdout: '' }
      throw error
    }
  }

  return async function defaultApp(extension) {
    const ext = String(extension || '').toLowerCase()
    if (!EXTENSION.test(ext)) return { kind: 'unknown' }
    try {
      let progId = ''
      for (const key of ['UserChoiceLatest', 'UserChoice']) {
        const choice = await query([`${FILE_EXTS}\\${ext}\\${key}`, '/v', 'ProgId'])
        progId = choice.found ? regString(choice.stdout, 'ProgId') : ''
        if (progId) break
      }
      if (!progId) {
        const registered = await query([`HKCR\\${ext}`, '/ve'])
        progId = registered.found ? regString(registered.stdout) : ''
      }
      if (!progId) return { kind: 'none' }
      if (!PROG_ID.test(progId)) return { kind: 'unknown' }
      if (progId.toLowerCase() === BRINQ_EMAIL_PROGID.toLowerCase()) return { kind: 'brinq', progId }
      const handler = await query([`HKCR\\${progId}`])
      return handler.found ? { kind: 'app', progId } : { kind: 'none', progId }
    } catch {
      return { kind: 'unknown' }
    }
  }
}

module.exports = { createDefaultAppResolver, regString, BRINQ_EMAIL_PROGID }

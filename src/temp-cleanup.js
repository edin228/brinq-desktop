const fs = require('fs')

// Files handed to another app (an opened attachment, a dragged email) are
// deleted 24 hours later; the startup sweep (cleanupProfileTemp) removes any
// left behind by a crash or quit.
const RETAIN_MS = 24 * 60 * 60 * 1000
const RETRY_MS = 15000

function retryUnlink(filePath, attemptsLeft, { chmod = fs.chmod, unlink = fs.unlink, schedule = setTimeout } = {}) {
  // Windows refuses to delete a read-only file, such as an email handed to Outlook.
  chmod(filePath, 0o600, () => unlink(filePath, (err) => {
    if (!err || attemptsLeft <= 1) return
    schedule(() => retryUnlink(filePath, attemptsLeft - 1, { chmod, unlink, schedule }), RETRY_MS)
  }))
}

/**
 * Deletes `tempPath` 24 hours from now (unref'd, four attempts). Returns a
 * cancel function. With `onExpire`, the owner decides when deletion starts:
 * it receives `proceed` and may call it later (a dragged file still pinned by
 * a native drag). Cancelling also revokes a deferred `proceed`.
 */
function scheduleTempCleanup(tempPath, { onExpire, schedule = setTimeout, clear = clearTimeout, unlinkWith } = {}) {
  let cancelled = false
  const proceed = () => { if (!cancelled) retryUnlink(tempPath, 4, unlinkWith) }
  const timer = schedule(() => (onExpire ? onExpire(proceed) : proceed()), RETAIN_MS)
  timer?.unref?.()
  return () => {
    cancelled = true
    clear(timer)
  }
}

module.exports = { scheduleTempCleanup, retryUnlink, RETAIN_MS }

// New-email OS popups. Every open Brinq tab or window subscribes to the same
// email:notify event and asks for its own popup, and each page knows only
// whether it has focus itself. Main decides once for the whole app:
// - one popup per email: a uid already seen is dropped, whichever page sent it;
// - none while any Brinq window has focus. The email still counts as seen, so
//   it never pops up later just because focus moved.
//
// Seen uids are kept for RETAIN_MS, matching the server's stale cutoff
// (EMAIL_NATIVE_NOTIFY_STALE_AFTER_SECONDS = 600 in brinq-mono): past that the
// server decides no popup for an arrival, and it decides each email at most
// once (synced_emails.native_notify_decided_at). They live in memory only;
// Pusher does not replay missed events after a restart.
const RETAIN_MS = 10 * 60 * 1000
const MAX_UID_LENGTH = 512

function createNativeNotifier({ Notification, appFocused, onClick, icon, now = Date.now, retainMs = RETAIN_MS }) {
  const seen = new Map() // uid -> time it may pop up again

  function forget(time) {
    for (const [uid, until] of seen) if (until <= time) seen.delete(uid)
  }

  return function notify(title, body, data) {
    if (typeof title !== 'string' || typeof body !== 'string') return 'invalid'
    const uid = data && typeof data.uid === 'string' && data.uid && data.uid.length <= MAX_UID_LENGTH ? data.uid : null
    const time = now()
    forget(time)
    if (uid) {
      if (seen.has(uid)) return 'duplicate'
      seen.set(uid, time + retainMs)
    }
    if (appFocused()) return 'focused'
    const popup = new Notification({ title, body, icon })
    popup.on('click', () => onClick(uid))
    popup.show()
    return 'shown'
  }
}

module.exports = { createNativeNotifier, RETAIN_MS }

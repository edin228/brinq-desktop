// New-email OS popups. Every open Brinq tab or window subscribes to the same
// email:notify event and asks for its own popup, and each page knows only
// whether it has focus itself. Main decides once for the whole app:
// - one popup per email: a uid already seen is dropped, whichever page sent it;
// - none while any Brinq window has focus. The email still counts as seen, so
//   it never pops up later just because focus moved.
//
// The server decides each email at most once and never later than 600 s after
// it arrives (EMAIL_NATIVE_NOTIFY_STALE_AFTER_SECONDS in brinq-mono), but a
// stalled page can still hand its copy over much later. Seen uids are kept for
// RETAIN_MS, far past any delivery delay: about 100 bytes each, so even 10,000
// emails a day stay near a megabyte. They live in memory only; Pusher does not
// replay missed events after a restart.
//
// Each shown popup is kept until it is clicked, closed or fails, or RETAIN_MS
// passes: a popup garbage-collected while it sits in the Windows Action Center
// would lose its click handler.
const RETAIN_MS = 24 * 60 * 60 * 1000
const MAX_UID_LENGTH = 512

function createNativeNotifier({ Notification, appFocused, onClick, icon, now = Date.now, retainMs = RETAIN_MS }) {
  const seen = new Map() // uid -> time it is forgotten, in insertion (time) order
  const live = new Map() // popup -> time its reference is dropped

  function forget(time) {
    for (const entries of [seen, live]) {
      for (const [key, until] of entries) {
        if (until > time) break
        entries.delete(key)
      }
    }
  }

  function notify(title, body, data) {
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
    const release = () => live.delete(popup)
    popup.on('click', () => { release(); onClick(uid) })
    popup.on('close', release)
    popup.on('failed', release)
    live.set(popup, time + retainMs)
    popup.show()
    return 'shown'
  }

  notify.sizes = () => ({ seen: seen.size, live: live.size })
  return notify
}

module.exports = { createNativeNotifier, RETAIN_MS }

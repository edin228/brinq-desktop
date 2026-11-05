// New-email OS popups. Every open Brinq tab or window subscribes to the same
// email:notify event and asks for its own popup, and each page knows only
// whether it has focus itself. Main decides once for the whole app:
// - one popup per email: a uid already seen is dropped, whichever page sent it;
// - none while any Brinq window has focus. The email still counts as seen, so
//   it never pops up later just because focus moved.
//
// This is best effort, in memory only (accepted for desktop 1.3.8). No state
// here depends on the clock, so a clock correction can't reorder or strand
// it. Seen uids are bounded by count: the oldest is forgotten once SEEN_LIMIT
// newer emails have arrived (about 100 bytes each, so about a megabyte; more
// than a busy broker receives in a week). Only a copy delayed past that many
// newer emails could pop up twice. Pusher does not replay missed events
// after a restart.
//
// A page may also pass the server's decision time (`decidedAt`, the
// email:notify `decided_at`). A copy decided more than MAX_DELIVERY_AGE_MS
// before this machine's clock says now is refused. That is a wall-clock
// heuristic: a missing, unreadable or future time is let through, and only a
// clock a full day off could misjudge it. The server itself never decides
// later than 600 s after arrival (EMAIL_NATIVE_NOTIFY_STALE_AFTER_SECONDS).
//
// Each shown popup is kept referenced until it is clicked, dismissed or fails,
// since garbage collection would drop its click handler. A Windows toast that
// times out of the banner (close reason 'timedOut') is still clickable in the
// Action Center, so it stays referenced. Past LIVE_LIMIT the oldest popup the
// OS has already shown ('show' event) is dismissed with close() rather than
// left on screen without a click handler. A popup still waiting to be shown
// is never dismissed: close() can't cancel a queued display and would detach
// its handler, so the set may run over the limit until those are shown.
// While LIVE_LIMIT popups are still waiting, no new one is created at all:
// if the OS has silently stopped showing them (Electron's Windows presenter
// can fail to start without any event), nothing would ever release them.
// Windows keeps only the newest 20 per app anyway. Nothing is shown when
// Notification.isSupported() says the OS can't show notifications.
const SEEN_LIMIT = 10000
const LIVE_LIMIT = 100
const MAX_DELIVERY_AGE_MS = 24 * 60 * 60 * 1000
const MAX_UID_LENGTH = 512

function decisionAge(data, now) {
  const decidedAt = data && typeof data.decidedAt === 'string' ? Date.parse(data.decidedAt) : NaN
  return Number.isFinite(decidedAt) ? now() - decidedAt : null
}

function createNativeNotifier({
  Notification, appFocused, onClick, icon, now = Date.now,
  seenLimit = SEEN_LIMIT, liveLimit = LIVE_LIMIT, maxDeliveryAgeMs = MAX_DELIVERY_AGE_MS,
}) {
  const seen = new Set() // uids, oldest first
  const live = new Map() // popup -> whether the OS has shown it yet, oldest first
  let pending = 0 // entries of `live` not shown yet
  const supported = () => typeof Notification.isSupported !== 'function' || Notification.isSupported()

  function remember(entries, item, limit) {
    entries.add(item)
    while (entries.size > limit) entries.delete(entries.values().next().value)
  }

  // Dismiss the oldest shown popups beyond the limit; never one still pending.
  function trimLive() {
    if (live.size <= liveLimit) return
    for (const [popup, shown] of live) {
      if (live.size <= liveLimit) break
      if (!shown) continue
      live.delete(popup)
      try { popup.close() } catch { /* Already gone. */ }
    }
  }

  function notify(title, body, data) {
    if (typeof title !== 'string' || typeof body !== 'string') return 'invalid'
    const uid = data && typeof data.uid === 'string' && data.uid && data.uid.length <= MAX_UID_LENGTH ? data.uid : null
    if (uid) {
      if (seen.has(uid)) return 'duplicate'
      remember(seen, uid, seenLimit)
    }
    const age = decisionAge(data, now)
    if (age !== null && age > maxDeliveryAgeMs) return 'stale'
    if (appFocused()) return 'focused'
    if (!supported()) return 'unsupported'
    if (pending >= liveLimit) return 'backlogged'
    const popup = new Notification({ title, body, icon })
    const release = () => {
      if (live.get(popup) === false) pending -= 1
      live.delete(popup)
    }
    popup.on('click', () => { release(); onClick(uid) })
    popup.on('close', (details) => { if (details?.reason !== 'timedOut') release() })
    popup.on('failed', release)
    popup.on('show', () => {
      if (live.get(popup) !== false) return
      live.set(popup, true)
      pending -= 1
      trimLive()
    })
    live.set(popup, false)
    pending += 1
    popup.show()
    trimLive()
    return 'shown'
  }

  notify.sizes = () => ({ seen: seen.size, live: live.size })
  notify.pending = () => pending
  return notify
}

module.exports = { createNativeNotifier, SEEN_LIMIT, LIVE_LIMIT, MAX_DELIVERY_AGE_MS }

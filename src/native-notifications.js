// New-email OS popups. Every open Brinq tab or window subscribes to the same
// email:notify event and asks for its own popup, and each page knows only
// whether it has focus itself. Main decides once for the whole app:
// - one popup per email: a uid already seen is dropped, whichever page sent it,
//   however late its copy arrives;
// - none while any Brinq window has focus. The email still counts as seen, so
//   it never pops up later just because focus moved.
//
// No state here depends on the clock, so a clock correction can't reorder or
// strand it. Seen uids are bounded by count instead: the oldest is forgotten
// once SEEN_LIMIT newer emails have arrived (about 100 bytes each, so about a
// megabyte; more than a busy broker receives in a week). They live in memory
// only; Pusher does not replay missed events after a restart.
//
// A page may also pass the server's decision time (`decidedAt`, the
// email:notify `decided_at`). A copy older than MAX_DELIVERY_AGE_MS is then
// refused whatever the seen list holds. That comparison uses the wall clock
// only against the server's time; the server itself never decides later than
// 600 s after arrival (EMAIL_NATIVE_NOTIFY_STALE_AFTER_SECONDS in brinq-mono).
//
// Each shown popup is kept referenced until it is clicked, dismissed or fails,
// since garbage collection would drop its click handler. A Windows toast that
// times out of the banner (close reason 'timedOut') is still clickable in the
// Action Center, so it stays referenced; LIVE_LIMIT bounds those, oldest first,
// well above what the Action Center keeps for one app.
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
  const live = new Set() // shown popups, oldest first

  function remember(entries, item, limit) {
    entries.add(item)
    while (entries.size > limit) entries.delete(entries.values().next().value)
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
    const popup = new Notification({ title, body, icon })
    const release = () => live.delete(popup)
    popup.on('click', () => { release(); onClick(uid) })
    popup.on('close', (details) => { if (details?.reason !== 'timedOut') release() })
    popup.on('failed', release)
    remember(live, popup, liveLimit)
    popup.show()
    return 'shown'
  }

  notify.sizes = () => ({ seen: seen.size, live: live.size })
  return notify
}

module.exports = { createNativeNotifier, SEEN_LIMIT, LIVE_LIMIT, MAX_DELIVERY_AGE_MS }

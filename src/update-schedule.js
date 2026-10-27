// When the installed app looks for updates: once soon after launch, then
// about every six hours, and once after the computer wakes. Failures back off
// 15 minutes, 1 hour, then 6 hours. Every delay varies by ±20% so an office
// of brokers does not ask GitHub at the same moment.
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const INTERVAL = 6 * HOUR
const JITTER = 0.2
const BACKOFF = [15 * MINUTE, HOUR, 6 * HOUR]
const LAUNCH_DELAY = [0, 60 * SECOND]
const RESUME_DELAY = [30 * SECOND, 120 * SECOND]
const LONGEST = INTERVAL * (1 + JITTER)

// `check` is the update owner's check: it returns { ok, retryAt? } and
// shares one check between every caller.
function createUpdateSchedule({ check, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random, log = () => {} }) {
  let timer = null
  let due = null
  let failures = 0
  let limitedUntil = 0
  let running = false
  let started = false
  let stopped = false

  const between = ([min, max]) => min + (max - min) * random()
  const jittered = (ms) => ms * (1 - JITTER + 2 * JITTER * random())

  function arm(at, reason) {
    if (stopped) return
    if (timer) clearTimer(timer)
    due = at
    // Timers may not count time asleep; resume() re-arms after a wake. The
    // wait is bounded so a clock change cannot postpone checks for long.
    const delay = Math.round(Math.min(Math.max(0, at - now()), LONGEST))
    timer = setTimer(run, delay)
    timer?.unref?.()
    log('scheduled', { reason, delayMs: delay })
  }

  async function run() {
    timer = null
    due = null
    if (stopped || running) return
    running = true
    let result
    try { result = await check() } catch { result = { ok: false } } finally { running = false }
    if (stopped) return
    if (result?.ok) {
      failures = 0
      limitedUntil = 0
      return arm(now() + jittered(INTERVAL), 'interval')
    }
    failures++
    limitedUntil = result?.retryAt > now() ? result.retryAt : 0
    const backoff = now() + jittered(BACKOFF[Math.min(failures, BACKOFF.length) - 1])
    arm(Math.max(backoff, limitedUntil), 'backoff')
  }

  return {
    start() {
      if (started || stopped) return
      started = true
      arm(now() + between(LAUNCH_DELAY), 'launch')
    },
    // One check soon after waking, or the planned one if that is sooner.
    // A connection backoff yields to the wake; GitHub's rate limit does not.
    resume() {
      if (!started || stopped || running) return
      const soonest = now() + RESUME_DELAY[0]
      const at = Math.max(Math.min(due ?? Infinity, now() + between(RESUME_DELAY)), soonest, limitedUntil)
      arm(at, 'resume')
    },
    stop() {
      stopped = true
      if (timer) clearTimer(timer)
      timer = null
    },
  }
}

module.exports = { createUpdateSchedule, INTERVAL, BACKOFF, JITTER, LAUNCH_DELAY, RESUME_DELAY }

const test = require('node:test')
const assert = require('node:assert/strict')
const { createUpdateSchedule } = require('../src/update-schedule')

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

// A fake clock and timers. `results` answers each check in turn; a pending
// check holds until `finish()`.
function fixture({ random = () => 0.5, results = [] } = {}) {
  const clock = { now: 1_000_000_000 }
  const timers = new Set()
  const checks = []
  let pending = null
  const schedule = createUpdateSchedule({
    now: () => clock.now,
    random,
    setTimer: (fn, ms) => { const timer = { fn, at: clock.now + ms, ms }; timers.add(timer); return timer },
    clearTimer: (timer) => timers.delete(timer),
    check: () => {
      checks.push(clock.now)
      const result = results.shift()
      if (result === 'hold') return new Promise((resolve) => { pending = resolve })
      return Promise.resolve(result ?? { ok: true })
    },
  })
  const settle = async () => { for (let turn = 0; turn < 5; turn++) await Promise.resolve() }
  return {
    clock, timers, checks, schedule,
    // The one armed timer's delay.
    delay: () => { assert.equal(timers.size, 1, 'exactly one timer'); return [...timers][0].ms },
    async advance(ms) {
      clock.now += ms
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.at <= clock.now && timers.delete(timer)) { timer.fn(); await settle() }
      }
    },
    async finish(result = { ok: true }) { pending(result); pending = null; await settle() },
  }
}

test('the first check waits 0 to 60 seconds after launch, and start is once only', () => {
  for (const [random, expected] of [[0, 0], [0.5, 30 * SECOND], [1, 60 * SECOND]]) {
    const f = fixture({ random: () => random })
    f.schedule.start()
    f.schedule.start()
    assert.equal(f.delay(), expected)
  }
})

test('checks repeat every six hours ±20%, counted from when the last one finished', async () => {
  for (const [random, expected] of [[0, 4.8 * HOUR], [0.5, 6 * HOUR], [1, 7.2 * HOUR]]) {
    const f = fixture({ random: () => random, results: ['hold'] })
    f.schedule.start()
    await f.advance(60 * SECOND)
    assert.equal(f.checks.length, 1)
    assert.equal(f.timers.size, 0, 'nothing is armed while a check runs')
    await f.advance(10 * MINUTE)
    await f.finish()
    assert.equal(Math.round(f.delay()), expected)
  }
})

test('failures back off 15 minutes, 1 hour, then 6 hours, and success resets', async () => {
  const fail = { ok: false }
  const f = fixture({ results: [fail, fail, fail, fail, { ok: true }, fail] })
  f.schedule.start()
  await f.advance(30 * SECOND)
  const delays = []
  for (let attempt = 0; attempt < 5; attempt++) {
    delays.push(f.delay())
    await f.advance(f.delay())
  }
  delays.push(f.delay())
  // Three failures reach the 6-hour cap; after the success the next
  // failure starts over at 15 minutes.
  assert.deepEqual(delays, [15 * MINUTE, HOUR, 6 * HOUR, 6 * HOUR, 6 * HOUR, 15 * MINUTE])
  // Jitter stays within ±20%.
  const low = fixture({ random: () => 0, results: [fail] })
  low.schedule.start()
  await low.advance(0)
  assert.equal(low.delay(), 12 * MINUTE)
})

test('a rate limit holds the next check until GitHub allows it', async () => {
  const results = []
  const g = fixture({ results })
  results.push({ ok: false, retryAt: g.clock.now + 30 * SECOND + 2 * HOUR })
  g.schedule.start()
  await g.advance(30 * SECOND)
  assert.equal(g.delay(), 2 * HOUR)
  // Waking does not override the limit.
  g.schedule.resume()
  assert.equal(g.delay(), 2 * HOUR)
})

test('waking checks once after 30 to 120 seconds, or at the planned time if sooner', async () => {
  const f = fixture({ random: () => 0.5 })
  f.schedule.start()
  await f.advance(30 * SECOND)
  assert.equal(f.delay(), 6 * HOUR)
  f.schedule.resume()
  assert.equal(f.delay(), 75 * SECOND)
  // Several wake events coalesce into the one check.
  f.schedule.resume()
  f.schedule.resume()
  assert.equal(f.delay(), 75 * SECOND)
  await f.advance(75 * SECOND)
  assert.equal(f.checks.length, 2)
  assert.equal(f.delay(), 6 * HOUR)
  // A planned check sooner than the wake slot keeps its time, but never
  // sooner than 30 seconds after waking.
  await f.advance(6 * HOUR - 50 * SECOND)
  f.schedule.resume()
  assert.equal(f.delay(), 50 * SECOND)
  await f.advance(6 * HOUR)
  f.clock.now += 3 * HOUR // asleep past the planned time
  f.schedule.resume()
  assert.equal(f.delay(), 75 * SECOND)
})

test('a wake during a connection backoff checks soon; a wake during a check does nothing', async () => {
  const f = fixture({ results: [{ ok: false }, 'hold'] })
  f.schedule.start()
  await f.advance(30 * SECOND)
  assert.equal(f.delay(), 15 * MINUTE)
  f.schedule.resume()
  assert.equal(f.delay(), 75 * SECOND)
  await f.advance(75 * SECOND)
  assert.equal(f.timers.size, 0)
  f.schedule.resume()
  assert.equal(f.timers.size, 0)
  await f.finish({ ok: true })
  assert.equal(f.delay(), 6 * HOUR)
})

test('a clock set back or forward never stretches a wait beyond one interval', async () => {
  const f = fixture({ random: () => 1 })
  f.schedule.start()
  await f.advance(60 * SECOND)
  f.clock.now -= 48 * HOUR
  f.schedule.resume()
  assert.ok(f.delay() <= 7.2 * HOUR)
  assert.ok(f.delay() >= 30 * SECOND)
})

test('resume before start, or anything after stop, schedules nothing', async () => {
  const f = fixture({ results: ['hold'] })
  f.schedule.resume()
  assert.equal(f.timers.size, 0)
  f.schedule.start()
  await f.advance(30 * SECOND)
  f.schedule.stop()
  await f.finish()
  assert.equal(f.timers.size, 0)
  f.schedule.resume()
  f.schedule.start()
  assert.equal(f.timers.size, 0)
})

test('a check that throws counts as a failure', async () => {
  const f = fixture()
  const schedule = createUpdateSchedule({
    now: () => f.clock.now, random: () => 0.5,
    setTimer: (fn, ms) => { const timer = { fn, at: f.clock.now + ms, ms }; f.timers.add(timer); return timer },
    clearTimer: (timer) => f.timers.delete(timer),
    check: () => { throw new Error('boom') },
  })
  schedule.start()
  await f.advance(30 * SECOND)
  assert.equal(f.delay(), 15 * MINUTE)
})

test('a person\'s check counts: an offline one backs off the planned check, a good one resets', async () => {
  const f = fixture()
  f.schedule.start()
  await f.advance(29 * SECOND)
  f.schedule.record({ ok: false })
  assert.equal(f.delay(), 15 * MINUTE, 'the launch check waits out the backoff')
  f.schedule.record({ ok: false })
  assert.equal(f.delay(), HOUR)
  f.schedule.record({ ok: true })
  assert.equal(f.delay(), 6 * HOUR)
})

test('the schedule\'s own check is planned from once when the owner reports it', async () => {
  const f = fixture()
  let schedule
  const answers = [{ ok: false }, { ok: false }]
  schedule = createUpdateSchedule({
    now: () => f.clock.now, random: () => 0.5,
    setTimer: (fn, ms) => { const timer = { fn, at: f.clock.now + ms, ms }; f.timers.add(timer); return timer },
    clearTimer: (timer) => f.timers.delete(timer),
    // Like the update owner: report, then answer.
    check: async () => { const result = answers.shift(); schedule.record(result); return result },
  })
  schedule.start()
  await f.advance(30 * SECOND)
  assert.equal(f.delay(), 15 * MINUTE)
  await f.advance(15 * MINUTE)
  assert.equal(f.delay(), HOUR, 'one failure counted per check')
})

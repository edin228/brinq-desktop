const DEFAULT_BOUNDS = { width: 1200, height: 800 }
const isMode = (mode) => mode === 'email' || mode === 'full'
const modeUrl = (baseUrl, mode, emails = false) =>
  `${baseUrl}/${emails || mode === 'email' ? 'emails' : 'dashboard'}?standalone=${mode === 'email' ? 'email' : 'full'}`

function visibleBounds(saved, workAreas, primaryArea = workAreas[0]) {
  const validSize = saved && Number.isSafeInteger(saved.width) && saved.width > 0 &&
    Number.isSafeInteger(saved.height) && saved.height > 0
  const size = validSize ? saved : DEFAULT_BOUNDS
  const positioned = validSize && Number.isSafeInteger(saved.x) && Number.isSafeInteger(saved.y)
  // Select the monitor containing the largest part of the saved window. Negative
  // coordinates are ordinary positions on monitors left of or above primary.
  let area = primaryArea
  let overlap = 0
  if (positioned) {
    for (const candidate of workAreas) {
      const intersection = Math.max(0, Math.min(saved.x + size.width, candidate.x + candidate.width) - Math.max(saved.x, candidate.x)) *
        Math.max(0, Math.min(saved.y + size.height, candidate.y + candidate.height) - Math.max(saved.y, candidate.y))
      if (intersection > overlap) { area = candidate; overlap = intersection }
    }
  }
  const width = Math.min(size.width, area.width)
  const height = Math.min(size.height, area.height)
  return {
    width, height,
    x: positioned && overlap ? Math.max(area.x, Math.min(saved.x, area.x + area.width - width)) : area.x + Math.floor((area.width - width) / 2),
    y: positioned && overlap ? Math.max(area.y, Math.min(saved.y, area.y + area.height - height)) : area.y + Math.floor((area.height - height) / 2),
  }
}

const CALLBACK_TOKEN = /^[A-Za-z0-9_-]{43}$/

// brinq://sign-in?code=…&state=… is the browser sign-in callback. Anything
// unexpected (extra keys, duplicates, credentials, a port, a fragment or a
// path) is not a callback, so it can never carry data into the app.
function browserSignInCallback(url) {
  if (url.hostname !== 'sign-in' || !['', '/'].includes(url.pathname) || url.port ||
    url.username || url.password || url.hash) return null
  const keys = [...url.searchParams.keys()].sort()
  if (keys.length !== 2 || keys[0] !== 'code' || keys[1] !== 'state') return null
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!CALLBACK_TOKEN.test(code) || !CALLBACK_TOKEN.test(state)) return null
  return { type: 'browser-sign-in', data: { code, state } }
}

function parseProtocolUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol === 'brinq:') return browserSignInCallback(url) || { type: 'activate' }
    if (url.protocol !== 'mailto:' || url.host) return null
    const addresses = (text) => text.split(/[;,]/).map((v) => v.trim()).filter(Boolean)
    return { type: 'mailto', data: {
      to: addresses(decodeURIComponent(url.pathname)),
      subject: url.searchParams.get('subject') || '',
      cc: addresses(url.searchParams.get('cc') || ''),
      body: url.searchParams.get('body') || '',
    } }
  } catch { return null }
}

function incomingNavigationUrl(currentUrl, baseUrl, mode) {
  try {
    const current = new URL(currentUrl)
    if (current.origin === new URL(baseUrl).origin && ['/login', '/emails'].includes(current.pathname)) return null
  } catch { /* A fresh window has no URL yet. */ }
  return modeUrl(baseUrl, mode, true)
}

function createNavigationQueue() {
  const pending = []
  const ready = new Map()
  return {
    push(channel, data) { pending.push({ channel, data }) },
    hasPending: () => pending.length > 0,
    reset() { ready.clear() },
    subscribe(channel, frame, active) {
      if (!['mailto', 'navigate-email'].includes(channel)) return
      if (active) ready.set(channel, frame)
      else if (ready.get(channel) === frame) ready.delete(channel)
    },
    drain(frame, send) {
      for (let index = 0; index < pending.length;) {
        const payload = pending[index]
        if (ready.get(payload.channel) !== frame) { index++; continue }
        pending.splice(index, 1)
        send(payload.channel, payload.data)
      }
    },
  }
}

module.exports = { isMode, modeUrl, visibleBounds, parseProtocolUrl, incomingNavigationUrl, createNavigationQueue }

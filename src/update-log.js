// electron-updater logs whole errors: stacks, signed download URLs and, for
// a feed it cannot parse, the feed itself. Keep the first useful line.
const MAX_LENGTH = 300

function cleanText(text) {
  const line = String(text)
    .replace(/,?\s*XML:[\s\S]*$/, '')
    .replace(/\n\s+at [\s\S]*$/, '')
    .replace(/(https?:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return line.length > MAX_LENGTH ? `${line.slice(0, MAX_LENGTH)}…` : line
}

function cleanValue(value) {
  if (value instanceof Error) {
    const code = typeof value.code === 'string' ? ` (${value.code})` : ''
    return `${value.name}: ${cleanText(value.message)}${code}`
  }
  return typeof value === 'string' ? cleanText(value) : value
}

// Wraps a logger (electron-log) for autoUpdater.logger.
function sanitizedLogger(logger) {
  const level = (name) => (...args) => logger[name](...args.map(cleanValue))
  return { info: level('info'), warn: level('warn'), error: level('error'), debug: level('debug') }
}

module.exports = { sanitizedLogger, cleanText }

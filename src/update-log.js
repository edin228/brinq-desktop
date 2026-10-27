// electron-updater logs whole errors: stacks, response bodies and headers
// (cookies included), signed download URLs and, for a feed or update file it
// cannot parse, the file itself. Keep the first line, minus those.
const MAX_LENGTH = 300

function cleanText(text) {
  const line = String(text)
    .replace(/,?\s*(?:XML|rawData|Headers):[\s\S]*$/, '')
    .split('\n')[0]
    .replace(/(https?:\/\/[^\s?#"'<>()]*)[?#][^\s"'<>()]*/g, '$1')
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

const retry = document.getElementById('retry')
const status = document.getElementById('status')
retry.addEventListener('click', async () => {
  retry.disabled = true
  status.textContent = 'Connecting…'
  try {
    const result = await window.brinqRecovery.retry()
    if (!result.ok) status.textContent = result.error || 'Still unable to connect. Check your connection and try again.'
  } catch {
    status.textContent = 'Still unable to connect. Check your connection and try again.'
  } finally { retry.disabled = false }
})

const toolbar = window.scrapeBrowserToolbar
const $ = (id) => document.getElementById(id)

for (const name of ['back', 'forward', 'reload', 'cancel', 'continue']) {
  $(name).addEventListener('click', () => toolbar.action(name))
}

toolbar.onState((state) => {
  $('back').disabled = !state.canGoBack
  $('forward').disabled = !state.canGoForward
  $('title').textContent = state.title || (state.loading ? 'Loading…' : '')
  $('url').textContent = state.url || ''
  $('continue').disabled = Boolean(state.capturing)
  $('continue').textContent = state.capturing ? 'Importing…' : 'Continue'

  const status = $('status')
  status.className = ''
  if (state.error) {
    status.textContent = state.error
    status.className = 'error'
  } else if (state.loading) {
    status.textContent = 'Loading…'
  } else if (state.challenge) {
    status.textContent = 'Complete the security check first'
    status.className = 'warn'
  } else {
    status.textContent = 'Ready to import'
  }
  status.title = status.textContent
})

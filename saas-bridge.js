// Runs on the SaaS origin. Listens for postMessage from the SaaS frontend,
// verifies origin + type, and mirrors the payload into chrome.storage.local.
(function () {
  const EXPECTED_ORIGIN = window.location.origin

  window.addEventListener('message', function (event) {
    if (event.origin !== EXPECTED_ORIGIN) return
    if (!event.data || !event.data.type) return

    if (event.data.type === 'LAUDO_FILL_DATA') {
      const payload = event.data
      if (!payload.examinee || !payload.fields) return
      chrome.storage.local.set({ laudoFillData: payload }, function () {
        console.log('[Preencher Laudo] Dados salvos para:', payload.examinee)
      })
      return
    }

    // Login handoff, sent by the site's <ExtensionAuthBridge/> on every page load.
    // Stored shape ({ token, savedAt }) is shared with auth.js and popup.js.
    if (event.data.type === 'PH_AUTH_TOKEN') {
      const token = event.data.token
      if (typeof token !== 'string' || !token) return
      chrome.storage.local.set({ phAuthToken: { token, savedAt: Date.now() } }, function () {
        console.log('[Perícia Hub] Login conectado à extensão.')
      })
      return
    }

    if (event.data.type === 'PH_LOGOUT') {
      chrome.storage.local.remove('phAuthToken')
    }
  })
})()

// Runs on the SaaS origin. Listens for postMessage from the SaaS frontend,
// verifies origin + type, and writes the payload to chrome.storage.local.
(function () {
  const EXPECTED_ORIGIN = window.location.origin

  window.addEventListener('message', function (event) {
    if (event.origin !== EXPECTED_ORIGIN) return
    if (!event.data || event.data.type !== 'LAUDO_FILL_DATA') return

    const payload = event.data
    if (!payload.examinee || !payload.fields) return

    chrome.storage.local.set({ laudoFillData: payload }, function () {
      console.log('[Preencher Laudo] Dados salvos para:', payload.examinee)
    })
  })
})()

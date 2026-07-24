chrome.storage.local.get('laudoFillData', function (data) {
  const el = document.getElementById('status')
  const payload = data.laudoFillData
  if (!payload || !payload.examinee) {
    el.textContent = 'Nenhum dado. Processe o PDF no app primeiro.'
    el.style.color = '#c0392b'
  } else {
    el.textContent = `Dados prontos para: ${payload.examinee}`
    el.style.color = '#27ae60'
  }
})

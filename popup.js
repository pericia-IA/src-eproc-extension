// Login-status surface. The token is written by saas-bridge.js when the doctor
// logs in at eproc.periciahub.com (shape { token, savedAt }, shared with auth.js).
// The JWT payload is decoded locally (no network) for the email + expiry display;
// the backend remains the authority — an invalid token just 401s on first use.
function jwtPayload(token) {
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
  } catch (_e) {
    return null
  }
}

const statusEl = document.getElementById('status')
const loginBtn = document.getElementById('login-btn')

loginBtn.addEventListener('click', function () {
  chrome.tabs.create({ url: 'https://eproc.periciahub.com/login' })
})

chrome.storage.local.get('phAuthToken', function (data) {
  const stored = data.phAuthToken
  const payload = stored && stored.token ? jwtPayload(stored.token) : null
  const valid = payload && (!payload.exp || payload.exp * 1000 > Date.now())
  if (valid) {
    statusEl.textContent = payload.email ? 'Conectado como ' + payload.email : 'Conectado.'
    statusEl.style.color = '#27ae60'
  } else {
    statusEl.textContent = 'Não conectado. Entre no Perícia Hub para usar a extensão.'
    statusEl.style.color = '#c0392b'
    loginBtn.style.display = 'block'
  }
})

// Login-status surface. The token is written by saas-bridge.js when the doctor
// logs in at eproc.periciahub.com (shape { token, savedAt }, shared with auth.js).
// The JWT payload is decoded locally (no network) for the instant email + expiry
// display; the plan line is then fetched fresh from GET /api/auth/me via
// PhAuth.authFetch (auth.js is loaded before this script in popup.html). On any
// fetch failure the JWT-based display simply stands without a plan line.
function jwtPayload(token) {
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
  } catch (_e) {
    return null
  }
}

const statusEl = document.getElementById('status')
const planEl = document.getElementById('plan')
const loginBtn = document.getElementById('login-btn')
const upgradeBtn = document.getElementById('upgrade-btn')

loginBtn.addEventListener('click', function () {
  chrome.tabs.create({ url: 'https://eproc.periciahub.com/login' })
})

upgradeBtn.addEventListener('click', function () {
  chrome.tabs.create({ url: 'https://eproc.periciahub.com/dashboard' })
})

function showLoggedOut() {
  statusEl.textContent = 'Não conectado. Entre no Perícia Hub para usar a extensão.'
  statusEl.style.color = '#c0392b'
  planEl.style.display = 'none'
  upgradeBtn.style.display = 'none'
  loginBtn.style.display = 'block'
}

function showPlan(plan) {
  planEl.style.display = 'block'
  if (plan.type === 'PRO') {
    planEl.textContent = 'Plano Pro — uso ilimitado de IA'
    planEl.style.color = '#27ae60'
  } else {
    planEl.textContent = 'Plano gratuito — ' + plan.usedToday + ' de ' + plan.limit + ' usos de IA hoje'
    upgradeBtn.style.display = 'block'
  }
}

chrome.storage.local.get('phAuthToken', function (data) {
  const stored = data.phAuthToken
  const payload = stored && stored.token ? jwtPayload(stored.token) : null
  const valid = payload && (!payload.exp || payload.exp * 1000 > Date.now())
  if (!valid) {
    showLoggedOut()
    return
  }
  statusEl.textContent = payload.email ? 'Conectado como ' + payload.email : 'Conectado.'
  statusEl.style.color = '#27ae60'
  self.PhAuth.authFetch('https://api.periciahub.com/api/auth/me')
    .then(function (resp) { return resp.ok ? resp.json() : null })
    .then(function (me) {
      if (me && me.plan) showPlan(me.plan)
    })
    .catch(function (err) {
      // authFetch already cleared the token on 401.
      if (err && err.phAuth) showLoggedOut()
    })
})

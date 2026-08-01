// Shared auth plumbing for backend calls, runnable in two contexts:
//   - as a content script on eproc1g (listed before pipeline.js/eproc-fill.js in the manifest)
//   - via importScripts() in preencher-worker.js
// No DOM, no chrome messaging. Hangs off self.PhAuth.
//
// Token lifecycle: the doctor logs in at eproc.periciahub.com; the site postMessages the
// backend JWT to saas-bridge.js, which stores it as phAuthToken ({ token, savedAt }).
// authFetch attaches it as a Bearer header and silently renews it via
// POST /api/auth/refresh once it is older than REFRESH_AFTER_MS, so an actively
// used extension stays logged in without revisiting the site.
//
// No token stored -> the request goes out WITHOUT the header. That is correct both
// before the backend enforces auth (succeeds as today) and after (backend answers
// 401 -> the doctor sees the login instruction instead of a raw error).
(function () {
  const BACKEND_ORIGIN = 'https://api.periciahub.com'
  const TOKEN_KEY = 'phAuthToken' // stored shape shared with saas-bridge.js and popup.js
  const REFRESH_AFTER_MS = 3 * 24 * 60 * 60 * 1000 // JWT lives 7 days; renew after 3
  const LOGIN_MSG = 'Faça login em https://eproc.periciahub.com para usar a extensão.'

  function getStored() {
    return new Promise((resolve) => {
      chrome.storage.local.get(TOKEN_KEY, (data) => resolve(data[TOKEN_KEY] || null))
    })
  }

  function setStored(token) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [TOKEN_KEY]: { token, savedAt: Date.now() } }, () => resolve())
    })
  }

  function clearStored() {
    return new Promise((resolve) => chrome.storage.local.remove(TOKEN_KEY, () => resolve()))
  }

  // Best-effort renewal — never throws; on any failure the old token stays in
  // place until a real 401 clears it.
  async function maybeRefresh(stored) {
    if (!stored || !stored.token) return stored
    if (Date.now() - (stored.savedAt || 0) < REFRESH_AFTER_MS) return stored
    try {
      const resp = await fetch(`${BACKEND_ORIGIN}/api/auth/refresh`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + stored.token },
      })
      if (!resp.ok) return stored
      const { token } = await resp.json()
      if (typeof token !== 'string' || !token) return stored
      await setStored(token)
      return { token, savedAt: Date.now() }
    } catch (_e) {
      return stored
    }
  }

  // fetch() with the user JWT attached (when one is stored). On a 401 response the
  // stored token is cleared and an Error with .phAuth = true and a user-facing
  // login message is thrown — callers branch on err.phAuth for their red status line.
  // A 429 (daily AI usage limit) throws with .phLimit = true and the server's message,
  // so it also stops the worker pipeline and polling loops instead of surfacing raw.
  async function authFetch(input, init) {
    const stored = await maybeRefresh(await getStored())
    const opts = Object.assign({}, init)
    if (stored && stored.token) {
      opts.headers = Object.assign({}, (init && init.headers) || {}, {
        Authorization: 'Bearer ' + stored.token,
      })
    }
    const resp = await fetch(input, opts)
    if (resp.status === 401) {
      await clearStored()
      const err = new Error(LOGIN_MSG)
      err.phAuth = true
      throw err
    }
    if (resp.status === 429) {
      let msg = 'Limite diário de uso de IA atingido. Tente novamente amanhã.'
      let info = null
      try {
        const body = await resp.json()
        if (body && body.error) msg = body.error
        info = body
      } catch (_e) {}
      const err = new Error(msg)
      err.phLimit = true
      err.phLimitInfo = info // { error, limit, used, period } from the backend
      throw err
    }
    return resp
  }

  self.PhAuth = { authFetch }
})()

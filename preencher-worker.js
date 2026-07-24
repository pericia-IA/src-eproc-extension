// Background service worker. The content script (detail page, page session) drives e-proc generation
// — POST Gerar + poll — because that runs ~6-8x faster in the page session than in this worker
// (live-proven 2026-06-26: 7-15s vs 38-59s). The content script then sends us the ready eproc1g-down
// href; we fetch the PDF bytes HERE because only the worker bypasses CORS for that host (proven:
// content-script fetch is CORS-blocked; worker fetch returns type:basic application/pdf). We run the
// shared pipeline and stash the small payload in chrome.storage.local for the exam page to fill.
//
// importScripts is PROVEN to boot in this MV3 worker (spike 2026-06-23). The earlier
// "worker dying (message-channel-closed)" in commit b80f551 was the old onConnect *Port* idle-death,
// NOT importScripts — this design uses onMessage + storage, so no open channel exists.
importScripts('pipeline.js')
console.log('[pre-preencher worker] booted')

const PIPELINE_BUDGET_MS = 90_000   // segment + sequential Claude calls (after the blob is in hand)
const FETCH_BUDGET_MS = 60_000      // the eproc1g-down byte fetch (a few MB; generous ceiling)

// Fetch the ready BAIXAR ARQUIVO href (eproc1g-down host) → PDF Blob, or throw. The only download
// mechanism; the content script can't do this (CORS-blocked), so it must run here.
async function fetchPdf(href, signal) {
  const resp = await fetch(href, { credentials: 'include', signal })
  const ct = resp.headers.get('content-type') || ''
  if (!resp.ok || !ct.includes('pdf')) throw new Error('Download não retornou PDF.')
  return await resp.blob()
}

// Q4: only one extraction in flight; a new PP_FETCH_PDF supersedes (aborts) the old one so the latest
// click always wins and storage writes never interleave. (The content script owns aborting its own
// in-flight generation loop; this guards only the blob-fetch + pipeline half.)
let currentRun = null // { ctrl, numProcesso }

async function runFetchAndPipeline(hrefs, numProcesso) {
  if (currentRun) { try { currentRun.ctrl.abort() } catch {} } // supersede the previous run
  const ctrl = new AbortController()
  currentRun = { ctrl, numProcesso }
  const onProgress = (p) => { if (currentRun && currentRun.ctrl === ctrl) chrome.storage.local.set({ ppProgress: p }) }
  // Fetch budget spans ALL parts, scaled by count (single part → unchanged 60s).
  let t = setTimeout(() => ctrl.abort(), FETCH_BUDGET_MS * hrefs.length)
  try {
    // Fetch parts sequentially, order-preserving. Each fetch is signal-bound, so a supersede-abort
    // rejects the in-flight await and bubbles to the catch below (no per-part try/catch — that would
    // swallow the abort and wrongly continue to the next part).
    const blobs = []
    for (const href of hrefs) blobs.push(await fetchPdf(href, ctrl.signal))
    clearTimeout(t)
    t = setTimeout(() => ctrl.abort(), PIPELINE_BUDGET_MS)    // re-arm: pipeline phase budget
    onProgress({ phase: 'segmenting' })
    const payload = await self.LaudoPipeline.runPipeline(blobs, onProgress)
    clearTimeout(t)
    if (currentRun && currentRun.ctrl !== ctrl) return // superseded mid-run — drop our result
    // Q12: stamp time so the exam page can treat very old payloads as stale.
    chrome.storage.local.set({ ppPayload: payload, ppPayloadProcesso: numProcesso, ppPayloadAt: Date.now(), ppProgress: { phase: 'done' } })
  } catch (err) {
    clearTimeout(t)
    if (currentRun && currentRun.ctrl !== ctrl) return // a newer run replaced us; its abort fired ours
    chrome.storage.local.set({ ppError: (err && err.name === 'AbortError') ? 'timeout' : ((err && err.message) || 'erro') })
  } finally {
    if (currentRun && currentRun.ctrl === ctrl) currentRun = null
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.cmd !== 'PP_FETCH_PDF') return
  // G7: distinguish "my message, wrong shape" from "not my message". A stale content-script tab from
  // before an extension update may still send the old { href } key; surface an actionable error
  // instead of silently dropping it (which would hang the spinner forever).
  if (!Array.isArray(msg.hrefs) || msg.hrefs.length === 0) {
    chrome.storage.local.set({ ppError: 'Recarregue a página (extensão atualizada).' })
    return
  }
  // The content script already cleared stale storage + showed progress during generation; it writes
  // ppProgress{phase:'segmenting'} via our onProgress from here on.
  runFetchAndPipeline(msg.hrefs, msg.numProcesso)
})

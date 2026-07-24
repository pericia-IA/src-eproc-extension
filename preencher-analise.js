// Runs on the e-proc process DETAIL page (live-confirmed acao=processo_selecionar; e-proc may use
// other action names for the same view, so we do NOT allowlist a specific acao). Injects a purple
// "Extrair dados para o laudo" button into the "Ações" toolbar, immediately BEFORE the "Laudo Médico
// de Incapacidade" link (where the perito naturally starts the laudo flow). The entry URL is read
// from the live #btnDownloadCompletoRS button elsewhere on the SAME page (live-confirmed: Laudo link
// and Download Completo are on this page but in different containers). Hands the URL to the worker,
// which downloads + runs the pipeline. Polls storage for status. No fetch / no pipeline here
// (content-script fetch of the -down PDF is CORS-blocked).
;(function () {
  // Page guard: don't run on the exam form (eproc-fill.js owns that UI); otherwise let inject()
  // decide by the toolbar's presence (Laudo link + Download Completo). Robust to the detail page's
  // acao name (processo_selecionar / processo_consultar / etc.) without hardcoding one.
  if (location.href.includes('acao=laudo_pericial_alterar')) return

  function readEntryUrl() {
    const b = document.querySelector('#btnDownloadCompletoRS')
    if (!b) return null
    const m = (b.getAttribute('onclick') || '').match(/location\.href\s*=\s*['"]([^'"]+)['"]/i)
    if (!m) return null
    let u = m[1].replace(/&amp;/g, '&')
    if (u.startsWith('controlador.php')) u = 'https://eproc1g.trf6.jus.br/eproc/' + u
    else if (u.startsWith('/')) u = 'https://eproc1g.trf6.jus.br' + u
    return u
  }
  function readNumProcesso() {
    const h = (document.querySelector('#hdnNumProcesso') || {}).value
    if (h) return h
    const m = readEntryUrl() && readEntryUrl().match(/num_processo=(\d+)/)
    return m ? m[1] : ''
  }
  // The "Laudo Médico de Incapacidade" link in the Ações toolbar — our injection anchor.
  // Live-confirmed: <a class="infraButton" href="...acao=laudo_pericial..." target="_blank">.
  function findLaudoLink() {
    return [...document.querySelectorAll('a.infraButton')]
      .find((el) => /Laudo Médico de Incapacidade/i.test(el.textContent || '')) || null
  }

  function inject() {
    const laudo = findLaudoLink()
    if (!laudo || document.querySelector('#pp-analisar-btn')) return
    // Need the entry URL source present too (Download Completo lives elsewhere on the page).
    if (!document.querySelector('#btnDownloadCompletoRS')) return

    const btn = document.createElement('button')
    btn.id = 'pp-analisar-btn'
    btn.type = 'button'
    btn.textContent = 'Extrair dados para o laudo'
    btn.style.cssText = 'margin-right:8px;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:13px'
    const status = document.createElement('span')
    status.id = 'pp-analisar-status'
    status.style.cssText = 'margin-right:8px;font-size:12px;color:#8e44ad'
    laudo.parentElement.insertBefore(btn, laudo) // purple button, immediately before the Laudo link
    laudo.parentElement.insertBefore(status, laudo)

    let poll = null, secs = 0, tick = null, genCtrl = null
    const setStatus = (txt, spinning) => {
      status.textContent = ''
      if (spinning) {
        const img = document.createElement('img')
        img.className = 'ph-spinner'
        img.src = chrome.runtime.getURL('icons/final_icon32.png')
        img.alt = ''
        status.appendChild(img)
      }
      status.appendChild(document.createTextNode(txt))
    }
    const stopTick = () => { if (tick) { clearInterval(tick); tick = null } }

    // Generation now runs HERE (page session = ~6-8x faster than the worker — live-proven 2026-06-26),
    // bounded by a 45s budget + AbortController. Once the eproc1g-down href is ready we hand it to the
    // worker (PP_FETCH_PDF), which does the CORS-bound byte fetch + pipeline. A new click aborts the
    // prior generation (CS-side supersede) before starting a fresh one.
    const GEN_BUDGET_MS = 45_000

    btn.addEventListener('click', () => {
      const entryUrl = readEntryUrl()
      const numProcesso = readNumProcesso()
      if (!entryUrl) { setStatus('Não foi possível ler o link do Download Completo.'); return }
      btn.disabled = true

      // CS-side supersede: abort any in-flight generation from a prior click.
      if (genCtrl) { try { genCtrl.abort() } catch (e) {} }
      genCtrl = new AbortController()
      const ctrl = genCtrl
      // Clear stale results so the poller below doesn't read a previous run's payload/error.
      chrome.storage.local.remove(['ppPayload', 'ppPayloadProcesso', 'ppPayloadAt', 'ppError', 'ppProgress'])

      // The tick shows the generation counter and self-terminates at 61s — a display backstop past the
      // 45s generation budget. This is the hard cap on the "Baixando processo…" display the user asked
      // for — it can no longer run to 100s+.
      const DOWNLOAD_DISPLAY_CAP_S = 61
      secs = 0; stopTick(); tick = setInterval(() => {
        secs++
        if (secs > DOWNLOAD_DISPLAY_CAP_S) {
          stopTick(); btn.disabled = false
          setStatus('Tente novamente ou faça o Download Completo manualmente.')
          chrome.storage.local.set({ ppError: 'timeout' }) // self-heal the exam-page #pp-btn too
          return
        }
        setStatus(`Baixando o processo… (${secs}s)`, true)
      }, 1000)

      // Drive generation in the page session, then hand the ready href to the worker.
      const genTimer = setTimeout(() => { try { ctrl.abort() } catch (e) {} }, GEN_BUDGET_MS)
      generateDownload(entryUrl, () => {}, ctrl.signal)
        .then((hrefs) => {
          clearTimeout(genTimer)
          if (ctrl !== genCtrl) return // superseded by a newer click
          try {
            chrome.runtime.sendMessage({ cmd: 'PP_FETCH_PDF', hrefs, numProcesso })
          } catch (e) {
            stopTick(); btn.disabled = false
            setStatus('Recarregue a página (extensão foi atualizada).')
          }
        })
        .catch((err) => {
          clearTimeout(genTimer)
          if (ctrl !== genCtrl) return // superseded — a newer click owns the UI now
          stopTick(); btn.disabled = false
          const timedOut = err && err.name === 'AbortError'
          setStatus(timedOut
            ? 'Tente novamente ou faça o Download Completo manualmente.'
            : 'Erro: ' + ((err && err.message) || 'erro'))
          chrome.storage.local.set({ ppError: timedOut ? 'timeout' : ((err && err.message) || 'erro') })
        })

      if (poll) clearInterval(poll)
      const deadline = Date.now() + 160_000 // whole-run backstop — outlives generation (45s) + worker pipeline (90s) + slack; the 61s tick cap bounds the generation-phase display separately
      poll = setInterval(() => {
        chrome.storage.local.get(['ppPayload', 'ppPayloadProcesso', 'ppError', 'ppProgress'], (d) => {
          if (d.ppProgress) {
            const p = d.ppProgress
            if (p.phase === 'segmenting') { stopTick(); setStatus('Segmentando…', true) }
            else if (p.phase === 'processing') { stopTick(); setStatus(`Extraindo dados (${p.i}/${p.total})`, true) }
          }
          if (d.ppPayload && d.ppPayloadProcesso === numProcesso) {
            clearInterval(poll); stopTick(); btn.disabled = false
            setStatus('Pronto! Abra o Laudo e clique em Pré-preencher.')
          } else if (d.ppError) {
            clearInterval(poll); stopTick(); btn.disabled = false
            setStatus(d.ppError === 'timeout'
              ? 'Tente novamente ou faça o Download Completo manualmente.'
              : 'Erro: ' + d.ppError)
          } else if (Date.now() > deadline) {
            clearInterval(poll); stopTick(); btn.disabled = false
            setStatus('Tempo esgotado. Tente novamente.')
            // Q5: publish the timeout so the exam page's #pp-btn self-heals out of "Extraindo…".
            chrome.storage.local.set({ ppError: 'timeout' })
          }
        })
      }, 800)
    })
  }

  // Q2: the Ações toolbar is JS-rendered AND can re-render — match the exam page's proven pattern:
  // a never-disconnecting MutationObserver + debounced inject, idempotent via the #pp-analisar-btn
  // guard inside inject(). (Replaces the old finite setInterval, which gave up after 10 s and never
  // recovered if e-proc re-rendered the toolbar.)
  let injectDebounce = null
  const scheduleInject = () => { if (injectDebounce) clearTimeout(injectDebounce); injectDebounce = setTimeout(inject, 150) }
  new MutationObserver(scheduleInject).observe(document.documentElement, { childList: true, subtree: true })
  inject()
})()

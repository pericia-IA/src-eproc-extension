// Shared e-proc Download-Completo helpers, loaded in BOTH contexts (manifest content_scripts on
// eproc1g + importScripts in preencher-worker.js) — same pattern as pipeline.js. Pure string/regex,
// no window/document, so it loads in the MV3 service worker (see memory mv3-worker-constraints).
//
// Split-by-context rationale (live-proven 2026-06-26): generation (POST Gerar + poll, same-origin
// eproc1g) runs ~6-8x FASTER in the page/content-script session than in the worker (7-15s vs 38-59s),
// so generateDownload() runs in the content script. Only the cross-origin eproc1g-down PDF byte fetch
// is CORS-blocked for content scripts, so that stays in the worker.

function decodeHtml(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}
function findDownloadHref(html) {
  const m = html.match(/href\s*=\s*["']([^"']*eproc1g-down\.trf6\.jus\.br[^"']*)["']/i)
  return m ? decodeHtml(m[1]) : null
}
// Find ALL download links, ordered for merge. e-proc may split a large process into
// "BAIXAR ARQUIVO PARTE 1/2/3…" links; each part is its own <a> whose visible text carries the
// part number. Returns an ordered string[] of hrefs (length ≥ 1).
//  - Exactly one link  → [href], no part parsing (the plain "BAIXAR ARQUIVO" / merged-file case;
//    behaves exactly as findDownloadHref did — this is the single-link path).
//  - Two or more links → parse each anchor's "PARTE N" from its own text and sort ascending. If any
//    of them lacks a parseable part number, THROW (caller shows a manual-download message) rather
//    than silently guess an order — for multi-part we refuse instead of scrambling the pages.
function findDownloadHrefs(html) {
  // e-proc renders each downloadable FILE with more than one <a> to the SAME href — a magnifying-glass
  // "Visualizar" icon anchor AND the "BAIXAR ARQUIVO" text anchor (live-confirmed 2026-07-09). So we
  // key on the distinct href (= one file), NOT the anchor count. Single part → href ends in the file
  // name (e.g. "BAIXAR ARQUIVO", one distinct href). Multi-part → distinct hrefs, each file name
  // carrying "_PARTE_N" (and the text saying "PARTE N"). Returns ordered string[] of distinct hrefs.
  const re = /href\s*=\s*["']([^"']*eproc1g-down\.trf6\.jus\.br[^"']*)["']/gi
  const byHref = new Map() // href -> part number (or null)
  let m
  while ((m = re.exec(html)) !== null) {
    const href = decodeHtml(m[1])
    // Prefer the part number from the file name in the href (robust: present even on the icon anchor);
    // e.g. ..._PARTE_1.PDF. This avoids depending on which of the duplicate anchors we happened to see.
    const partM = href.match(/_PARTE_(\d+)/i)
    const part = partM ? parseInt(partM[1], 10) : null
    // First occurrence wins, but let a later occurrence supply a part number the first one lacked.
    if (!byHref.has(href)) byHref.set(href, part)
    else if (byHref.get(href) === null && part !== null) byHref.set(href, part)
  }

  const links = [...byHref.entries()].map(([href, part]) => ({ href, part }))
  if (links.length === 0) return []
  if (links.length === 1) return [links[0].href] // one file: no ordering needed (single-link path)
  // Multi-part: every distinct file must carry a parseable PARTE number, else we can't trust the order.
  if (links.some((l) => l.part === null)) {
    throw new Error('Não foi possível ordenar as partes do download — faça o Download Completo manualmente.')
  }
  return links.slice().sort((a, b) => a.part - b.part).map((l) => l.href)
}
// ── e-proc download state classifiers (live-mapped 2026-06-24) ───────────────
function isProcessing(html) { return /Em processamento/i.test(html) } // generation running
function isScheduled(html) { return /agendado com sucesso/i.test(html) } // scheduled page
function isGenerateForm(html) { // the single-process generate form
  return /id\s*=\s*["']frmProcessosSelecionados["']/i.test(html) ||
    /id\s*=\s*["']btnGerar["']/i.test(html)
}
// Session not carried → e-proc returns login HTML (200 OK). Detect it for a clear error.
function isLoginPage(html) {
  return /name\s*=\s*["']txtUsuario["']|Acesso ao Sistema|senha/i.test(html) &&
    !isGenerateForm(html) && !findDownloadHref(html) && !isProcessing(html) && !isScheduled(html)
}
function absolutize(u) {
  u = decodeHtml(u)
  if (u.startsWith('controlador.php')) return 'https://eproc1g.trf6.jus.br/eproc/' + u
  if (u.startsWith('/')) return 'https://eproc1g.trf6.jus.br' + u
  return u
}
// Read one attribute from a tag, attribute-order-independent.
function attr(tag, name) {
  const m = tag.match(new RegExp(name + '\\s*=\\s*["\']([^"\']*)["\']', 'i'))
  return m ? m[1] : null
}
// Parse the single-process generate form: its action URL + all its submittable fields.
function scrapeGenerateForm(html) {
  const formIdx = html.search(/id\s*=\s*["']frmProcessosSelecionados["']/i)
  if (formIdx < 0) return null
  const formStart = html.lastIndexOf('<form', formIdx)
  const formEnd = html.indexOf('</form>', formStart)
  if (formStart < 0 || formEnd < 0) return null
  const formTag = html.slice(formStart, html.indexOf('>', formStart) + 1)
  const body = html.slice(formStart, formEnd)

  const action = attr(formTag, 'action')
  if (!action) return null
  const actionUrl = absolutize(action)

  const fields = []
  for (const tag of body.match(/<input\b[^>]*>/gi) || []) {
    const name = attr(tag, 'name')
    if (!name) continue
    const type = (attr(tag, 'type') || 'text').toLowerCase()
    if (type === 'submit' || type === 'button' || type === 'image' || type === 'file' || type === 'reset') continue
    if ((type === 'checkbox' || type === 'radio') && !/\bchecked\b/i.test(tag)) continue // only checked
    fields.push({ name, value: decodeHtml(attr(tag, 'value') || '') })
  }
  for (const sel of body.match(/<select\b[\s\S]*?<\/select>/gi) || []) {
    const name = attr(sel, 'name')
    if (!name) continue
    if (name === 'selDiminuirQualidadePdf') continue // never opt into image recompression (Etapa 1.5); PDF is machine-read only. Omitting the field matches the manual "no boxes checked" POST (which lacks it entirely).
    const opt = sel.match(/<option[^>]*\bselected\b[^>]*value\s*=\s*["']([^"']*)["']/i) ||
      sel.match(/<option[^>]*value\s*=\s*["']([^"']*)["']/i)
    fields.push({ name, value: decodeHtml(opt ? opt[1] : '') })
  }
  if (fields.length === 0) return null
  return { actionUrl, fields }
}

const GEN_POLL_MS = 1000 // re-GET entryUrl ~every 1s while generating (matches the perito's F5 cadence)
// Signal-aware sleep: rejects (AbortError) the instant the signal aborts, so the generation budget is
// a true ceiling even mid-wait.
function ppSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const t = setTimeout(resolve, ms)
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
  })
}
async function getText(url, signal) {
  const r = await fetch(url, { credentials: 'include', signal })
  if (!r.ok) throw new Error('e-proc ' + r.status)
  return r.text()
}

// Drive e-proc generation from the (fast) page session and return the ready eproc1g-down href.
// Runs in the CONTENT SCRIPT. Every await is signal-bound, so the caller's generation-budget abort is
// the hard bound. onProgress({phase:'generating'}) fires once at loop entry.
async function generateDownload(entryUrl, onProgress, signal) {
  const firstHtml = await getText(entryUrl, signal)
  if (isLoginPage(firstHtml)) throw new Error('Sessão expirada — faça login no e-proc e tente novamente.')

  // State B — a merged file already exists (<72h): return its href(s) directly, no generation.
  // (Already-generated files are all present at once, so no stability wait is needed here.)
  const directHrefs = findDownloadHrefs(firstHtml)
  if (directHrefs.length) return directHrefs

  // State A — submit the Gerar form (page session = fast generation).
  if (!isGenerateForm(firstHtml)) throw new Error('Estado inesperado do e-proc.')
  const form = scrapeGenerateForm(firstHtml)
  if (!form) throw new Error('Formulário do e-proc mudou (State A não lido).')
  if (onProgress) onProgress({ phase: 'generating' })

  const body = new URLSearchParams()
  for (const f of form.fields) body.append(f.name, f.value)
  const gerarResp = await fetch(form.actionUrl, {
    method: 'POST', credentials: 'include', signal,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!gerarResp.ok) throw new Error('e-proc ' + gerarResp.status)
  const pollUrl = gerarResp.url
  let html = await gerarResp.text()
  if (!/agendar_geracao_arquivo_processo_completo/i.test(pollUrl))
    throw new Error('e-proc não agendou a geração (tente novamente).')

  // Wait loop — GET the stable pollUrl each cycle until the BAIXAR ARQUIVO link(s) appear.
  // Stability rule (multi-part safety): we do NOT assume e-proc publishes all "PARTE N" links in one
  // cycle. Once ≥1 link is present, we poll once more and only return when the link COUNT is unchanged
  // for a full extra cycle — so we never grab an incomplete set (e.g. PARTE 1 alone while 2/3 are
  // still landing). A single link stabilizes immediately (count 1 both cycles), so this adds at most
  // one poll to the single-link path.
  let prevCount = 0
  while (true) {
    const hrefs = findDownloadHrefs(html)
    if (hrefs.length > 0 && hrefs.length === prevCount) return hrefs // count stable across a cycle
    prevCount = hrefs.length
    await ppSleep(GEN_POLL_MS, signal)
    html = await getText(pollUrl, signal)
    if (isLoginPage(html)) throw new Error('Sessão expirada — faça login no e-proc e tente novamente.')
  }
}

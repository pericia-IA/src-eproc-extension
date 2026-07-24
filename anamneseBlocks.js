// Splits #txaHistoricoAnamnese so the interview transcript is spliced into ONLY
// the DO PERICIANDO block. Loaded as a content script BEFORE eproc-fill.js and
// exposed via self.AnamneseBlocks; also module.exports'd for backend Jest tests.
//
// reassemble() does an IN-PLACE splice: it replaces only the DO PERICIANDO body's
// exact character span and keeps everything else (other blocks, their order, any
// stray notes) byte-for-byte. It never rebuilds from a canonical template, so it
// cannot drop or reorder the doctor's text.
;(function () {
  const NBSP = ' '
  const HEADERS = ['DA PETIÇÃO INICIAL', 'DO PERICIANDO', 'HISTÓRICO DE BENEFÍCIOS']
  const norm = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()

  // Find a header on its own line, tolerant of case/accents/trailing colon+spaces.
  // Returns { headerStart, bodyStart } (indices into the ORIGINAL text) or null.
  function findHeader(text, header) {
    const normText = norm(text)
    const normHeader = norm(header)
    const re = new RegExp(
      '(^|\\n)' + normHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[ \\t]*:?[ \\t]*(\\n|$)',
    )
    const m = normText.match(re)
    if (!m) return null
    const headerStart = m.index + (m[1] ? m[1].length : 0)
    const bodyStart = m.index + m[0].length // first char after the matched header line
    return { headerStart, bodyStart }
  }

  function splitAnamneseBlocks(raw) {
    const text = raw || ''
    const hadNbsp = text.charCodeAt(0) === 0x00a0

    const found = []
    for (const h of HEADERS) {
      const pos = findHeader(text, h)
      if (pos) found.push({ header: h, headerStart: pos.headerStart, bodyStart: pos.bodyStart })
    }
    found.sort((a, b) => a.headerStart - b.headerStart)
    const peric = found.find((f) => f.header === 'DO PERICIANDO')

    // FALLBACK: no known headers -> keep original text, append a DO PERICIANDO block.
    if (found.length === 0) {
      return {
        periciandoBody: '',
        fallback: true,
        reassemble(newBody) {
          const base = text.replace(/\s+$/, '')
          const block = 'DO PERICIANDO\n' + newBody
          const joined = base ? base + '\n\n' + block : block
          return hadNbsp || !base ? NBSP + '\n' + joined : joined
        },
      }
    }

    // CASE A: DO PERICIANDO present -> in-place splice of its body span only.
    if (peric) {
      const next = found.find((f) => f.headerStart > peric.headerStart)
      // Body ends at the next KNOWN header. If none, end at the first blank-line
      // boundary after the body so any unheadered stray note the doctor typed
      // afterward is treated as OUTSIDE the block (never sent to Claude, never
      // overwritten). This favors safety: worst case we send less, never drop text.
      let bodyEnd
      if (next) {
        bodyEnd = next.headerStart
      } else {
        const blank = text.indexOf('\n\n', peric.bodyStart)
        bodyEnd = blank === -1 ? text.length : blank
      }
      const rawBody = text.slice(peric.bodyStart, bodyEnd)
      const periciandoBody = rawBody.replace(/^\n+/, '').replace(/\s+$/, '')
      return {
        periciandoBody,
        fallback: false,
        reassemble(newBody) {
          const trailing = rawBody.match(/\s*$/)[0] // keep original spacing before next block
          const before = text.slice(0, peric.bodyStart)
          const after = text.slice(bodyEnd)
          return before + newBody + trailing + after
        },
      }
    }

    // CASE B: other block(s) present but no DO PERICIANDO -> insert (after petição /
    // before benefícios) without disturbing surrounding text.
    const peticao = found.find((f) => f.header === 'DA PETIÇÃO INICIAL')
    const beneficios = found.find((f) => f.header === 'HISTÓRICO DE BENEFÍCIOS')
    return {
      periciandoBody: '',
      fallback: false,
      reassemble(newBody) {
        const block = 'DO PERICIANDO\n' + newBody
        if (beneficios) {
          const at = beneficios.headerStart
          const before = text.slice(0, at).replace(/\s+$/, '')
          const after = text.slice(at)
          return before + '\n\n' + block + '\n\n' + after
        }
        if (peticao) {
          return text.replace(/\s+$/, '') + '\n\n' + block
        }
        return text.replace(/\s+$/, '') + '\n\n' + block
      },
    }
  }

  if (typeof self !== 'undefined') self.AnamneseBlocks = { splitAnamneseBlocks }
  if (typeof module !== 'undefined' && module.exports) module.exports = { splitAnamneseBlocks }
})()

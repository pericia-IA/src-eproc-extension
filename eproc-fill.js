// Runs on eproc1g.trf6.jus.br. Detects the Laudo fill form, reads stored
// payload, runs name-match safety check, and fills the five text fields on click.
(function () {
  if (!window.location.href.includes('acao=laudo_pericial_alterar')) return

  const BACKEND_ORIGIN = 'https://api.periciahub.com'

  // ── Field mapping (single source of truth for e-proc selectors) ──────────────
  // Each entry: { selector, key (matches payload.fields.*), label (UI message) }.
  // Keep in sync with CLAUDE.md's field-mapping line.
  const FIELD_MAP = [
    { selector: '#txtUltimaAtividade', key: 'ultimaAtividade', label: 'Última Atividade' },
    { selector: 'input#txtTarefasExigidasUltimaAtividade.infraText', key: 'tarefas', label: 'Tarefas' },
    { selector: 'input#txtFormacaoTecnicoProfissional.infraText', key: 'escolaridade', label: 'Escolaridade' },
    { selector: 'input#txtExperienciasLaboraisAnt.infraText', key: 'experienciasLaborais', label: 'Experiências Laborais' },
    { selector: '#txaHistoricoAnamnese', key: 'historicoAnamnese', label: 'Histórico/Anamnese' },
    { selector: 'input#txtQuantoTempoUltimaAtividade.infraText', key: 'quantoTempoUltimaAtividade', label: 'Quanto tempo na última atividade' },
    { selector: 'input#txtAteQuandoUltimaAtividade.infraText', key: 'ateQuandoUltimaAtividade', label: 'Até quando última atividade' },
    { selector: 'textarea#txaDadoComplementarPericia032.infraTextarea', key: 'resultadoDiverso', label: 'Resultado diverso', leadingNbsp: true },
    { selector: 'textarea#txaObservacoesTratamento.infraTextarea', key: 'observacoesTratamento', label: 'Observações sobre o tratamento' },
    { selector: 'input#txtDID.infraText', key: 'did', label: 'DID' },
    { selector: 'textarea#txaDocumentosMedicosAnalisados.infraTextarea', key: 'documentosMedicos', label: 'Documentos médicos', leadingNbsp: true },
    { selector: 'textarea#txaExameFisicoMental.infraTextarea', key: 'exameFisico', label: 'Exame físico', leadingNbsp: true },
    { selector: 'textarea#txaDadoComplementarPericia034.infraTextarea', key: 'metodologia', label: 'Metodologia' },
    { selector: '#txaQuesitoParteAutora', key: 'quesitosRequerente', label: 'Quesitos da parte autora', skipIfFilled: true },
  ]

  // ── Fixed Sim/Não answers ────────────────────────────────────────────────────
  // Auto-applied on every successful "Pré-preencher" fill (applyFixedRadios). Constant for now
  // (one may become prompt-driven later). Each id is the radio to CHECK. e-proc inline onchange
  // handlers (e.g. changePacienteDoPerito) require a dispatched bubbling 'change' event — setting
  // .checked alone is not enough. Our four onchange-bearing answers are all Não (the hide/permissive
  // direction), so the handlers only collapse their own obs-div and never touch a FIELD_MAP field.
  const FIXED_RADIOS = [
    'rdoPacienteDoPeritoNAO',
    'rdoReabilitacaoProfissionalNAO',
    'rdoDoencaTrabalhoAcidenteNAO',
    'rdoAutorDoencasNAO',
    'rdoAutorCooperaTratamentoSIM',
    'rdoTratamentoMantidoBeneficioPrevioSIM',
    'rdoNAODadoComplementarPericia029',
    'rdoNAODadoComplementarPericia033',
  ]

  // Check each FIXED_RADIOS target and fire 'change' so e-proc's inline onchange handlers run.
  // Already-checked and missing ids are skipped (best-effort extras; never block the text fill).
  // beneficioPrevioRadio === 'B' (from the beneficios result's "Sem auxílio-doença prévio"
  // sentinel) swaps the default SIM for the 4th option ("Não é caso de benefício prévio").
  // The 4 options share one radio name, so checking the 4th auto-unchecks SIM.
  const BENEFICIO_PREVIO_SIM = 'rdoTratamentoMantidoBeneficioPrevioSIM'
  const BENEFICIO_PREVIO_NAO_CASO = 'rdoTratamentoMantidoBeneficioPrevioNaoEhOCasoBeneficio'
  function applyFixedRadios(payload) {
    const flipBeneficioPrevio = payload && payload.fields && payload.fields.beneficioPrevioRadio === 'B'
    for (const fixedId of FIXED_RADIOS) {
      const id = (fixedId === BENEFICIO_PREVIO_SIM && flipBeneficioPrevio) ? BENEFICIO_PREVIO_NAO_CASO : fixedId
      const el = document.getElementById(id)
      if (!el || el.checked) continue
      el.checked = true
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
  }

  // ── Name normalisation ──────────────────────────────────────────────────────
  function norm(s) {
    return s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/\s+/g, ' ')
      .trim()
  }

  // #lblNomeExaminado contains our injected #pp-btn; read only the real name (exclude our nodes).
  function readExamineeName() {
    const lbl = document.querySelector('#lblNomeExaminado')
    if (!lbl) return ''
    const clone = lbl.cloneNode(true)
    clone.querySelectorAll('#pp-btn, #pl-btn, .pl-status, button, span').forEach((n) => n.remove())
    return (clone.textContent || '').trim()
  }

  // ── Levenshtein distance ────────────────────────────────────────────────────
  function levenshtein(a, b) {
    const m = a.length, n = b.length
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
    for (let j = 0; j <= n; j++) dp[0][j] = j
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
      }
    }
    return dp[m][n]
  }

  // ── Name-match bands ────────────────────────────────────────────────────────
  // Returns 'exact' | 'close' | 'far'
  function matchBand(pageRaw, storedRaw) {
    const page = norm(pageRaw)
    const stored = norm(storedRaw)

    if (page === stored) return 'exact'

    // Sorted-token match (handles reordered names)
    const sortTokens = s => s.split(' ').sort().join(' ')
    if (sortTokens(page) === sortTokens(stored)) return 'close'

    // Levenshtein on full normalised strings — threshold relative to length
    const threshold = Math.max(3, Math.floor(Math.min(page.length, stored.length) * 0.1))
    if (levenshtein(page, stored) <= threshold) return 'close'

    return 'far'
  }

  // ── Fill a single field ─────────────────────────────────────────────────────
  // Returns: 'filled' | 'skipped' (empty value OR skipIfFilled field already has content) | 'missing' (selector not found)
  const NBSP = '\u00A0' // U+00A0 non-breaking space; e-proc wants a leading NBSP + newline
  function fillField(selector, value, leadingNbsp, skipIfFilled) {
    const el = document.querySelector(selector)
    if (!el) return 'missing'
    if (!value || !value.trim()) return 'skipped'
    // Never overwrite a field already populated (e.g. quesitos the system carried in). .trim() strips NBSP, so an NBSP-only field counts as empty and IS filled.
    if (skipIfFilled && el.value && el.value.trim()) return 'skipped'
    el.value = leadingNbsp ? NBSP + '\n' + value : value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return 'filled'
  }

  // ── Render status message near the button ───────────────────────────────────
  // Low-level: render into a .pl-status <span> directly. Rebuilds the span so the
  // spinner icon (when spinning) sits before the text; textContent alone would wipe
  // a child <img>.
  function renderStatus(el, msg, isError, spinning) {
    el.style.color = isError ? '#B91C1C' : '#5B21B6'
    el.textContent = ''
    if (spinning) {
      const img = document.createElement('img')
      img.className = 'ph-spinner'
      img.src = chrome.runtime.getURL('icons/final_icon32.png')
      img.alt = ''
      el.appendChild(img)
    }
    el.appendChild(document.createTextNode(msg))
  }

  // Container-level: find/create the .pl-status span inside a button container.
  function showStatus(container, msg, isError, spinning) {
    let el = container.querySelector('.pl-status')
    if (!el) {
      el = document.createElement('span')
      el.className = 'pl-status'
      el.style.cssText = 'margin-left:10px;font-size:13px;'
      container.appendChild(el)
    }
    renderStatus(el, msg, isError, spinning)
  }

  // ── Main fill action ────────────────────────────────────────────────────────
  function doFill(payload, pageNameRaw, btn, skipNameCheck) {
    // Name-match safety check. Skipped for prepared fills (the process number already matched, which
    // is the stronger cross-patient guard and avoids OCR name drift). Kept for manual uploads, which
    // have no process gate — there it's the only guard, and it reports WHAT differs.
    if (!skipNameCheck && payload.examinee && payload.examinee.trim()) {
      const band = matchBand(pageNameRaw, payload.examinee)

      if (band === 'far') {
        showStatus(btn.parentElement, `O nome do exame não confere com o do laudo enviado: e-proc mostra "${norm(pageNameRaw)}", o laudo é de "${norm(payload.examinee)}". Não preenchido.`, true)
        return
      }

      if (band === 'close') {
        const ok = window.confirm(
          `Os nomes diferem levemente.\ne-proc mostra: "${pageNameRaw}"\nLaudo enviado: "${payload.examinee}"\nPreencher mesmo assim?`
        )
        if (!ok) return
      }
    }

    const outcomes = FIELD_MAP.map(f => ({
      label: f.label,
      result: fillField(f.selector, payload.fields[f.key], f.leadingNbsp, f.skipIfFilled),
    }))

    const missing = outcomes.filter(o => o.result === 'missing').map(o => o.label)
    if (missing.length > 0) {
      showStatus(btn.parentElement, `Não foi possível preencher: ${missing.join(', ')}`, true)
      return
    }

    const filledCount = outcomes.filter(o => o.result === 'filled').length
    if (filledCount === 0) {
      showStatus(btn.parentElement, 'Nenhum dado disponível para preencher.', true)
      return
    }

    chrome.storage.local.remove('laudoFillData')
    showStatus(btn.parentElement, 'Revise e clique em Salvar.', false)
    btn.disabled = true
  }

  // ── Inject the button once #lblNomeExaminado is present ────────────────────
  function injectButton() {
    const nameLabel = document.querySelector('#lblNomeExaminado')
    if (!nameLabel || document.querySelector('#pl-btn')) return

    const btn = document.createElement('button')
    btn.id = 'pl-btn'
    btn.type = 'button'
    btn.textContent = 'Preencher Laudo'
    btn.style.cssText = [
      'margin-left:12px',
      'padding:4px 12px',
      'background:#2980b9',
      'color:#fff',
      'border:none',
      'border-radius:4px',
      'cursor:pointer',
      'font-size:13px',
    ].join(';')

    const container = document.createElement('span')
    container.appendChild(btn)
    nameLabel.parentElement.appendChild(container)

    btn.addEventListener('click', function () {
      chrome.storage.local.get('laudoFillData', function (data) {
        const payload = data.laudoFillData

        if (!payload || !payload.examinee || !payload.fields) {
          showStatus(container, 'Nenhum dado encontrado. Processe o PDF no app primeiro.', true)
          return
        }

        const pageNameRaw = readExamineeName()
        if (!pageNameRaw) {
          showStatus(container, 'Não foi possível ler o nome do examinado na página.', true)
          return
        }

        doFill(payload, pageNameRaw, btn)
      })
    })
  }

  // ── Resposta aos quesitos ─────────────────────────────────────────────────────
  // Read CID(s). VERIFIED against a real CID-populated exam:
  //   #hdnListaCID format = "<id>±<CODE> - <Desc>" entries joined by "¥" (U+00A5),
  //   e.g. "2820±H10.5 - Blefaroconjuntivite¥4588±M11.9 - Artropatia...".
  //   The #txtDesCID input only holds placeholder text → never read it.
  // Primary: parse the hidden field. Fallback: read the visible #tblCID grid rows.
  function readCIDs() {
    const hidden = document.querySelector('#hdnListaCID')
    if (hidden && hidden.value.trim()) {
      return hidden.value
        .split('¥')                                  // ¥ record separator
        .map(e => { const p = e.split('±'); return (p.length === 2 ? p[1] : e).trim() }) // ± after id
        .filter(Boolean)
        .join('; ')
    }
    const tbl = document.querySelector('#tblCID')
    if (!tbl) return ''
    return [...tbl.querySelectorAll('tr')]
      .map(tr => tr.innerText.replace(/\t/g, ' ').replace(/\s*Ações?\s*$/i, '').trim())
      .filter(t => /^[A-Z]\d{2}/.test(t))                 // "M11.9 - ..." rows only
      .join('; ')
  }

  // Context fields whose VALUES are sent (only if non-empty).
  const QUESITOS_READ_MAP = [
    { selector: '#txaHistoricoAnamnese', label: 'Histórico/Anamnese' },
    { selector: '#txaExameFisicoMental', label: 'Exame físico/do estado mental' },
    { selector: '#txaObservacoesTratamento', label: 'Observações sobre o tratamento' },
    { selector: '#txtDID', label: 'DID – data provável de início da doença' },
    { selector: '#txtMotivoIncapacidade', label: 'Motivo alegado da incapacidade' },
    { selector: '#txaCausaProvavelDiagnostico', label: 'Causa provável do diagnóstico' },
  ]

  function collectQuesitosContext() {
    const ctx = []

    for (const f of QUESITOS_READ_MAP) {
      const el = document.querySelector(f.selector)
      const v = el && el.value ? el.value.trim() : ''
      if (v) ctx.push({ label: f.label, value: v })
    }

    const cids = readCIDs()
    if (cids) ctx.push({ label: 'Diagnóstico/CID', value: cids })

    // Selected conclusion + its filled sub-fields (visible + non-empty), labels via label[for].
    document.querySelectorAll('[id*="DadoComplementarPericia"]').forEach(el => {
      if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return
      if (el.offsetParent === null) return // not visible
      const lbl = el.id ? document.querySelector(`label[for="${el.id}"]`) : null
      const label = lbl ? lbl.innerText.trim() : ''
      if (!label) return
      if (el.type === 'checkbox' || el.type === 'radio') {
        if (el.checked) {
          // The 3 top-level conclusion checkboxes get an explicit label so Claude
          // knows which conclusion was selected (rule 6). Sub-radios keep their own label.
          const isConclusion = /^chkDadoComplementarPericia(002|010|018)$/.test(el.id)
          ctx.push({ label: isConclusion ? 'Conclusão selecionada' : label, value: label })
        }
      } else {
        const v = (el.value || '').trim()
        if (v) ctx.push({ label, value: v })
      }
    })

    return ctx
  }

  // ── Conclusão "Justificar" buttons ──────────────────────────────────────────
  // 10 buttons injected next to conclusion-justification textareas. Each appears only when
  // its trigger checkbox/radio path is selected (verified live), reads clinical fields from
  // the page, POSTs to /api/conclusao-justificativa, writes one paragraph back.
  // NOTE: btn1's gate (chk002) is a SUPERSET of btn2's (chk002+rdo004) and btn9's
  // (chk002+rdo005+rdo007), so btn1 co-appears with btn2/btn9 by design — each writes a
  // DIFFERENT textarea, so there is no clobbering.

  // The two split-choice literals (sent verbatim as splitChoice; the prompt emits them as the
  // mandatory "Características:" prefix line). Buttons 2 and 3 are split (Total | Parcial).
  const SPLIT_CHOICES = {
    total: 'Características: Total (para toda e qualquer atividade) e Temporária.',
    parcial: 'Características: Parcial (apenas para a atividade habitual) e Temporária.',
  }

  // Source fields common to all conclusion buttons (sent only when non-empty).
  const CONCL_SHARED_SOURCES = [
    { selector: '#txaExameFisicoMental', label: 'Exame físico/do estado mental' },
    { selector: '#txtUltimaAtividade', label: 'Última atividade laboral exercida' },
    { selector: '#txtMotivoIncapacidade', label: 'Motivo alegado da incapacidade' },
  ]
  // Added to every button EXCEPT button 1.
  const CONCL_DOC_HIST_SOURCES = [
    { selector: '#txaDocumentosMedicosAnalisados', label: 'Documentos médicos analisados' },
    { selector: '#txaHistoricoAnamnese', label: 'Histórico/anamnese' },
  ]

  // Read a field's text whether it's an <input>/<textarea> (.value) or a <label> (.innerText,
  // e.g. #txtIdade — verified live to be a LABEL).
  function readFieldText(selector) {
    const el = document.querySelector(selector)
    if (!el) return ''
    const raw = (el.value !== undefined && el.value !== null && el.tagName !== 'LABEL')
      ? el.value
      : el.innerText
    return (raw || '').trim()
  }

  // .checked is valid on BOTH checkboxes and radios (verified live) — btn2/btn9 radio gates use this too.
  const isChecked = (id) => {
    const el = document.getElementById(id)
    return !!(el && el.checked)
  }

  // Reads a Sim/Não radio pair → 'Sim' | 'Não' | '' (neither). ids are BARE (no '#').
  const readRadioAnswer = (simId, naoId) =>
    isChecked(simId) ? 'Sim' : isChecked(naoId) ? 'Não' : ''

  // The 12 button specs. `trigger()` decides visibility; `sources` are the EXTRA fields beyond
  // CONCL_SHARED_SOURCES (+ CID, added in code; + doc/hist when includeDocHist). `split:true`
  // renders Total|Parcial. `label` overrides the "Justificar" caption. `radioSources` reads a
  // Sim/Não pair. `preflight()` blocks the request with a message. `anchorSelector` overrides the
  // label[for] anchor. `target` is the textarea the result is written into.
  const CONCLUSAO_BTNS = [
    {
      id: 1, split: false,
      trigger: () => isChecked('chkDadoComplementarPericia002'),
      target: '#txaDadoComplementarPericia003_D002_S',
      sources: [], includeDocHist: false,
    },
    {
      id: 2, split: true,
      trigger: () => isChecked('chkDadoComplementarPericia002') && isChecked('rdoSIMDadoComplementarPericia004_D002_S'),
      target: '#txaDadoComplementarPericia046_D004_S',
      sources: [
        { selector: '#txtDadoComplementarPericia004_D002_SPeriodosPeriodoIni1', label: 'Período (início)' },
        { selector: '#txtDadoComplementarPericia004_D002_SPeriodosPeriodoFim1', label: 'Período (fim)' },
      ],
      includeDocHist: true,
    },
    {
      id: 3, split: true,
      trigger: () => isChecked('chkDadoComplementarPericia010'),
      target: '#txaDadoComplementarPericia047_D010_S',
      sources: [], includeDocHist: true,
    },
    {
      id: 4, split: false,
      trigger: () => isChecked('chkDadoComplementarPericia010'),
      target: '#txaDadoComplementarPericia012_D010_S',
      sources: [
        { selector: '#txtDadoComplementarPericia011_D010_S', label: 'DII - Data provável de início da incapacidade' },
        { selector: '#txaDadoComplementarPericia047_D010_S', label: 'Justifique (limitações)' },
      ],
      includeDocHist: true,
    },
    {
      id: 5, split: false,
      trigger: () => isChecked('chkDadoComplementarPericia018') && isChecked('chkDadoComplementarPericia019_D018_S'),
      target: '#txaDadoComplementarPericia048_D019_S',
      sources: [
        { selector: '#txtIdade', label: 'Idade' },
        { selector: '#txtFormacaoTecnicoProfissional', label: 'Formação técnico-profissional' },
      ],
      includeDocHist: true,
    },
    {
      id: 6, split: false,
      trigger: () => isChecked('chkDadoComplementarPericia018') && isChecked('chkDadoComplementarPericia019_D018_S'),
      target: '#txaDadoComplementarPericia022_D019_S',
      sources: [
        { selector: '#txtDadoComplementarPericia020_D019_S', label: 'DII - Data provável de início da incapacidade' },
        { selector: '#txtDadoComplementarPericia021_D019_S', label: 'Data a partir da qual foi possível constatar que a incapacidade era permanente' },
        { selector: '#txaDadoComplementarPericia048_D019_S', label: 'Justifique (limitações)' },
      ],
      includeDocHist: true,
    },
    {
      id: 7, split: false,
      trigger: () => isChecked('chkDadoComplementarPericia018') && isChecked('chkDadoComplementarPericia023_D018_S'),
      target: '#txaDadoComplementarPericia049_D023_S',
      sources: [
        { selector: '#txtIdade', label: 'Idade' },
        { selector: '#txtFormacaoTecnicoProfissional', label: 'Formação técnico-profissional' },
      ],
      includeDocHist: true,
    },
    {
      id: 8, split: false,
      trigger: () => isChecked('chkDadoComplementarPericia018') && isChecked('chkDadoComplementarPericia023_D018_S'),
      target: '#txaDadoComplementarPericia043_D023_S',
      sources: [
        { selector: '#txtDadoComplementarPericia024_D023_S', label: 'DII - Data provável de início da incapacidade' },
        { selector: '#txtDadoComplementarPericia042_D023_S', label: 'Data a partir da qual foi possível constatar que a incapacidade era permanente' },
        { selector: '#txaDadoComplementarPericia049_D023_S', label: 'Justifique (limitações)' },
      ],
      includeDocHist: true,
    },
    {
      // Btn9: "Sem incapacidade atual" (chk002) + "sequela consolidada" (rdo005=Sim) +
      // "reduz a capacidade" (rdo007=Sim). All radios → isChecked reads .checked. No split.
      // Self-contained prompt (backend includeComuns:false).
      id: 9, split: false,
      trigger: () =>
        isChecked('chkDadoComplementarPericia002') &&
        isChecked('rdoSIMDadoComplementarPericia005_D002_S') &&
        isChecked('rdoSIMDadoComplementarPericia007_D005_S'),
      target: '#txaDadoComplementarPericia008_D007_S',
      sources: [], includeDocHist: true,
    },
    {
      // Btn10: chk002 + rdo005=Sim + rdo007=Não (the "no reduction" branch). Anchors to the
      // "Justifique" label of _D007_N. Self-contained prompt (backend includeComuns:false).
      // Reads TWO extra sources beyond Btn9 (intentional): Tarefas + the sequela name ("Qual?").
      id: 10, split: false,
      trigger: () =>
        isChecked('chkDadoComplementarPericia002') &&
        isChecked('rdoSIMDadoComplementarPericia005_D002_S') &&
        isChecked('rdoNAODadoComplementarPericia007_D005_S'),
      target: '#txaDadoComplementarPericia045_D007_N',
      sources: [
        { selector: '#txtTarefasExigidasUltimaAtividade', label: 'Tarefas/funções exigidas para o desempenho da atividade' },
        { selector: '#txtDadoComplementarPericia006_D005_S', label: 'Qual sequela' },
      ],
      includeDocHist: true,
    },
    {
      // Btn11: "Sugerir" — causa provável do diagnóstico. Always visible. Self-contained
      // prompt (backend includeComuns:false), 20-word-per-line list. Red-flags if no CID.
      // CIDs auto-added; includeDocHist supplies anamnese ("Do periciando") + documentos.
      id: 11, split: false, label: 'Sugerir',
      trigger: () => true,
      target: '#txaCausaProvavelDiagnostico',
      sources: [],
      includeDocHist: true,
      preflight: () => readCIDs() ? null : 'Preencha o Diagnóstico/CID',
    },
    {
      // Btn12: "Gerar" — assistência permanente de terceiros. Same trigger as btns 5/6.
      // Keeps shared "Regras comuns" (45-word cap). Branches on the Sim/Não radio answer.
      id: 12, split: false, label: 'Gerar',
      trigger: () => isChecked('chkDadoComplementarPericia018') && isChecked('chkDadoComplementarPericia019_D018_S'),
      target: '#txaDadoComplementarPericia037_D019_S',
      radioSources: [
        {
          simId: 'rdoSIMDadoComplementarPericia035_D019_S',
          naoId: 'rdoNAODadoComplementarPericia035_D019_S',
          label: 'Há necessidade de acompanhamento permanente de terceiros?',
        },
      ],
      sources: [
        { selector: '#txaDadoComplementarPericia048_D019_S', label: 'Justifique (limitações)' },
        { selector: '#txaDadoComplementarPericia022_D019_S', label: 'Justifique (datas)' },
        { selector: '#txtDadoComplementarPericia036_D035_S', label: 'Data de início da assistência permanente de terceiros' },
      ],
      includeDocHist: true,
      preflight: () =>
        readRadioAnswer('rdoSIMDadoComplementarPericia035_D019_S', 'rdoNAODadoComplementarPericia035_D019_S')
          ? null
          : 'Selecione Sim ou Não para acompanhamento permanente de terceiros',
    },
  ]

  // Collect labeled non-empty source fields for one button.
  function collectConclusaoFields(spec) {
    const fields = []
    const push = (label, value) => { if (value) fields.push({ label, value }) }
    for (const s of CONCL_SHARED_SOURCES) push(s.label, readFieldText(s.selector))
    if (spec.includeDocHist) for (const s of CONCL_DOC_HIST_SOURCES) push(s.label, readFieldText(s.selector))
    for (const s of spec.sources) push(s.label, readFieldText(s.selector))
    // radioSources ids are BARE (no '#') — they go through isChecked, unlike `sources` selectors
    // which go through readFieldText/querySelector and keep their '#' prefix.
    for (const r of (spec.radioSources ?? [])) push(r.label, readRadioAnswer(r.simId, r.naoId))
    const cids = readCIDs()
    if (cids) push('Diagnóstico/CID', cids)
    return fields
  }

  // POST one button's payload and write the result into its target textarea.
  // `statusEl` is the shared status <span> in the button's container; `disableEls` are all the
  // <button> elements to disable for the duration (1 for normal, 2 halves for split).
  async function runConclusao(spec, splitChoice, statusEl, disableEls) {
    const targetEl = document.querySelector(spec.target)
    if (!targetEl) {
      statusEl.style.color = '#B91C1C'
      statusEl.textContent = 'Campo de destino não encontrado.'
      return
    }
    // Per-spec preflight (e.g. btn11 requires a CID, btn12 requires a Sim/Não answer).
    // Returns an error string to block the request, or null/undefined to proceed.
    if (spec.preflight) {
      const err = spec.preflight()
      if (err) {
        statusEl.style.color = '#B91C1C'
        statusEl.textContent = err
        return
      }
    }
    disableEls.forEach((b) => { b.disabled = true })
    renderStatus(statusEl, 'Gerando justificativa...', false, true)
    const ctrl = new AbortController()
    const timeoutId = setTimeout(() => ctrl.abort(), 60_000)
    try {
      const resp = await PhAuth.authFetch(`${BACKEND_ORIGIN}/api/conclusao-justificativa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          buttonId: spec.id,
          splitChoice: splitChoice || null,
          fields: collectConclusaoFields(spec),
        }),
        signal: ctrl.signal,
      })
      if (!resp.ok) {
        const e = await resp.json().catch(() => ({}))
        statusEl.style.color = '#B91C1C'
        statusEl.textContent = `Erro: ${e.error || resp.status}`
        return
      }
      const { filledText } = await resp.json()
      if (!filledText || !filledText.trim()) {
        statusEl.style.color = '#B91C1C'
        statusEl.textContent = 'Resposta vazia do servidor.'
        return
      }
      targetEl.value = filledText
      targetEl.dispatchEvent(new Event('input', { bubbles: true }))
      targetEl.dispatchEvent(new Event('change', { bubbles: true }))
      statusEl.style.color = '#5B21B6'
      statusEl.textContent = 'Preenchido. Revise e clique em Salvar.'
    } catch (err) {
      statusEl.style.color = '#B91C1C'
      statusEl.textContent = (err.phAuth || err.phLimit) ? err.message
        : err.name === 'AbortError'
          ? 'Tempo esgotado, tente novamente.'
          : `Erro de conexão: ${err.message}`
    } finally {
      clearTimeout(timeoutId)
      disableEls.forEach((b) => { b.disabled = false })
    }
  }

  const CONCL_TEAL_CSS = [
    'margin-left:8px', 'padding:3px 10px',
    'border-radius:4px', 'cursor:pointer', 'font-size:12px',
  ].join(';')

  // Append a teal "Refinar" button (with single-level undo) into an existing
  // conclusão button container. Reads spec.target, POSTs { buttonId, text } to
  // /api/refine-conclusao, overwrites the field, flips to "Desfazer". Skipped for
  // button 11 by the caller (list output, not a paragraph).
  function appendRefineConclusaoButton(spec, container) {
    const refineBtn = document.createElement('button')
    refineBtn.type = 'button'
    refineBtn.textContent = 'Refinar'
    refineBtn.style.cssText = CONCL_TEAL_CSS
    refineBtn.classList.add('ph-lvl2')

    const status = document.createElement('span')
    status.className = 'pl-status'
    status.style.cssText = 'margin-left:10px;font-size:13px;'

    let snapshot = null // non-null => button is in "Desfazer" state

    refineBtn.addEventListener('click', async function () {
      const ta = document.querySelector(spec.target)
      if (!ta) {
        status.style.color = '#B91C1C'
        status.textContent = 'Campo de destino não encontrado.'
        return
      }

      // DESFAZER branch
      if (snapshot !== null) {
        ta.value = snapshot
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        ta.dispatchEvent(new Event('change', { bubbles: true }))
        snapshot = null
        refineBtn.textContent = 'Refinar'
        status.textContent = ''
        return
      }

      // REFINAR branch
      const text = ta.value ? ta.value.trim() : ''
      if (!text) {
        status.style.color = '#B91C1C'
        status.textContent = 'Gere ou escreva o texto primeiro.'
        return
      }

      refineBtn.disabled = true
      renderStatus(status, 'Refinando...', false, true)
      const ctrl = new AbortController()
      const timeoutId = setTimeout(() => ctrl.abort(), 60_000)
      try {
        const resp = await PhAuth.authFetch(`${BACKEND_ORIGIN}/api/refine-conclusao`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ buttonId: spec.id, text }),
          signal: ctrl.signal,
        })
        if (!resp.ok) {
          const e = await resp.json().catch(() => ({}))
          status.style.color = '#B91C1C'
          status.textContent = `Erro: ${e.error || resp.status}`
          return
        }
        const { filledText } = await resp.json()
        if (!filledText || !filledText.trim()) {
          status.style.color = '#B91C1C'
          status.textContent = 'Resposta vazia do servidor.'
          return
        }
        snapshot = ta.value // capture BEFORE overwrite (raw)
        const hadNbsp = ta.value.charCodeAt(0) === 0x00a0
        ta.value = hadNbsp ? NBSP + '\n' + filledText : filledText
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        ta.dispatchEvent(new Event('change', { bubbles: true }))
        refineBtn.textContent = 'Desfazer'
        status.style.color = '#5B21B6'
        status.textContent = 'Texto refinado. Revise.'
      } catch (err) {
        status.style.color = '#B91C1C'
        status.textContent = (err.phAuth || err.phLimit) ? err.message
          : err.name === 'AbortError'
            ? 'Tempo esgotado, tente novamente.'
            : `Erro de conexão: ${err.message}`
      } finally {
        clearTimeout(timeoutId)
        refineBtn.disabled = false
      }
    })

    container.appendChild(refineBtn)
    container.appendChild(status)
  }

  // Build the button (or split pair) for one spec and anchor it next to its target's label.
  // Idempotent: bails if #concl-btnN already exists.
  function injectConclusaoButton(spec) {
    const containerId = `concl-btn${spec.id}`
    if (document.getElementById(containerId)) return
    const targetId = spec.target.replace(/^#/, '')
    const label = document.querySelector(`label[for="${targetId}"]`)
    // Default anchor is the target's label[for]; spec.anchorSelector overrides it for fields
    // whose label lacks a for= attribute (none today — both new targets have label[for]).
    const anchor = spec.anchorSelector ? document.querySelector(spec.anchorSelector) : label
    if (!anchor) return // not rendered yet; sync will retry on next mutation

    const container = document.createElement('span')
    container.id = containerId
    const status = document.createElement('span')
    status.className = 'pl-status'
    status.style.cssText = 'margin-left:10px;font-size:13px;'

    if (spec.split) {
      const totalBtn = document.createElement('button')
      totalBtn.type = 'button'
      totalBtn.textContent = 'Total'
      totalBtn.style.cssText = CONCL_TEAL_CSS
      totalBtn.classList.add('ph-lvl2')
      const parcialBtn = document.createElement('button')
      parcialBtn.type = 'button'
      parcialBtn.textContent = 'Parcial'
      parcialBtn.style.cssText = CONCL_TEAL_CSS
      parcialBtn.classList.add('ph-lvl2')
      const both = [totalBtn, parcialBtn]
      totalBtn.addEventListener('click', () => runConclusao(spec, SPLIT_CHOICES.total, status, both))
      parcialBtn.addEventListener('click', () => runConclusao(spec, SPLIT_CHOICES.parcial, status, both))
      container.appendChild(totalBtn)
      container.appendChild(parcialBtn)
    } else {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = spec.label || 'Justificar'
      btn.style.cssText = CONCL_TEAL_CSS
      btn.classList.add('ph-lvl2')
      btn.addEventListener('click', () => runConclusao(spec, null, status, [btn]))
      container.appendChild(btn)
    }

    // Button 11 (Sugerir) outputs a per-CID list, not a paragraph — no Refinar pass.
    if (spec.id !== 11) appendRefineConclusaoButton(spec, container)

    container.appendChild(status)
    anchor.appendChild(container)
  }

  // Idempotent: present each button whose trigger() is true, remove it otherwise.
  // Keyed on trigger() (checkbox/radio state) ONLY — e-proc couples checkbox-checked with
  // target-revealed, so we do NOT also test visibility. Safe to call on every mutation.
  function syncConclusaoButtons() {
    for (const spec of CONCLUSAO_BTNS) {
      const existing = document.getElementById(`concl-btn${spec.id}`)
      if (spec.trigger()) {
        if (!existing) injectConclusaoButton(spec)
      } else if (existing) {
        existing.remove()
      }
    }
  }

  function injectQuesitosButton() {
    const legend = document.querySelector('#fldQuesitoParteAutora legend')
    if (!legend || document.querySelector('#rq-btn')) return

    const btn = document.createElement('button')
    btn.id = 'rq-btn'
    btn.type = 'button'
    btn.textContent = 'Resposta aos quesitos'
    btn.style.cssText = [
      'margin-left:12px', 'padding:4px 12px',
      'border-radius:4px', 'cursor:pointer', 'font-size:13px',
    ].join(';')
    btn.classList.add('ph-lvl2')

    const container = document.createElement('span')
    container.appendChild(btn)
    legend.appendChild(container)

    btn.addEventListener('click', async function () {
      const ta = document.querySelector('#txaQuesitoParteAutora')
      const quesitos = ta && ta.value ? ta.value.trim() : ''
      if (!quesitos) {
        showStatus(container, 'favor inserir os quesitos a serem respondidos', true)
        return
      }

      btn.disabled = true
      showStatus(container, 'Gerando respostas...', false, true)
      // Real client-side timeout: if Claude hangs, abort + re-enable instead of
      // leaving the button stuck on "Gerando respostas..." forever.
      const ctrl = new AbortController()
      const timeoutId = setTimeout(() => ctrl.abort(), 90_000)
      try {
        const resp = await PhAuth.authFetch(`${BACKEND_ORIGIN}/api/answer-quesitos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quesitos, context: collectQuesitosContext() }),
          signal: ctrl.signal,
        })
        if (!resp.ok) {
          const e = await resp.json().catch(() => ({}))
          showStatus(container, `Erro: ${e.error || resp.status}`, true)
          btn.disabled = false
          return
        }
        const { filledText } = await resp.json()
        if (!filledText || !filledText.trim()) {
          showStatus(container, 'Resposta vazia do servidor.', true)
          btn.disabled = false
          return
        }
        ta.value = filledText
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        ta.dispatchEvent(new Event('change', { bubbles: true }))
        showStatus(container, 'Respostas preenchidas. Revise e clique em Salvar.', false)
      } catch (err) {
        const msg = (err.phAuth || err.phLimit) ? err.message
          : err.name === 'AbortError'
            ? 'Tempo esgotado, tente novamente.'
            : `Erro de conexão: ${err.message}`
        showStatus(container, msg, true)
        btn.disabled = false
      } finally {
        clearTimeout(timeoutId)
      }
    })
  }

  function injectDescreverButton() {
    const label = document.querySelector('#lblTarefasExigidasUltimaAtividade')
    if (!label || document.querySelector('#desc-btn')) return

    const btn = document.createElement('button')
    btn.id = 'desc-btn'
    btn.type = 'button'
    btn.textContent = 'Descrever'
    btn.style.cssText = [
      'margin-left:12px', 'padding:4px 12px',
      'border-radius:4px', 'cursor:pointer', 'font-size:13px',
    ].join(';')
    btn.classList.add('ph-lvl2')

    // Sibling after the label (NOT a child): avoids <label for=...> click-forwarding
    // to the target input and cramping the half-width table cell.
    const container = document.createElement('span')
    container.appendChild(btn)
    label.insertAdjacentElement('afterend', container)

    btn.addEventListener('click', async function () {
      const src = document.querySelector('#txtUltimaAtividade')
      const atividade = src && src.value ? src.value.trim() : ''
      if (!atividade) {
        showStatus(container, 'Preencher a última atividade laboral exercida', true)
        return
      }

      btn.disabled = true
      showStatus(container, 'Gerando descrição...', false, true)
      const ctrl = new AbortController()
      const timeoutId = setTimeout(() => ctrl.abort(), 60_000)
      try {
        const resp = await PhAuth.authFetch(`${BACKEND_ORIGIN}/api/describe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ atividade }),
          signal: ctrl.signal,
        })
        if (!resp.ok) {
          const e = await resp.json().catch(() => ({}))
          showStatus(container, `Erro: ${e.error || resp.status}`, true)
          btn.disabled = false
          return
        }
        const { filledText } = await resp.json()
        if (!filledText || !filledText.trim()) {
          showStatus(container, 'Resposta vazia do servidor.', true)
          btn.disabled = false
          return
        }
        const dest = document.querySelector('#txtTarefasExigidasUltimaAtividade')
        dest.value = filledText
        dest.dispatchEvent(new Event('input', { bubbles: true }))
        dest.dispatchEvent(new Event('change', { bubbles: true }))
        showStatus(container, '', false)
        btn.disabled = false
      } catch (err) {
        const msg = (err.phAuth || err.phLimit) ? err.message
          : err.name === 'AbortError'
            ? 'Tempo esgotado, tente novamente.'
            : `Erro de conexão: ${err.message}`
        showStatus(container, msg, true)
        btn.disabled = false
      } finally {
        clearTimeout(timeoutId)
      }
    })
  }

  // "Adicionar": upload/drop a file -> backend OCR + Claude -> APPEND transcription
  // to #txaDocumentosMedicosAnalisados. Differs from sibling buttons: input is a file
  // (not a DOM field), and output is appended (never overwrites). The textarea itself
  // is the drop zone (drag-only highlight; text drags pass through untouched).
  function injectAdicionarButton() {
    const label = document.querySelector('#lblDocumentosMedicosAnalisados')
    if (!label || document.querySelector('#adicionar-btn')) return

    const btn = document.createElement('button')
    btn.id = 'adicionar-btn'
    btn.type = 'button'
    btn.textContent = 'Adicionar'
    btn.style.cssText = [
      'margin-left:12px', 'padding:4px 12px',
      'border-radius:4px', 'cursor:pointer', 'font-size:13px',
    ].join(';')
    btn.classList.add('ph-lvl2')

    // Inside the <label>, on the same line as the title text (matches the Refinar buttons).
    // The label is display:block above the textarea, so "afterend" would drop the button onto
    // the next line, below the field. The click handler calls e.preventDefault() to stop
    // label[for] from forwarding the click to the textarea.
    const container = document.createElement('span')
    container.appendChild(btn)
    label.appendChild(container)

    // Hidden file input (single file, accepted types).
    const fileInput = document.createElement('input')
    fileInput.type = 'file'
    fileInput.accept = 'image/jpeg,image/png,image/webp,application/pdf'
    fileInput.style.display = 'none'
    container.appendChild(fileInput)

    const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
    const ta = document.querySelector('#txaDocumentosMedicosAnalisados')

    // ── upload pipeline ──────────────────────────────────────────────────────
    async function sendFile(file) {
      if (!file) return
      if (!ACCEPTED.includes(file.type)) {
        showStatus(container, 'Tipo não suportado. Use JPG, PNG, WEBP ou PDF.', true)
        return
      }
      btn.disabled = true
      showStatus(container, 'Transcrevendo...', false, true)
      const ctrl = new AbortController()
      const timeoutId = setTimeout(() => ctrl.abort(), 60_000)
      try {
        const fd = new FormData()
        fd.append('file', file)
        const resp = await PhAuth.authFetch(`${BACKEND_ORIGIN}/api/transcribe-documentos`, {
          method: 'POST', body: fd, signal: ctrl.signal,
        })
        if (!resp.ok) {
          const e = await resp.json().catch(() => ({}))
          showStatus(container, `Erro: ${e.error || resp.status}`, true)
          btn.disabled = false
          return
        }
        const { filledText } = await resp.json()
        if (!filledText || !filledText.trim()) {
          showStatus(container, 'Resposta vazia do servidor.', true)
          btn.disabled = false
          return
        }
        const dest = document.querySelector('#txaDocumentosMedicosAnalisados')
        dest.value = dest.value ? dest.value + '\n\n' + filledText : filledText
        dest.dispatchEvent(new Event('input', { bubbles: true }))
        dest.dispatchEvent(new Event('change', { bubbles: true }))
        showStatus(container, 'Documento adicionado. Revise e clique em Salvar.', false)
        btn.disabled = false
      } catch (err) {
        const msg = (err.phAuth || err.phLimit) ? err.message
          : err.name === 'AbortError'
            ? 'Tempo esgotado, tente novamente.'
            : `Erro de conexão: ${err.message}`
        showStatus(container, msg, true)
        btn.disabled = false
      } finally {
        clearTimeout(timeoutId)
      }
    }

    btn.addEventListener('click', (e) => {
      e.preventDefault() // stop label[for] forwarding the click to the textarea
      fileInput.click()
    })
    fileInput.addEventListener('change', () => {
      sendFile(fileInput.files && fileInput.files[0])
      fileInput.value = '' // allow re-selecting the same file
    })

    // ── drag-only drop zone on the textarea ──────────────────────────────────
    // Only react to FILE drags; text drags pass through to the browser so in-field
    // text editing still works and a dropped file never navigates the tab away.
    if (ta) {
      const isFileDrag = (e) =>
        e.dataTransfer && Array.prototype.includes.call(e.dataTransfer.types || [], 'Files')
      const ORIGINAL_OUTLINE = ta.style.outline
      const highlight = (on) => {
        ta.style.outline = on ? '2px dashed #5B21B6' : ORIGINAL_OUTLINE
        ta.style.outlineOffset = on ? '2px' : ''
      }
      ta.addEventListener('dragover', (e) => {
        if (!isFileDrag(e)) return
        e.preventDefault()
        highlight(true)
        showStatus(container, 'Solte o documento aqui', false)
      })
      ta.addEventListener('dragleave', (e) => {
        if (!isFileDrag(e)) return
        highlight(false)
        showStatus(container, '', false)
      })
      ta.addEventListener('drop', (e) => {
        if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return
        e.preventDefault()
        highlight(false)
        if (e.dataTransfer.files.length > 1) {
          showStatus(container, 'Envie apenas um arquivo por vez.', true)
          return
        }
        sendFile(e.dataTransfer.files[0])
      })
    }

    // ── persistent drop-zone hint (at-rest affordance) ───────────────────────
    // Always-visible cue that the field below accepts a dragged file. Sits between the
    // label (which holds the Adicionar buttons) and the textarea. The drag-time highlight
    // above is the *active* cue; this is the *resting* cue so the doctor knows to drag in
    // the first place. Injected LAST so a failure here can't skip listener setup. Idempotent.
    if (!document.querySelector('#adicionar-drop-hint')) {
      const hint = document.createElement('div')
      hint.id = 'adicionar-drop-hint'
      hint.style.cssText = [
        'display:flex', 'align-items:center', 'gap:6px',
        'margin:4px 0 2px', 'font-size:12px',
        'color:#5B21B6', // --ph-purple
        'user-select:none',
      ].join(';')
      // Inline SVG (tray-with-down-arrow). Vector, not emoji.
      hint.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
        'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
        'stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M12 3v12"/><path d="m7 12 5 5 5-5"/>' +
        '<path d="M5 21h14"/></svg>' +
        '<span>Arraste um documento aqui ou use os botões acima</span>'
      // Insert right before the textarea so it reads as that field's caption.
      const taForHint = document.querySelector('#txaDocumentosMedicosAnalisados')
      if (taForHint && taForHint.parentNode) {
        taForHint.parentNode.insertBefore(hint, taForHint)
      } else {
        label.insertAdjacentElement('afterend', hint)
      }
    }
  }

  // "Adicionar por celular": show a QR the doctor scans on their phone. The phone opens a
  // camera-upload page (served by the backend), snaps a document, and POSTs it with a one-time
  // id to the SAME transcribe pipeline. This desktop side polls for the result and appends it
  // to #txaDocumentosMedicosAnalisados — identical append behavior to injectAdicionarButton.
  function injectAdicionarCelularButton() {
    const label = document.querySelector('#lblDocumentosMedicosAnalisados')
    if (!label || document.querySelector('#adicionar-celular-btn')) return

    const btn = document.createElement('button')
    btn.id = 'adicionar-celular-btn'
    btn.type = 'button'
    btn.textContent = 'Adicionar por celular'
    btn.style.cssText = [
      'margin-left:8px', 'padding:4px 12px',
      'border-radius:4px', 'cursor:pointer', 'font-size:13px',
    ].join(';')
    btn.classList.add('ph-lvl2')

    const container = document.createElement('span')
    container.appendChild(btn)
    label.appendChild(container)

    const qrBox = document.createElement('div')
    qrBox.style.cssText = 'margin-top:8px'
    container.appendChild(qrBox)

    let pollTimer = null
    let pollDeadline = 0

    function stopPolling() {
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
    }

    async function poll(id) {
      if (Date.now() > pollDeadline) {
        stopPolling()
        showStatus(container, 'QR expirado. Clique novamente.', true)
        qrBox.innerHTML = ''
        return
      }
      try {
        const r = await PhAuth.authFetch(`${BACKEND_ORIGIN}/api/mobile-result/${encodeURIComponent(id)}`)
        const data = await r.json()
        if (data.status === 'done' && data.filledText && data.filledText.trim()) {
          stopPolling()
          qrBox.innerHTML = ''
          const dest = document.querySelector('#txaDocumentosMedicosAnalisados')
          dest.value = dest.value ? dest.value + '\n\n' + data.filledText : data.filledText
          dest.dispatchEvent(new Event('input', { bubbles: true }))
          dest.dispatchEvent(new Event('change', { bubbles: true }))
          showStatus(container, 'Documento recebido do celular. Revise e clique em Salvar.', false)
          return
        }
      } catch (e) {
        if (e.phAuth || e.phLimit) {
          stopPolling()
          qrBox.innerHTML = ''
          showStatus(container, e.message, true)
          return
        }
        /* transient; keep polling */
      }
      pollTimer = setTimeout(() => poll(id), 2000)
    }

    btn.addEventListener('click', async (e) => {
      e.preventDefault()
      if (typeof qrcode === 'undefined') {
        showStatus(container, 'QR indisponível (biblioteca não carregou).', true)
        return
      }
      stopPolling()
      qrBox.innerHTML = ''
      showStatus(container, 'Gerando QR...', false, true)

      let baseUrl = ''
      try {
        const r = await PhAuth.authFetch(`${BACKEND_ORIGIN}/api/mobile-base-url`)
        baseUrl = (await r.json()).baseUrl || ''
      } catch (e) {
        if (e.phAuth || e.phLimit) { showStatus(container, e.message, true); return }
        /* otherwise handled below */
      }
      if (!baseUrl) {
        showStatus(container, 'Configure MOBILE_BASE_URL no servidor primeiro.', true)
        return
      }

      const id = (crypto.randomUUID && crypto.randomUUID()) ||
        String(Date.now()) + Math.random().toString(36).slice(2)
      const url = `${baseUrl.replace(/\/+$/, '')}/m/${id}`

      const qr = qrcode(0, 'M')
      qr.addData(url)
      qr.make()
      qrBox.innerHTML = qr.createImgTag(4)

      showStatus(container, 'Escaneie o QR com o celular e tire a foto.', false)
      pollDeadline = Date.now() + 180000 // 3 min: headroom for phone snap + slow upload
      poll(id)
    })
  }

  // Shared "Refinar" button: read whole field -> POST -> overwrite with rewrite -> toggle Desfazer.
  // Both fields use a leading NBSP (U+00A0) when app-filled; Claude won't re-emit it, so we
  // re-prepend it when the field started with one. Undo is a single-level in-memory snapshot.
  function injectRefineButton({ btnId, fieldSel, anchorSel, endpoint, emptyMsg, statusIconSpin }) {
    const anchor = document.querySelector(anchorSel)
    if (!anchor || document.getElementById(btnId)) return

    const btn = document.createElement('button')
    btn.id = btnId
    btn.type = 'button'
    btn.textContent = 'Refinar'
    btn.style.cssText = [
      'margin-left:12px', 'padding:4px 12px',
      'border-radius:4px', 'cursor:pointer', 'font-size:13px',
    ].join(';')
    btn.classList.add('ph-lvl2')

    // Inside the <label>, on the same line as the title text. The click handler calls
    // e.preventDefault() to stop label[for] from forwarding the click to the textarea.
    const container = document.createElement('span')
    container.appendChild(btn)
    anchor.appendChild(container)

    let snapshot = null // text-before-Refinar; non-null => button is in "Desfazer" state

    btn.addEventListener('click', async function (e) {
      e.preventDefault()
      const ta = document.querySelector(fieldSel)
      if (!ta) { showStatus(container, 'Campo não encontrado.', true); return }

      // DESFAZER branch
      if (snapshot !== null) {
        ta.value = snapshot
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        ta.dispatchEvent(new Event('change', { bubbles: true }))
        snapshot = null
        btn.textContent = 'Refinar'
        showStatus(container, '', false)
        return
      }

      // REFINAR branch
      const text = ta.value ? ta.value.trim() : ''
      if (!text) { showStatus(container, emptyMsg, true); return }

      btn.disabled = true
      showStatus(container, 'Refinando...', false, statusIconSpin)
      const ctrl = new AbortController()
      const timeoutId = setTimeout(() => ctrl.abort(), 60_000)
      try {
        const resp = await PhAuth.authFetch(`${BACKEND_ORIGIN}${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
          signal: ctrl.signal,
        })
        if (!resp.ok) {
          const e = await resp.json().catch(() => ({}))
          showStatus(container, `Erro: ${e.error || resp.status}`, true)
          btn.disabled = false
          return
        }
        const { filledText } = await resp.json()
        if (!filledText || !filledText.trim()) {
          showStatus(container, 'Resposta vazia do servidor.', true)
          btn.disabled = false
          return
        }
        snapshot = ta.value // capture BEFORE overwrite (raw)
        // Re-prepend the load-bearing NBSP (U+00A0) + newline if the field had one. Use the
        // explicit   escape (NOT a literal space) so it is unambiguously the same char
        // buildHistoricoAnamnese.ts uses; Claude does not reliably emit the invisible NBSP.
        const hadNbsp = ta.value.charCodeAt(0) === 0x00a0
        ta.value = hadNbsp ? NBSP + '\n' + filledText : filledText
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        ta.dispatchEvent(new Event('change', { bubbles: true }))
        btn.textContent = 'Desfazer'
        showStatus(container, 'Texto refinado. Revise.', false)
        btn.disabled = false
      } catch (err) {
        const msg = (err.phAuth || err.phLimit) ? err.message
          : err.name === 'AbortError'
            ? 'Tempo esgotado, tente novamente.'
            : `Erro de conexão: ${err.message}`
        showStatus(container, msg, true)
        btn.disabled = false
      } finally {
        clearTimeout(timeoutId)
      }
    })
  }

  // 🎤 Gravar entrevista — records audio (5-min auto-stop), transcribes via backend,
  // splices merged periciando prose into ONLY the DO PERICIANDO block.
  const REC_MAX_MS = 5 * 60 * 1000
  // GENTLE capture-gain top-up. autoGainControl (AGC, enabled in the getUserMedia
  // constraints) is the PRIMARY volume lever and already normalizes level dynamically;
  // this fixed multiplier is only a mild lift ON TOP. Kept at 1.3x (not higher) because
  // AGC + a large fixed gain fight each other and push audio into clipping, which whisper
  // transcribes WORSE. Raise cautiously only if rooms are consistently faint.
  const REC_GAIN = 1.3
  function injectRecordButton() {
    const anchor = document.querySelector('#lblHistoricoAnamnese')
    if (!anchor || document.getElementById('gravar-entrevista-btn')) return

    const container = document.createElement('span')
    const btn = document.createElement('button')
    btn.id = 'gravar-entrevista-btn'
    btn.type = 'button'
    btn.textContent = 'Gravar entrevista'
    btn.style.cssText = [
      'margin-left:12px', 'padding:4px 12px',
      'border-radius:4px', 'cursor:pointer', 'font-size:13px',
    ].join(';')
    btn.classList.add('ph-lvl2')
    container.appendChild(btn)
    anchor.appendChild(container) // record renders first; Refinar (called after) sits to its right

    let recorder = null
    let chunks = []
    let stream = null
    let autoStopId = null
    let tickId = null
    let snapshot = null // whole-field text before splice => Desfazer state
    let audioCtx = null // Web Audio context for the gain boost; closed in stopTracks

    function resetIdle() {
      btn.textContent = 'Gravar entrevista'
      btn.style.removeProperty('background') // revert to .ph-lvl2 lilac
      btn.style.removeProperty('color')
      btn.disabled = false
    }

    function stopTracks() {
      if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null }
      if (audioCtx) { audioCtx.close(); audioCtx = null }
      if (autoStopId) { clearTimeout(autoStopId); autoStopId = null }
      if (tickId) { clearInterval(tickId); tickId = null }
    }

    async function transcribe(blob) {
      btn.textContent = 'Transcrevendo…'
      btn.style.setProperty('background', '#4C1D95', 'important') // beat .ph-lvl2 !important
      btn.style.setProperty('color', '#fff', 'important')
      btn.disabled = true
      const ta = document.querySelector('#txaHistoricoAnamnese')
      if (!ta) { showStatus(container, 'Campo não encontrado.', true); resetIdle(); return }
      const split = self.AnamneseBlocks.splitAnamneseBlocks(ta.value || '')
      const form = new FormData()
      const ext = (blob.type && blob.type.includes('ogg')) ? 'ogg' : 'webm'
      form.append('audio', blob, `entrevista.${ext}`)
      form.append('periciandoText', split.periciandoBody)
      const ctrl = new AbortController()
      const timeoutId = setTimeout(() => ctrl.abort(), 5 * 60 * 1000)
      try {
        const resp = await PhAuth.authFetch(`${BACKEND_ORIGIN}/api/transcribe-entrevista`, {
          method: 'POST', body: form, signal: ctrl.signal,
        })
        if (!resp.ok) {
          const e = await resp.json().catch(() => ({}))
          showStatus(container, `Erro: ${e.error || resp.status}`, true); resetIdle(); return
        }
        const { filledText } = await resp.json()
        if (!filledText || !filledText.trim()) {
          showStatus(container, 'Resposta vazia do servidor.', true); resetIdle(); return
        }
        snapshot = ta.value
        ta.value = split.reassemble(filledText.trim())
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        ta.dispatchEvent(new Event('change', { bubbles: true }))
        btn.textContent = 'Desfazer'
        btn.style.removeProperty('background') // back to .ph-lvl2 lilac idle
        btn.style.removeProperty('color')
        btn.disabled = false
        showStatus(container, 'Transcrição adicionada. Revise.', false)
      } catch (err) {
        const msg = (err.phAuth || err.phLimit) ? err.message
          : err.name === 'AbortError' ? 'Tempo esgotado, tente novamente.' : `Erro de conexão: ${err.message}`
        showStatus(container, msg, true); resetIdle()
      } finally {
        clearTimeout(timeoutId)
      }
    }

    btn.addEventListener('click', async function (e) {
      e.preventDefault()

      // DESFAZER
      if (snapshot !== null) {
        const ta = document.querySelector('#txaHistoricoAnamnese')
        if (ta) {
          ta.value = snapshot
          ta.dispatchEvent(new Event('input', { bubbles: true }))
          ta.dispatchEvent(new Event('change', { bubbles: true }))
        }
        snapshot = null
        resetIdle()
        showStatus(container, '', false)
        return
      }

      // STOP (recording -> transcribe)
      if (recorder && recorder.state === 'recording') {
        recorder.stop()
        return
      }

      // START
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        })
      } catch (err) {
        showStatus(container, 'Permissão de microfone negada.', true)
        return
      }
      chunks = []
      // Mime guard: prefer audio/webm, fall back to browser default if unsupported.
      const opts = (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported &&
        MediaRecorder.isTypeSupported('audio/webm')) ? { mimeType: 'audio/webm' } : {}
      // Route mic -> GainNode(REC_GAIN) -> MediaRecorder, so the recording is boosted.
      // Fall back to the raw stream if Web Audio is unavailable (never block recording).
      let recordStream = stream
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)()
        // Some Chrome builds create the context SUSPENDED (the await getUserMedia above
        // can break the user-gesture chain) -> MediaRecorder would capture silence.
        // resume() is a no-op if already running; guarantees the graph is live before we
        // record. Important because this ships to other machines we can't debug remotely.
        if (audioCtx.state === 'suspended') await audioCtx.resume()
        const srcNode = audioCtx.createMediaStreamSource(stream)
        const gainNode = audioCtx.createGain()
        gainNode.gain.value = REC_GAIN
        const destNode = audioCtx.createMediaStreamDestination()
        srcNode.connect(gainNode)
        gainNode.connect(destNode)
        recordStream = destNode.stream
      } catch (e) {
        if (audioCtx) { audioCtx.close(); audioCtx = null }
        recordStream = stream // graceful fallback: record unboosted rather than fail
      }
      recorder = new MediaRecorder(recordStream, opts)
      recorder.ondataavailable = (ev) => { if (ev.data.size > 0) chunks.push(ev.data) }
      recorder.onstop = () => {
        stopTracks()
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
        transcribe(blob)
      }
      recorder.start()
      const startedAt = Date.now()
      btn.style.setProperty('background', '#4C1D95', 'important') // beat .ph-lvl2 !important
      btn.style.setProperty('color', '#fff', 'important')
      const renderTick = () => {
        const s = Math.floor((Date.now() - startedAt) / 1000)
        const mm = String(Math.floor(s / 60)).padStart(2, '0')
        const ss = String(s % 60).padStart(2, '0')
        btn.textContent = `⏹ Parar (${mm}:${ss})`
      }
      renderTick()
      tickId = setInterval(renderTick, 1000)
      autoStopId = setTimeout(() => { if (recorder && recorder.state === 'recording') recorder.stop() }, REC_MAX_MS)
      showStatus(container, 'Gravando… clique para parar (máx. 5 min).', false)
    })
  }

  // Shared tail for BOTH auto (worker-downloaded blob) and manual fallback (picked file):
  // run the one pipeline, then fill via doFill. Re-enables the safety-net #pl-btn on success.
  async function runPipelineAndFill(pdfBlob, container, btn) {
    btn.disabled = true
    const onProgress = (p) => {
      if (p.phase === 'segmenting') showStatus(container, 'Segmentando…', false, true)
      else if (p.phase === 'processing') showStatus(container, `Extraindo dados (${p.i}/${p.total})`, false, true)
    }
    try {
      const payload = await self.LaudoPipeline.runPipeline(pdfBlob, onProgress)
      const oldBtn = document.querySelector('#pl-btn'); if (oldBtn) oldBtn.disabled = false
      btn.disabled = false
      btn.dataset.mode = ''
      fillFromPayload(payload, container, btn, false) // manual upload: no process gate → keep name-check
    } catch (err) {
      showStatus(container, 'Erro: ' + ((err && err.message) || 'falhou'), true)
      btn.disabled = false
    }
  }

  // ── Detail-page "Extrair dados para o laudo" handoff → exam-page #pp-btn states ──
  // The worker (driven from the process detail page) stashes a payload in chrome.storage.local.
  // The exam-page #pp-btn reflects three states from storage: prepared / extracting / manual.
  const PP_STALE_MS = 12 * 60 * 60 * 1000 // Q12: a prepared payload older than 12 h is treated as stale.
  function thisNumProcesso() {
    const qs = window.location.href.split('#')[0].split('?')[1] || ''
    return new URLSearchParams(qs).get('num_processo') || ''
  }
  // Set #pp-btn to prepared / extracting / manual based on storage. Looks the button up fresh
  // (no captured closure) so it survives e-proc re-rendering the name label.
  function refreshAnaliseState() {
    const btn = document.querySelector('#pp-btn')
    if (!btn) return
    if (btn.dataset.mode === 'undo' || btn.dataset.mode === 'fallback') return // Q11: respect those modes
    const np = thisNumProcesso()
    chrome.storage.local.get(['ppPayload', 'ppPayloadProcesso', 'ppPayloadAt', 'ppProgress'], (d) => {
      const match = !!np && d.ppPayloadProcesso === np
      const fresh = d.ppPayloadAt && (Date.now() - d.ppPayloadAt) < PP_STALE_MS
      if (match && d.ppPayload && fresh) {
        btn.disabled = false; btn.textContent = 'Pré-preencher'; btn.dataset.mode = 'ready'
      } else if (match && d.ppProgress && d.ppProgress.phase && d.ppProgress.phase !== 'done') {
        btn.disabled = true; btn.textContent = 'Extraindo dados do processo…'; btn.dataset.mode = ''
      } else {
        btn.disabled = false; btn.textContent = 'Pré-preencher'; btn.dataset.mode = '' // manual
      }
    })
  }
  // Q9: registered ONCE at IIFE scope (not inside the injector) so re-injection can't pile up
  // listeners or close over a stale btn. Fires for worker writes (cross-context) AND the
  // detail-page timeout (ppError). Looks up the live #pp-btn each time via refreshAnaliseState.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.ppPayload || changes.ppProgress || changes.ppError)) refreshAnaliseState()
  })

  // ── "Pré-preencher": prepared payload fills instantly; otherwise file-picker fallback ───────
  function injectPrePreencherButton() {
    const nameLabel = document.querySelector('#lblNomeExaminado')
    if (!nameLabel || document.querySelector('#pp-btn')) return

    const btn = document.createElement('button')
    btn.id = 'pp-btn'
    btn.type = 'button'
    btn.textContent = 'Pré-preencher'
    btn.style.cssText = [
      'margin-left:12px', 'padding:4px 12px',
      'border-radius:4px', 'cursor:pointer', 'font-size:13px',
    ].join(';')
    const container = document.createElement('span')
    container.appendChild(btn)
    nameLabel.appendChild(container)

    btn.addEventListener('click', (e) => {
      e.preventDefault()
      if (btn.dataset.mode === 'undo') return     // Desfazer handler (fillFromPayload) owns this case
      if (btn.dataset.mode === 'fallback') return  // picker handler (enterFallback) owns this case
      const np = thisNumProcesso()
      chrome.storage.local.get(['ppPayload', 'ppPayloadProcesso', 'ppPayloadAt'], (d) => {
        const fresh = d.ppPayloadAt && (Date.now() - d.ppPayloadAt) < PP_STALE_MS
        if (d.ppPayload && np && d.ppPayloadProcesso === np && fresh) {
          // State 1: prepared (detail-page extraction ready) → fill from stash, instant.
          chrome.storage.local.remove(['ppPayload', 'ppPayloadProcesso', 'ppPayloadAt', 'ppProgress', 'ppError'])
          btn.dataset.mode = ''
          fillFromPayload(d.ppPayload, container, btn, true) // prepared: process already matched → skip name-check
        } else {
          // State 3: nothing prepared (or stale) → file picker with the guidance message.
          enterFallback(container, btn, 'Clique no botão "Extrair dados para o laudo" na página do processo ou adicione o download completo aqui.')
        }
      })
    })

    refreshAnaliseState() // set initial state (prepared / extracting / manual) from storage
  }

  // Snapshot FIELD_MAP fields at fill time, call the existing doFill, toggle to Desfazer on success.
  // skipNameCheck=true for prepared (process-matched) fills; manual uploads keep the name-check.
  function fillFromPayload(payload, container, btn, skipNameCheck) {
    const pageName = readExamineeName()
    const snapshot = FIELD_MAP.map(f => {
      const el = document.querySelector(f.selector)
      return { selector: f.selector, value: el ? el.value : null, present: !!el }
    })

    doFill(payload, pageName, btn, skipNameCheck) // existing fn: name-match, fills, may disable btn + show status

    // Did anything actually change? (doFill aborts on name 'far' / all-missing without filling.)
    const changed = snapshot.some(s => {
      if (!s.present) return false
      const el = document.querySelector(s.selector)
      return el && el.value !== s.value
    })
    if (!changed) { btn.disabled = false; return } // doFill already showed why (name mismatch / no data)

    applyFixedRadios(payload) // success → also set the 8 fixed Sim/Não radios (rides the same gate as the text)

    // Success → offer Desfazer (single-level toggle, mirrors the Refinar buttons).
    btn.disabled = false
    btn.textContent = 'Desfazer'
    btn.dataset.mode = 'undo'
    // Desfazer uses onclick (set/cleared per fill), separate from the persistent addEventListener.
    btn.onclick = function (e) {
      e.preventDefault()
      for (const s of snapshot) {
        if (!s.present) continue
        const el = document.querySelector(s.selector)
        if (!el) continue
        el.value = s.value
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      }
      showStatus(container, 'Desfeito.', false)
      btn.textContent = 'Pré-preencher'
      btn.dataset.mode = ''
      btn.onclick = null // hand control back to the persistent addEventListener (prepared/manual on next click)
    }
  }

  // Auto path failed → on-page PDF picker. Runs the SAME pipeline locally (no SaaS tab).
  function enterFallback(container, btn, msg) {
    showStatus(container, msg, true)
    btn.disabled = false
    btn.textContent = 'Pré-preencher'
    btn.dataset.mode = 'fallback'

    let fileInput = container.querySelector('input[type=file].pp-file')
    if (!fileInput) {
      fileInput = document.createElement('input')
      fileInput.type = 'file'
      fileInput.accept = 'application/pdf'
      fileInput.className = 'pp-file'
      fileInput.style.display = 'none'
      container.appendChild(fileInput)
      fileInput.addEventListener('change', () => {
        const file = fileInput.files && fileInput.files[0]
        fileInput.value = ''
        if (!file) return
        if (file.type !== 'application/pdf') { showStatus(container, 'Envie um PDF.', true); return }
        runPipelineAndFill(file, container, btn) // same shared tail as the auto path
      })
    }

    // In fallback mode the button opens the file picker.
    btn.onclick = (e) => { e.preventDefault(); if (btn.dataset.mode === 'fallback') fileInput.click() }
  }

  // Preencher Laudo hidden for demo 2026-07-07. Set true to restore the button.
  const SHOW_PREENCHER_LAUDO = false
  // Gravar entrevista hidden for demo 2026-07-07. Set true to restore the button.
  const SHOW_GRAVAR_ENTREVISTA = true

  // Use MutationObserver as safe default (handles any late JS render)
  function injectAll() {
    if (SHOW_PREENCHER_LAUDO && document.querySelector('#lblNomeExaminado')) injectButton()
    if (document.querySelector('#lblNomeExaminado')) injectPrePreencherButton()
    if (document.querySelector('#fldQuesitoParteAutora legend')) injectQuesitosButton()
    if (document.querySelector('#lblTarefasExigidasUltimaAtividade')) injectDescreverButton()
    if (document.querySelector('#lblDocumentosMedicosAnalisados')) injectAdicionarButton()
    if (document.querySelector('#lblDocumentosMedicosAnalisados')) injectAdicionarCelularButton()
    if (SHOW_GRAVAR_ENTREVISTA && document.querySelector('#lblHistoricoAnamnese')) injectRecordButton()
    if (document.querySelector('#lblHistoricoAnamnese')) injectRefineButton({
      btnId: 'refinar-anamnese-btn', fieldSel: '#txaHistoricoAnamnese',
      anchorSel: '#lblHistoricoAnamnese', endpoint: '/api/refine-anamnese',
      emptyMsg: 'Escreva a anamnese primeiro.',
      statusIconSpin: true,
    })
    if (document.querySelector('#lblExameFisicoMental')) injectRefineButton({
      btnId: 'refinar-exame-btn', fieldSel: '#txaExameFisicoMental',
      anchorSel: '#lblExameFisicoMental', endpoint: '/api/refine-exame',
      emptyMsg: 'Descreva o exame físico primeiro.',
      statusIconSpin: true,
    })
    syncConclusaoButtons()
  }

  // Debounce so bursts of mutations collapse into one injectAll() pass.
  let injectDebounce = null
  function scheduleInjectAll() {
    if (injectDebounce) clearTimeout(injectDebounce)
    injectDebounce = setTimeout(injectAll, 150)
  }

  // Observer NEVER disconnects: conclusion buttons must toggle as the perito changes the
  // conclusion checkboxes/radios for the life of the page. injectButton/injectQuesitosButton
  // are guarded by #pl-btn/#rq-btn existence, and syncConclusaoButtons by #concl-btnN, so
  // re-running injectAll on every mutation cannot duplicate anything (anchors verified unique).
  const observer = new MutationObserver(scheduleInjectAll)
  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  })

  // Also drive the conclusion sync directly off change events on the conclusion gates —
  // cheaper and snappier than waiting for the mutation debounce when a checkbox/radio toggles.
  document.addEventListener('change', function (e) {
    const t = e.target
    if (t && t.id && /DadoComplementarPericia/.test(t.id)) syncConclusaoButtons()
  })

  // Initial pass: this page can load with a conclusion already selected (e.g. chk002 + the
  // sequela radios), so sync once immediately rather than waiting for the first mutation.
  injectAll()
})()

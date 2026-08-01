// Shared SaaS pipeline, runnable in two contexts:
//   - as a content script in eproc-fill.js (manual-fallback path)
//   - via importScripts() in preencher-worker.js (auto path)
// No DOM, no chrome messaging. Functions hang off self.LaudoPipeline.
// Ported from frontend/src/hooks/usePipeline.ts + buildHistoricoAnamnese.ts.
(function () {
  const BACKEND_ORIGIN = 'https://api.periciahub.com'

  function stripCodeFence(s) {
    return s.replace(/^\s*```(?:json)?\s*\n?/i, '').replace(/\n?\s*```\s*$/i, '').trim()
  }

  // string -> Record<string,string> | undefined  (JSON, else labeled-text fallback)
  function tryParseFields(result) {
    const cleaned = stripCodeFence(result)
    const tryJson = (s) => { try { const p = JSON.parse(s); return (p && typeof p === 'object') ? p : undefined } catch { return undefined } }
    // Direct parse first; if that fails (e.g. Claude prepended reasoning before the
    // JSON), extract the outermost {…} and parse that before the labeled-text fallback.
    let parsed = tryJson(cleaned)
    if (!parsed) {
      const i = cleaned.indexOf('{'), j = cleaned.lastIndexOf('}')
      if (i !== -1 && j > i) parsed = tryJson(cleaned.slice(i, j + 1))
    }
    if (parsed) return parsed
    {
      const fields = {}
      const labelRegex = /^([A-ZÁÉÍÓÚÂÊÔÃÕÇ_ ]{3,}):\s*/gm
      const matches = [...cleaned.matchAll(labelRegex)]
      for (let i = 0; i < matches.length; i++) {
        const m = matches[i]
        const key = m[1].trim().replace(/\s+/g, '_')
        const start = m.index + m[0].length
        const end = i + 1 < matches.length ? matches[i + 1].index : cleaned.length
        fields[key] = cleaned.slice(start, end).trim()
      }
      if (Object.keys(fields).length > 0) return fields
    }
    return undefined
  }

  // Histórico/Anamnese assembly. Leading U+00A0 + newline is load-bearing.
  function buildHistoricoAnamnese(peticaoRaw, periciaRaw, periciaFound, beneficiosRaw) {
    const peticaoBody = (peticaoRaw ?? '').trim()
    const periciaBody = (periciaRaw ?? '').trim()
    const beneficiosBody = (beneficiosRaw ?? '').trim()
    const peticaoBlock = peticaoBody ? `DA PETIÇÃO INICIAL\n${peticaoBody}` : ''
    let periciaBlock = ''
    if (periciaBody) {
      periciaBlock = `DO PERICIANDO\n${periciaBody}`
    } else if (periciaFound || peticaoBlock) {
      periciaBlock = 'DO PERICIANDO'
    }
    if (periciaBlock === 'DO PERICIANDO' && beneficiosBody) periciaBlock += '\n'
    const joined = [peticaoBlock, periciaBlock, beneficiosBody].filter(Boolean).join('\n\n')
    return joined ? ` \n${joined}` : ''
  }

  async function getFixedFields() {
    const resp = await self.PhAuth.authFetch(`${BACKEND_ORIGIN}/api/admin/fixed-fields`)
    if (!resp.ok) throw new Error('fixed-fields ' + resp.status)
    return resp.json()
  }

  // True if HISTORICO_BENEFICIOS is the "no prior benefit" sentinel. Normalized
  // (accent-strip + lowercase + collapse ws + drop trailing period) to survive LLM
  // output drift; matches frontend usePipeline.ts byte-for-byte in behavior.
  function isSemBeneficioPrevio(historicoBeneficios) {
    const norm = (historicoBeneficios || '')
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/\s+/g, ' ').trim().replace(/\.$/, '')
    return norm.endsWith('sem auxilio-doenca previo')
  }

  // results: [{ segment, parsedFields }]  ->  { type, examinee, fields } | undefined
  async function buildLaudoPayload(results) {
    const peticao = results.find(r => r.segment.docTypeId === 'peticao_inicial' && r.parsedFields)
    const pericia = results.find(r => r.segment.docTypeId === 'pericia_previa' && r.parsedFields)
    const beneficios = results.find(r => r.segment.docTypeId === 'beneficios' && r.parsedFields)
    if (!peticao && !pericia && !beneficios) return undefined
    const pf = peticao && peticao.parsedFields
    const prf = pericia && pericia.parsedFields
    const bf = beneficios && beneficios.parsedFields

    const examinee = ((pf && pf['REQUERENTES']) || '').split(',')[0].trim()
    const ultimaAtividade = ((prf && prf['ULTIMA_ATIVIDADE_LABORAL']) || '').trim()
    const tarefas = ((prf && prf['TAREFAS']) || '').trim()
    const escolaridade = ((prf && prf['ESCOLARIDADE']) || '').trim()
    const experienciasLaborais = ((prf && prf['EXPERIENCIAS_LABORAIS_ANTERIORES']) || '').trim()
    const documentosMedicos = ((prf && prf['DOCUMENTOS_MEDICOS']) || '').trim()
    const qRaw = ((pf && pf['QUESITOS_REQUERENTE']) || '').trim()
    const quesitosRequerente = /^sem quesitos$/i.test(qRaw) ? '' : qRaw
    const historicoBeneficios = ((bf && bf['HISTORICO_BENEFICIOS']) || '').trim()
    const historicoAnamnese = buildHistoricoAnamnese(
      pf && pf['DA_PETIÇÃO_INICIAL'], prf && prf['HISTORICO'], Boolean(pericia), historicoBeneficios)

    if (!examinee && !ultimaAtividade && !tarefas && !escolaridade && !experienciasLaborais && !historicoAnamnese)
      return undefined

    // ULTIMO_ANO_TRABALHADO is year-only; prepend "Relata até ". Empty -> omit the
    // key so the fixed "Relata até" default survives (an empty value would override).
    const anoTrabalhado = ((bf && bf['ULTIMO_ANO_TRABALHADO']) || '').trim()
    const ateQuando = anoTrabalhado ? `Relata até ${anoTrabalhado}` : undefined
    // Flip the benefício-prévio radio to the 4th option only when beneficios matched
    // and the sentinel is present; otherwise leave default (handled in eproc-fill.js).
    const beneficioPrevioRadio = beneficios && isSemBeneficioPrevio(historicoBeneficios) ? 'B' : undefined

    let fixed = {}
    try { fixed = await getFixedFields() } catch { fixed = {} }

    return {
      type: 'LAUDO_FILL_DATA',
      examinee,
      fields: {
        ultimaAtividade,
        tarefas,
        escolaridade: escolaridade || 'Ensino Fundamental Incompleto',
        experienciasLaborais: experienciasLaborais || 'Não informa',
        historicoAnamnese,
        ...fixed,
        ...(ateQuando ? { ateQuandoUltimaAtividade: ateQuando } : {}),
        documentosMedicos: documentosMedicos || fixed.documentosMedicos,
        quesitosRequerente,
        ...(beneficioPrevioRadio ? { beneficioPrevioRadio } : {}),
      },
    }
  }

  // pdfBlob(s) -> payload. Accepts a single Blob (manual "Adicionar" caller) OR a Blob[] (worker,
  // multi-part). onProgress({phase,i,total}) called as it goes. Throws on hard failure.
  async function runPipeline(pdfBlobOrBlobs, onProgress) {
    const blobs = Array.isArray(pdfBlobOrBlobs) ? pdfBlobOrBlobs : [pdfBlobOrBlobs]
    const fd = new FormData()
    for (const b of blobs) fd.append('pdf', b, 'completo.pdf')
    if (onProgress) onProgress({ phase: 'segmenting' })
    const segResp = await self.PhAuth.authFetch(`${BACKEND_ORIGIN}/api/segment-and-extract`, { method: 'POST', body: fd })
    if (!segResp.ok) throw new Error('segment-and-extract ' + segResp.status)
    const segments = (await segResp.json()).segments || []
    if (segments.length === 0) throw new Error('Nenhum documento reconhecido no PDF.')

    const toProcess = segments.filter(s => s.process)
    const finalResults = segments.map(seg => ({ segment: seg, parsedFields: undefined }))

    for (let i = 0; i < toProcess.length; i++) {
      const seg = toProcess[i]
      if (onProgress) onProgress({ phase: 'processing', i: i + 1, total: toProcess.length })
      const r = await self.PhAuth.authFetch(`${BACKEND_ORIGIN}/api/process-segment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segmentId: seg.segmentId, docTypeId: seg.docTypeId, text: seg.text }),
      })
      if (!r.ok) throw new Error('process-segment ' + r.status)
      const result = (await r.json()).result
      const parsedFields = tryParseFields(result)
      const idx = finalResults.findIndex(x => x.segment.segmentId === seg.segmentId)
      if (idx !== -1) finalResults[idx].parsedFields = parsedFields
    }

    const payload = await buildLaudoPayload(finalResults)
    if (!payload) throw new Error('Sem dados suficientes para preencher.')
    return payload
  }

  self.LaudoPipeline = { runPipeline, tryParseFields, buildLaudoPayload, buildHistoricoAnamnese }
})()

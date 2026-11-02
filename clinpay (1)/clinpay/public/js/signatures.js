import {
  api, state, esc, fmtDate, fmtDateTime, age, toast, $, modal, showErrors, readForm, options, can,
  fmtCpf, cpfInputMask, printModal, ICONS,
} from './core.js';

// Modelos iniciais dos termos. O texto pode ser ajustado antes de cada assinatura
// e DEVE ser revisado pelo responsável técnico e pela assessoria jurídica da clínica.
function template(docType, p, s) {
  const M = state.meta;
  const proc = s ? `${s.procedureName} (lado: ${M.laterality[s.laterality].toLowerCase()})` : '[procedimento]';
  const doctor = s ? s.surgeonName : '[médico responsável]';
  const when = s ? `${fmtDate(s.date)}, às ${s.startTime}` : '[data]';
  const name = p.name;
  const T = {
    termo_cirurgico: `Eu, ${name}, ou meu responsável legal abaixo identificado, declaro que fui informado(a) de forma clara pelo(a) médico(a) responsável, ${doctor}, sobre o procedimento ${proc}, previsto para ${when}.

Foram explicados o diagnóstico, os objetivos, os benefícios esperados, os riscos e possíveis complicações, as alternativas de tratamento e as consequências de não realizar o procedimento. Tive oportunidade de fazer perguntas, que foram respondidas de forma satisfatória.

Autorizo a equipe médica a realizar o procedimento descrito e as condutas necessárias diante de situações imprevistas durante a cirurgia, sempre visando ao meu benefício.

Estou ciente de que posso revogar este consentimento a qualquer momento antes do procedimento.`,
    termo_anestesico: `Eu, ${name}, ou meu responsável legal abaixo identificado, declaro que fui informado(a) sobre a anestesia prevista (${s ? M.anesthesia[s.anesthesiaType].toLowerCase() : '[tipo de anestesia]'}) para o procedimento ${proc}.

Foram explicados os riscos, os benefícios, as alternativas e os cuidados de jejum e de medicação. Informei corretamente minhas alergias, doenças e medicamentos em uso.

Autorizo o(a) médico(a) anestesiologista a realizar a anestesia e as medidas necessárias para minha segurança.`,
    termo_hemotransfusao: `Eu, ${name}, ou meu responsável legal abaixo identificado, declaro que fui informado(a) sobre a possível necessidade de transfusão de sangue ou hemocomponentes durante ou após o procedimento ${proc}.

Foram explicados os benefícios, os riscos (incluindo reações transfusionais) e as alternativas. Autorizo a transfusão caso seja indicada pela equipe médica.`,
    termo_imagem: `Eu, ${name}, ou meu responsável legal abaixo identificado, autorizo o registro de imagens do procedimento ${proc} para fins de documentação do prontuário. Qualquer outro uso dependerá de nova autorização expressa.`,
    outro: '',
  };
  return T[docType] ?? '';
}

export function openSignatureForm({ patient, surgery = null, docType = 'termo_cirurgico', onDone, content = null, title = null }) {
  const M = state.meta;
  const m = modal({
    title: 'Coletar assinatura eletrônica',
    wide: true,
    body: `
    <div class="form" id="sForm">
      <div class="field s6 alert info" style="display:block">Paciente: <strong>${esc(patient.name)}</strong> — ${esc(fmtDate(patient.birthDate))} (${esc(age(patient.birthDate))})
        ${surgery ? `<br>Cirurgia: <strong>${esc(surgery.procedureName)}</strong>, ${esc(M.laterality[surgery.laterality])}, ${esc(fmtDate(surgery.date))} às ${esc(surgery.startTime)}` : ''}</div>
      <div class="field s3"><label class="req" for="docType">Documento</label><select name="docType" id="docType">${options(M.docTypes, docType)}</select></div>
      <div class="field s3"><label class="req" for="title">Título</label><input name="title" id="title" maxlength="200"></div>
      <div class="field s6"><label class="req" for="content">Texto do documento</label><textarea name="content" id="content" style="min-height:220px"></textarea>
        <span class="hint">Leia o texto com o signatário. Ajustes feitos aqui ficam gravados junto com a assinatura.</span></div>

      <div class="fieldset-title">Quem assina</div>
      <div class="field s2"><label class="req" for="signerRole">Signatário</label><select name="signerRole" id="signerRole">${options(M.signerRoles, 'paciente')}</select></div>
      <div class="field s2"><label class="req" for="signerName">Nome completo</label><input name="signerName" id="signerName"></div>
      <div class="field s2"><label id="cpfLabel" for="signerCpf">CPF</label><input name="signerCpf" id="signerCpf" inputmode="numeric" placeholder="000.000.000-00"></div>
      <div class="field s2 hidden" id="relBox"><label class="req" for="signerRelation">Parentesco / vínculo</label><input name="signerRelation" id="signerRelation" placeholder="Ex.: mãe, cônjuge, curador"></div>

      <div class="field s6"><label class="req">Assinatura</label>
        <div class="sigpad-wrap"><canvas id="pad" aria-label="Quadro de assinatura. Assine com o dedo, caneta ou mouse."></canvas><div class="baseline"></div><div class="hint">Assine acima da linha</div></div>
        <div class="toolbar" style="margin-top:6px"><button class="btn sm" type="button" id="clearPad">Limpar assinatura</button></div>
        <input type="hidden" name="image"></div>
      <div class="field s6"><label class="check"><input type="checkbox" name="agree"> Confirmo que o signatário leu (ou teve lido para si) o documento acima, compreendeu e assinou de livre vontade.</label></div>
      <div class="field s6" id="sErr"></div>
    </div>`,
    foot: `<button class="btn" data-cancel>Cancelar</button><button class="btn primary" data-save>Registrar assinatura</button>`,
  });
  const f = m.el.querySelector('#sForm');
  const sel = (n) => f.querySelector(`[name="${n}"]`);
  const fillTemplate = () => {
    sel('title').value = M.docTypes[sel('docType').value];
    sel('content').value = template(sel('docType').value, patient, surgery);
  };
  sel('docType').onchange = fillTemplate; fillTemplate();
  // Texto já pronto (ex.: anamnese preenchida): usa o texto recebido
  if (content) { sel('content').value = content; sel('title').value = title || M.docTypes[docType]; }
  cpfInputMask(sel('signerCpf'));
  const syncRole = () => {
    const r = sel('signerRole').value;
    f.querySelector('#relBox').classList.toggle('hidden', r !== 'responsavel');
    f.querySelector('#cpfLabel').classList.toggle('req', r === 'paciente' || r === 'responsavel');
    if (r === 'paciente') { sel('signerName').value = patient.name; sel('signerCpf').value = fmtCpf(patient.cpf); }
    else if (sel('signerName').value === patient.name) { sel('signerName').value = ''; sel('signerCpf').value = ''; }
    if (r === 'medico' || r === 'enfermagem') sel('signerName').value = sel('signerName').value || state.me.name;
  };
  sel('signerRole').onchange = syncRole; syncRole();

  const pad = signaturePad(f.querySelector('#pad'));
  f.querySelector('#clearPad').onclick = pad.clear;
  m.el.querySelector('[data-cancel]').onclick = m.close;
  const btn = m.el.querySelector('[data-save]');
  btn.onclick = async () => {
    const errBox = f.querySelector('#sErr');
    if (pad.isEmpty()) {
      showErrors(f, { message: 'A assinatura está em branco ou muito curta.', fields: { image: 'Assine no quadro.' } }, errBox);
      return;
    }
    const data = readForm(f);
    data.image = pad.toDataUrl();
    data.patientId = patient.id;
    data.surgeryId = surgery ? surgery.id : null;
    btn.disabled = true;
    try {
      const saved = await api('POST', '/api/signatures', data);
      m.close();
      if (onDone) onDone(saved);
      else toast('Assinatura registrada.');
    } catch (e) { showErrors(f, e, errBox); } finally { btn.disabled = false; }
  };
}

/** Quadro de assinatura com suporte a dedo, caneta e mouse. */
function signaturePad(canvas) {
  const ctx = canvas.getContext('2d');
  let strokes = []; let current = null;
  const resize = () => {
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * ratio; canvas.height = rect.height * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    redraw();
  };
  const redraw = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0B2545'; ctx.lineWidth = 2.4;
    for (const s of strokes) {
      ctx.beginPath();
      s.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
      if (s.length === 1) ctx.lineTo(s[0].x + 0.1, s[0].y);
      ctx.stroke();
    }
  };
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault(); canvas.setPointerCapture(e.pointerId);
    current = [pos(e)]; strokes.push(current); redraw();
  });
  canvas.addEventListener('pointermove', (e) => { if (!current) return; e.preventDefault(); current.push(pos(e)); redraw(); });
  const end = () => { current = null; };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  setTimeout(resize, 50);
  window.addEventListener('resize', resize);
  return {
    clear: () => { strokes = []; redraw(); },
    isEmpty: () => strokes.reduce((n, s) => n + s.length, 0) < 15,
    toDataUrl: () => {
      // Exporta com fundo transparente, limitado a 1000px de largura
      const r = canvas.getBoundingClientRect();
      const scale = Math.min(1000 / r.width, 2);
      const out = document.createElement('canvas');
      out.width = Math.round(r.width * scale); out.height = Math.round(r.height * scale);
      const o = out.getContext('2d');
      o.scale(scale, scale); o.lineCap = 'round'; o.lineJoin = 'round'; o.strokeStyle = '#0B2545'; o.lineWidth = 2.4;
      for (const s of strokes) {
        o.beginPath(); s.forEach((pt, i) => (i ? o.lineTo(pt.x, pt.y) : o.moveTo(pt.x, pt.y)));
        if (s.length === 1) o.lineTo(s[0].x + 0.1, s[0].y);
        o.stroke();
      }
      return out.toDataURL('image/png');
    },
  };
}

export async function openSignatureView(id) {
  const m = modal({ title: 'Documento assinado', wide: true, body: '<p class="muted">Carregando…</p>', foot: '' });
  let s;
  try { s = await api('GET', `/api/signatures/${encodeURIComponent(id)}`); } catch (e) {
    m.el.querySelector('.modal-body').innerHTML = `<div class="alert danger">${esc(e.message)}</div>`; return;
  }
  const M = state.meta;
  m.el.querySelector('.modal-body').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
      <div><img src="/logo.svg" alt="ClinPay" style="width:150px"><div class="small muted">${esc(M.clinicName)}</div></div>
      <button class="btn no-print" data-print>${ICONS.print} Imprimir</button>
    </div>
    ${s.valid ? '<div class="alert ok no-print">Integridade conferida: o documento não foi alterado desde a assinatura.</div>'
      : '<div class="alert danger">ATENÇÃO: o código de integridade não confere. Este registro pode ter sido alterado.</div>'}
    <h2 style="margin:12px 0 4px">${esc(s.title)}</h2>
    <p class="muted">Paciente: ${esc(s.patientName)}</p>
    <div class="doc-text">${esc(s.content)}</div>
    <div style="margin-top:20px">
      <img class="signed-img" src="${esc(s.image)}" alt="Assinatura de ${esc(s.signerName)}">
      <p style="margin:6px 0 0"><strong>${esc(s.signerName)}</strong> — ${esc(M.signerRoles[s.signerRole])}${s.signerRelation ? ` (${esc(s.signerRelation)})` : ''}${s.signerCpf ? ` — CPF ${esc(fmtCpf(s.signerCpf))}` : ''}</p>
    </div>
    <dl class="kv" style="margin-top:16px">
      <dt>Assinado em</dt><dd>${esc(fmtDateTime(s.signedAt))}</dd>
      <dt>Coletado por</dt><dd>${esc(s.collectedByName)}</dd>
      <dt>Endereço IP</dt><dd>${esc(s.ip)}</dd>
      <dt>Código de integridade</dt><dd class="hash">SHA-256 ${esc(s.hash)}</dd>
    </dl>
    <p class="small muted">Assinatura eletrônica registrada com data, hora, origem e código de integridade.</p>`;
  m.el.querySelector('[data-print]').onclick = () => printModal(m);
}

export async function signaturesPage(page) {
  const list = await api('GET', '/api/signatures');
  const M = state.meta;
  page.innerHTML = `
    <div class="page-head">
      <div><button class="btn menu-toggle" id="menuToggle" aria-label="Abrir menu">${ICONS.menu}</button><h1>Termos assinados</h1>
      <p class="muted">Para coletar uma assinatura, abra a cirurgia na agenda ou o cadastro do paciente.</p></div>
      <div class="toolbar"><input id="filter" class="btn" placeholder="Filtrar por paciente ou signatário" style="min-width:260px;font-weight:400" aria-label="Filtrar"></div>
    </div>
    <div id="slist"></div>`;
  const render = (term) => {
    const t = term.toLowerCase();
    const rows = list.filter((s) => !t || s.patientName.toLowerCase().includes(t) || s.signerName.toLowerCase().includes(t));
    $('#slist').innerHTML = rows.length ? `<div class="table-wrap"><table class="list"><thead><tr><th>Data</th><th>Documento</th><th>Paciente</th><th>Signatário</th><th>Coletado por</th></tr></thead><tbody>
      ${rows.map((s) => `<tr class="clickable" data-sig="${esc(s.id)}"><td>${esc(fmtDateTime(s.signedAt))}</td><td>${esc(s.title)}</td>
        <td>${esc(s.patientName)}</td><td>${esc(s.signerName)}<br><span class="muted small">${esc(M.signerRoles[s.signerRole])}</span></td><td>${esc(s.collectedByName)}</td></tr>`).join('')}
      </tbody></table></div>` : `<div class="panel empty">${list.length ? 'Nenhum documento encontrado com esse filtro.' : 'Nenhum documento assinado ainda.'}</div>`;
    page.querySelectorAll('[data-sig]').forEach((tr) => { tr.onclick = () => openSignatureView(tr.dataset.sig); });
  };
  $('#filter').oninput = (e) => render(e.target.value.trim());
  render('');
  void can;
}

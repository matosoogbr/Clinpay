// Prontuário eletrônico: evolução, anamnese, odontograma, exames, imagens e acesso ao portal
import {
  api, state, esc, fmtDate, fmtDateTime, todayStr, toast, modal, showErrors, readForm, options, can, confirmDialog,
} from './core.js';
import { openSignatureForm, openSignatureView } from './signatures.js';
import { openFile } from './portal.js';

// ---------------- Evolução clínica e anamnese ----------------
export async function notesTab(box, p) {
  const [notes, sigs] = await Promise.all([api('GET', `/api/patients/${p.id}/notes`), api('GET', `/api/signatures?patientId=${p.id}`)]);
  const anam = sigs.filter((s) => s.docType === 'anamnese');
  const byId = new Map(notes.map((n) => [n.id, n]));
  box.innerHTML = `
    <div class="grid2">
      <section class="panel"><h3 style="margin-bottom:10px">Nova evolução</h3>
        ${can('records:write') ? `<div class="form" id="nForm"><div class="field s6"><textarea name="text" id="ntext" style="min-height:120px" placeholder="Queixa, exame físico, conduta, prescrição, orientações…"></textarea>
          <span class="hint">Registros do prontuário não podem ser editados nem apagados. Para corrigir, use "Adendo".</span></div>
          <div class="field s6" id="nErr"></div><div class="field s6"><div class="toolbar"><button class="btn primary" id="saveNote">Registrar evolução</button></div></div></div>`
          : '<p class="muted">Seu perfil só pode consultar o prontuário.</p>'}
      </section>
      <section class="panel"><h3 style="margin-bottom:10px">Anamnese</h3>
        ${anam.length ? `<ul class="history">${anam.map((a) => `<li>Anamnese assinada por ${esc(a.signerName)} em ${esc(fmtDateTime(a.signedAt))} — <a href="#" data-sig="${esc(a.id)}">ver</a></li>`).join('')}</ul>`
          : '<p class="muted small">Nenhuma anamnese registrada.</p>'}
        ${can('records:write') ? '<button class="btn" id="newAnam" style="margin-top:10px">Preencher anamnese</button>' : ''}
      </section>
    </div>
    <section class="panel"><h3 style="margin-bottom:10px">Histórico clínico</h3>
      ${notes.length ? `<ul class="history">${notes.map((n) => `<li>
        <div class="small muted">${esc(fmtDateTime(n.at))} — ${esc(n.authorName)}${n.kind === 'adendo' ? ` · <strong>Adendo</strong> ao registro de ${esc(fmtDateTime((byId.get(n.addendumOf) || {}).at || ''))}` : ''}</div>
        <div style="white-space:pre-wrap">${esc(n.text)}</div>
        ${can('records:write') && n.kind !== 'adendo' ? `<button class="btn sm ghost" data-add="${esc(n.id)}">Adendo</button>` : ''}</li>`).join('')}</ul>`
        : '<p class="muted">Nenhum registro ainda.</p>'}
    </section>`;
  const reload = () => notesTab(box, p);
  const sn = box.querySelector('#saveNote');
  if (sn) sn.onclick = async () => {
    const f = box.querySelector('#nForm');
    try { await api('POST', `/api/patients/${p.id}/notes`, readForm(f)); toast('Evolução registrada.'); reload(); } catch (e) { showErrors(f, e, box.querySelector('#nErr')); }
  };
  box.querySelectorAll('[data-add]').forEach((b) => {
    b.onclick = () => {
      const m = modal({ title: 'Adendo ao prontuário', body: '<div class="form" id="aForm"><div class="field s6"><label class="req" for="text">Complemento ou correção</label><textarea name="text" id="text" style="min-height:120px"></textarea></div><div class="field s6" id="aErr"></div></div>',
        foot: '<button class="btn" data-cancel>Cancelar</button><button class="btn primary" data-save>Registrar adendo</button>' });
      const f = m.el.querySelector('#aForm');
      m.el.querySelector('[data-cancel]').onclick = m.close;
      m.el.querySelector('[data-save]').onclick = async () => {
        try { await api('POST', `/api/patients/${p.id}/notes`, { ...readForm(f), addendumOf: b.dataset.add }); m.close(); toast('Adendo registrado.'); reload(); } catch (e) { showErrors(f, e, f.querySelector('#aErr')); }
      };
    };
  });
  box.querySelectorAll('[data-sig]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); openSignatureView(a.dataset.sig); }; });
  const na = box.querySelector('#newAnam'); if (na) na.onclick = () => openAnamnese(p, reload);
}

const ANAMNESE = [
  ['queixa', 'Queixa principal', 'text'], ['historia', 'História da doença atual', 'text'],
  ['doencas', 'Doenças pré-existentes', 'text'], ['cirurgias', 'Cirurgias e internações anteriores', 'text'],
  ['alergias', 'Alergias', 'text'], ['medicamentos', 'Medicamentos em uso', 'text'],
  ['familia', 'Histórico familiar', 'text'], ['habitos', 'Hábitos (fumo, álcool, atividade física)', 'text'],
  ['hipertensao', 'Pressão alta?', 'yn'], ['diabetes', 'Diabetes?', 'yn'], ['cardiaco', 'Problema cardíaco?', 'yn'],
  ['coagulacao', 'Problema de coagulação / sangramento?', 'yn'], ['gestante', 'Gestante ou amamentando?', 'yn'],
  ['anestesia', 'Já teve reação a anestesia?', 'yn'], ['obs', 'Outras observações', 'text'],
];

function openAnamnese(p, onDone) {
  const pre = { alergias: p.noKnownAllergies ? 'Nega alergias' : p.allergies || '', medicamentos: p.medications || '', doencas: p.comorbidities || '' };
  const m = modal({
    title: `Anamnese — ${p.name}`, wide: true,
    body: `<div class="form" id="anForm">${ANAMNESE.map(([k, label, t]) => (t === 'yn'
      ? `<div class="field s2"><label for="a_${k}">${esc(label)}</label><select name="${k}" id="a_${k}"><option value="">Não informado</option><option>Não</option><option>Sim</option></select></div>`
      : `<div class="field s3"><label for="a_${k}">${esc(label)}</label><textarea name="${k}" id="a_${k}">${esc(pre[k] || '')}</textarea></div>`)).join('')}
      <div class="field s6"><span class="hint">Depois de preencher, o paciente (ou responsável) confere e assina eletronicamente.</span></div></div>`,
    foot: '<button class="btn" data-cancel>Cancelar</button><button class="btn primary" data-save>Conferir e assinar</button>',
  });
  m.el.querySelector('[data-cancel]').onclick = m.close;
  m.el.querySelector('[data-save]').onclick = () => {
    const d = readForm(m.el.querySelector('#anForm'));
    const lines = ANAMNESE.map(([k, label]) => `${label}: ${(d[k] || '').trim() || 'Não informado'}`);
    const content = `ANAMNESE\nPaciente: ${p.name} — nascido(a) em ${fmtDate(p.birthDate)}\nData: ${fmtDate(todayStr())}\n\n${lines.join('\n')}\n\nDeclaro que as informações acima são verdadeiras e completas.`;
    m.close();
    openSignatureForm({ patient: p, docType: 'anamnese', content, title: `Anamnese — ${fmtDate(todayStr())}`, onDone: () => { toast('Anamnese assinada e registrada.'); onDone(); } });
  };
}

// ---------------- Odontograma ----------------
const TOOTH_COLORS = {
  higido: '#FFFFFF', carie: '#E35D6A', restaurado: '#1565D8', canal: '#7C5CDB', coroa: '#F0A93B', implante: '#12A4DC',
  ausente: '#8A9AB0', extracao_indicada: '#B3261E', fratura: '#C27BE0', selante: '#17A673',
};
const toothSvg = (status, upper) => {
  const fill = TOOTH_COLORS[status] || '#FFFFFF';
  const crown = upper ? 'M5 16 Q5 4 15 4 Q25 4 25 16 L25 22 Q15 26 5 22 Z' : 'M5 14 Q15 10 25 14 L25 20 Q25 32 15 32 Q5 32 5 20 Z';
  const root = upper ? 'M8 22 L10 34 M22 22 L20 34' : 'M8 14 L10 2 M22 14 L20 2';
  const x = status === 'ausente' || status === 'extracao_indicada' ? '<path d="M4 4 L26 32 M26 4 L4 32" stroke="#B3261E" stroke-width="2.5"/>' : '';
  return `<svg viewBox="0 0 30 36" aria-hidden="true"><path d="${root}" stroke="currentColor" stroke-width="2" opacity=".5" fill="none"/><path d="${crown}" fill="${fill}" stroke="currentColor" stroke-width="1.5"/>${x}</svg>`;
};

export async function odontoTab(box, p) {
  const o = await api('GET', `/api/patients/${p.id}/odontogram`);
  const M = state.meta;
  const T = M.teeth;
  const row = (list, upper) => `<div class="row">${list.map((t) => {
    const st = (o.teeth[t] || {}).status || 'higido';
    return `<button class="tooth" data-tooth="${t}" title="Dente ${t}: ${esc(M.toothStatus[st])}${o.teeth[t] && o.teeth[t].notes ? ` — ${esc(o.teeth[t].notes)}` : ''}">${upper ? `<small>${t}</small>` : ''}${toothSvg(st, upper)}${upper ? '' : `<small>${t}</small>`}</button>`;
  }).join('')}</div>`;
  box.innerHTML = `
    <section class="panel"><div class="page-head" style="margin-bottom:6px"><h3>Odontograma</h3><span class="muted small">Clique em um dente para registrar a situação. Numeração FDI.</span></div>
      <div class="odonto">
        <div class="small muted">Permanentes</div>${row(T.slice(0, 16), true)}<div class="row mid"></div>${row(T.slice(16, 32), false)}
        <div class="small muted" style="margin-top:12px">Decíduos (de leite)</div>${row(T.slice(32, 42), true)}${row(T.slice(42, 52), false)}
      </div>
      <ul class="legend" style="flex-direction:row;flex-wrap:wrap;gap:12px;margin-top:12px">${Object.entries(M.toothStatus).map(([k, l]) => `<li><span class="lab"><span class="sw" style="background:${TOOTH_COLORS[k]};border:1px solid var(--line)"></span>${esc(l)}</span></li>`).join('')}</ul>
    </section>
    <section class="panel"><h3 style="margin-bottom:8px">Histórico do odontograma</h3>
      ${o.history && o.history.length ? `<ul class="history">${o.history.slice(0, 50).map((h) => `<li class="small">${esc(fmtDateTime(h.at))} — ${esc(h.byName)}: dente <strong>${esc(h.tooth)}</strong> ${esc(M.toothStatus[h.from])} → ${esc(M.toothStatus[h.to])}${h.notes ? ` (${esc(h.notes)})` : ''}</li>`).join('')}</ul>` : '<p class="muted small">Sem alterações registradas.</p>'}
    </section>`;
  box.querySelectorAll('[data-tooth]').forEach((b) => {
    b.onclick = () => {
      if (!can('records:write')) return;
      const t = b.dataset.tooth; const cur = o.teeth[t] || {};
      const m = modal({ title: `Dente ${t}`, body: `<div class="form" id="tForm">
        <div class="field s3"><label class="req" for="status">Situação</label><select name="status" id="status">${options(M.toothStatus, cur.status || 'higido')}</select></div>
        <div class="field s3"><label for="notes">Observação</label><input name="notes" id="notes" maxlength="300" value="${esc(cur.notes || '')}" placeholder="Ex.: face oclusal, resina"></div>
        <div class="field s6" id="tErr"></div></div>`, foot: '<button class="btn" data-cancel>Cancelar</button><button class="btn primary" data-save>Salvar</button>' });
      const f = m.el.querySelector('#tForm');
      m.el.querySelector('[data-cancel]').onclick = m.close;
      m.el.querySelector('[data-save]').onclick = async () => {
        try { await api('PUT', `/api/patients/${p.id}/odontogram/${t}`, readForm(f)); m.close(); toast(`Dente ${t} atualizado.`); odontoTab(box, p); } catch (e) { showErrors(f, e, f.querySelector('#tErr')); }
      };
    };
  });
}

// ---------------- Exames ----------------
export async function examsTab(box, p) {
  const exams = await api('GET', `/api/patients/${p.id}/exams`);
  const M = state.meta;
  box.innerHTML = `
    <div class="page-head" style="margin-bottom:10px"><p class="muted" style="margin:0">Lance o resultado, anexe o arquivo e libere para o paciente ver no portal.</p>
      ${can('records:write') ? '<button class="btn primary" id="newExam">Lançar exame</button>' : ''}</div>
    ${exams.length ? exams.map((e) => `<section class="panel">
      <div class="page-head" style="margin-bottom:6px"><div><h3>${esc(e.title)}</h3><span class="muted small">${esc(M.examCategories[e.category])} · ${esc(fmtDate(e.examDate))} · lançado por ${esc(e.authorName)}</span></div>
        <div class="toolbar">${e.released ? `<span class="chip concluida">Liberado ao paciente</span>` : '<span class="chip">Não liberado</span>'}
          ${can('exams:release') ? `<button class="btn sm ${e.released ? '' : 'ok'}" data-rel="${esc(e.id)}" data-v="${e.released ? '0' : '1'}">${e.released ? 'Retirar do portal' : 'Liberar ao paciente'}</button>` : ''}
          ${can('records:write') ? `<button class="btn sm" data-edit="${esc(e.id)}">Editar</button><button class="btn sm" data-attach="${esc(e.id)}">Anexar arquivo</button>` : ''}</div></div>
      ${e.resultText ? `<div class="doc-text">${esc(e.resultText)}</div>` : '<p class="muted small">Resultado ainda não lançado.</p>'}
      ${e.patientMessage ? `<p class="small"><strong>Orientação ao paciente:</strong> ${esc(e.patientMessage)}</p>` : ''}
      ${e.internalNotes ? `<p class="small muted"><strong>Observação interna (o paciente não vê):</strong> ${esc(e.internalNotes)}</p>` : ''}
      ${e.files.length ? `<div class="toolbar">${e.files.map((f) => `<button class="btn sm" data-file="${esc(f.id)}">${esc(f.name)}</button>`).join('')}</div>` : ''}
      ${e.editedAfterRelease ? '<p class="small" style="color:var(--warn)">Alterado depois de liberado ao paciente.</p>' : ''}
    </section>`).join('') : '<div class="panel empty">Nenhum exame lançado.</div>'}`;
  const reload = () => examsTab(box, p);
  const ne = box.querySelector('#newExam'); if (ne) ne.onclick = () => examForm(p, null, reload);
  box.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => examForm(p, exams.find((e) => e.id === b.dataset.edit), reload); });
  box.querySelectorAll('[data-attach]').forEach((b) => { b.onclick = () => uploadForm(p, { examId: b.dataset.attach, kind: 'exame' }, reload); });
  box.querySelectorAll('[data-file]').forEach((b) => { b.onclick = () => openFile(`/api/files/${encodeURIComponent(b.dataset.file)}`); });
  box.querySelectorAll('[data-rel]').forEach((b) => {
    b.onclick = async () => {
      const rel = b.dataset.v === '1';
      if (rel && !(await confirmDialog('Liberar este resultado para o paciente ver no portal? Confira o texto antes.', { okLabel: 'Liberar' }))) return;
      try { await api('POST', `/api/exams/${encodeURIComponent(b.dataset.rel)}/release`, { released: rel }); toast(rel ? 'Exame liberado ao paciente.' : 'Exame retirado do portal.'); reload(); } catch (e) { toast(e.message, 'error'); }
    };
  });
}

function examForm(p, e, onDone) {
  const M = state.meta; const v = e || { category: 'laboratorial', examDate: todayStr() };
  const m = modal({
    title: e ? `Editar exame: ${e.title}` : 'Lançar exame', wide: true,
    body: `<div class="form" id="eForm">
      <div class="field s3"><label class="req" for="title">Exame</label><input name="title" id="title" value="${esc(v.title || '')}" placeholder="Ex.: Hemograma completo, Radiografia panorâmica"></div>
      <div class="field s2"><label class="req" for="category">Tipo</label><select name="category" id="category">${options(M.examCategories, v.category)}</select></div>
      <div class="field s1"><label class="req" for="examDate">Data</label><input type="date" name="examDate" id="examDate" value="${esc(v.examDate)}"></div>
      <div class="field s6"><label for="resultText">Resultado</label><textarea name="resultText" id="resultText" style="min-height:160px">${esc(v.resultText || '')}</textarea></div>
      <div class="field"><label for="patientMessage">Orientação ao paciente (aparece no portal)</label><textarea name="patientMessage" id="patientMessage">${esc(v.patientMessage || '')}</textarea></div>
      <div class="field"><label for="internalNotes">Observação interna (o paciente não vê)</label><textarea name="internalNotes" id="internalNotes">${esc(v.internalNotes || '')}</textarea></div>
      ${e && e.released ? '<div class="field s6"><div class="alert warn" style="margin:0">Este exame já está liberado: o paciente verá a alteração.</div></div>' : ''}
      <div class="field s6" id="eErr"></div></div>`,
    foot: '<button class="btn" data-cancel>Cancelar</button><button class="btn primary" data-save>Salvar</button>',
  });
  const f = m.el.querySelector('#eForm');
  m.el.querySelector('[data-cancel]').onclick = m.close;
  m.el.querySelector('[data-save]').onclick = async () => {
    try {
      if (e) await api('PUT', `/api/exams/${encodeURIComponent(e.id)}`, readForm(f));
      else await api('POST', `/api/patients/${p.id}/exams`, readForm(f));
      m.close(); toast('Exame salvo.'); onDone();
    } catch (err) { showErrors(f, err, f.querySelector('#eErr')); }
  };
}

// ---------------- Imagens e arquivos ----------------
export async function imagesTab(box, p) {
  const files = (await api('GET', `/api/patients/${p.id}/files`)).filter((f) => !f.examId);
  const M = state.meta;
  box.innerHTML = `
    <div class="page-head" style="margin-bottom:10px"><p class="muted" style="margin:0">Fotos clínicas, radiografias e documentos do paciente.</p>
      ${can('records:write') ? '<button class="btn primary" id="up">Enviar imagem ou PDF</button>' : ''}</div>
    ${files.length ? `<div class="gallery">${files.map((f) => `<figure data-file="${esc(f.id)}" tabindex="0">${f.mime === 'application/pdf' ? '<div class="pdf">PDF</div>' : `<img data-thumb="${esc(f.id)}" alt="${esc(f.caption || f.name)}">`}
      <figcaption><strong>${esc(M.fileKinds[f.kind])}</strong><br>${esc(f.caption || f.name)}<br><span class="muted">${esc(fmtDate(f.takenAt || f.createdAt.slice(0, 10)))}</span></figcaption></figure>`).join('')}</div>`
      : '<div class="panel empty">Nenhuma imagem enviada.</div>'}`;
  const reload = () => imagesTab(box, p);
  const up = box.querySelector('#up'); if (up) up.onclick = () => uploadForm(p, { kind: 'foto' }, reload);
  box.querySelectorAll('[data-file]').forEach((el) => { el.onclick = () => openFile(`/api/files/${encodeURIComponent(el.dataset.file)}`); el.onkeydown = (e) => { if (e.key === 'Enter') el.click(); }; });
  // Miniaturas carregadas sob demanda
  for (const img of box.querySelectorAll('[data-thumb]')) {
    try { const f = await api('GET', `/api/files/${encodeURIComponent(img.dataset.thumb)}`); img.src = f.dataUrl; } catch { /* sem miniatura */ }
  }
}

function uploadForm(p, { examId = null, kind = 'foto' }, onDone) {
  const M = state.meta;
  const kinds = examId ? { exame: M.fileKinds.exame } : Object.fromEntries(Object.entries(M.fileKinds).filter(([k]) => k !== 'exame'));
  const m = modal({
    title: examId ? 'Anexar arquivo ao exame' : 'Enviar imagem ou PDF',
    body: `<div class="form" id="uForm">
      <div class="field s6"><label class="req" for="file">Arquivo (PNG, JPG, WEBP ou PDF, até 8 MB)</label><input type="file" id="file" accept="image/png,image/jpeg,image/webp,application/pdf"></div>
      <div class="field s2"><label class="req" for="kind">Tipo</label><select name="kind" id="kind">${options(kinds, kind)}</select></div>
      <div class="field s2"><label for="takenAt">Data</label><input type="date" name="takenAt" id="takenAt" value="${esc(todayStr())}"></div>
      <div class="field s2"><label for="caption">Legenda</label><input name="caption" id="caption" maxlength="300"></div>
      <div class="field s6" id="uErr"></div></div>`,
    foot: '<button class="btn" data-cancel>Cancelar</button><button class="btn primary" data-save>Enviar</button>',
  });
  const f = m.el.querySelector('#uForm');
  m.el.querySelector('[data-cancel]').onclick = m.close;
  const btn = m.el.querySelector('[data-save]');
  btn.onclick = async () => {
    const file = f.querySelector('#file').files[0];
    const err = f.querySelector('#uErr');
    if (!file) { showErrors(f, { message: 'Escolha um arquivo.', fields: {} }, err); return; }
    if (file.size > 8 * 1024 * 1024) { showErrors(f, { message: 'O arquivo tem mais de 8 MB. Reduza o tamanho e tente de novo.', fields: {} }, err); return; }
    btn.disabled = true;
    try {
      const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Não foi possível ler o arquivo.')); r.readAsDataURL(file); });
      await api('POST', `/api/patients/${p.id}/files`, { ...readForm(f), name: file.name, dataUrl, examId });
      m.close(); toast('Arquivo enviado.'); onDone();
    } catch (e) { showErrors(f, e, err); } finally { btn.disabled = false; }
  };
}

// ---------------- Acesso ao portal ----------------
export async function portalTab(box, p) {
  const st = await api('GET', `/api/patients/${p.id}/portal`);
  box.innerHTML = `<section class="panel"><h3 style="margin-bottom:8px">Acesso do paciente ao portal</h3>
    <p class="small">No portal, o paciente vê os resultados de exames que o médico liberar e as próprias consultas, e pode confirmar ou cancelar a presença. Ele não vê prontuário, observações internas nem dados de outros pacientes.</p>
    ${st.exists ? `<dl class="kv"><dt>Login</dt><dd>${esc(st.email)}</dd><dt>Situação</dt><dd>${st.active ? '<span class="chip concluida">Ativo</span>' : '<span class="chip">Desativado</span>'}</dd></dl>` : ''}
    ${can('patients:write') ? `<div class="form" id="poForm" style="margin-top:12px">
      ${st.exists ? '' : `<div class="field s3"><label class="req" for="email">E-mail de acesso</label><input type="email" name="email" id="email" value="${esc(p.email || '')}"></div>`}
      <div class="field s3"><label class="${st.exists ? '' : 'req'}" for="password">${st.exists ? 'Nova senha (opcional)' : 'Senha inicial'}</label><input type="password" name="password" id="password" autocomplete="new-password"><span class="hint">Mín. 10 caracteres, letras e números. Entregue ao paciente pessoalmente.</span></div>
      <div class="field s6" id="poErr"></div>
      <div class="field s6"><div class="toolbar"><button class="btn primary" id="poSave">${st.exists ? 'Salvar' : 'Criar acesso'}</button>
        ${st.exists ? `<button class="btn ${st.active ? 'danger' : ''}" id="poToggle">${st.active ? 'Desativar acesso' : 'Reativar acesso'}</button>` : ''}</div></div></div>` : ''}
  </section>`;
  const f = box.querySelector('#poForm'); if (!f) return;
  const send = async (payload) => {
    try { await api('POST', `/api/patients/${p.id}/portal`, payload); toast('Acesso ao portal atualizado.'); portalTab(box, p); } catch (e) { showErrors(f, e, f.querySelector('#poErr')); }
  };
  f.querySelector('#poSave').onclick = () => { const d = readForm(f); if (st.exists && !d.password) return; send(d); };
  const t = f.querySelector('#poToggle'); if (t) t.onclick = () => send({ active: !st.active });
}

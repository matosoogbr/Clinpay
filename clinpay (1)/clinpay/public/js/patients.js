import {
  api, state, esc, fmtDate, fmtDateTime, age, toast, $, modal, showErrors, readForm, options, can,
  notifyChange, fmtCpf, maskCpf, cpfInputMask, ICONS, endTime,
} from './core.js';
import { openSurgeryForm, openSurgeryDetail } from './surgeries.js';
import { openSignatureForm, openSignatureView } from './signatures.js';
import { notesTab, odontoTab, examsTab, imagesTab, portalTab } from './records.js';

export async function patientsPage(page, params) {
  const q = params.get('q') || '';
  page.innerHTML = `
    <div class="page-head">
      <div><button class="btn menu-toggle" id="menuToggle" aria-label="Abrir menu">${ICONS.menu}</button><h1>Pacientes</h1></div>
      <div class="toolbar">
        <input id="search" class="btn" placeholder="Buscar por nome ou CPF" value="${esc(q)}" aria-label="Buscar paciente" style="min-width:260px;font-weight:400">
        ${can('patients:write') ? '<button class="btn primary" id="newP">Cadastrar paciente</button>' : ''}
      </div>
    </div>
    <div id="plist"></div>`;
  const nb = $('#newP');
  if (nb) nb.onclick = () => openPatientForm(null, (p) => { location.hash = `#/paciente/${p.id}`; });
  const load = async (term) => {
    const list = await api('GET', `/api/patients${term ? `?q=${encodeURIComponent(term)}` : ''}`);
    const el = $('#plist');
    if (!list.length) {
      el.innerHTML = `<div class="panel empty">${term ? `<p>Nenhum paciente encontrado para "${esc(term)}".</p>` : '<h2>Nenhum paciente cadastrado</h2><p>Cadastre o primeiro paciente para começar a agendar cirurgias.</p>'}</div>`;
      return;
    }
    el.innerHTML = `<div class="table-wrap"><table class="list"><thead><tr><th>Nome</th><th>Nascimento</th><th>CPF</th><th>Telefone</th><th>Alergias</th></tr></thead><tbody>
      ${list.map((p) => `<tr class="clickable" data-pid="${esc(p.id)}">
        <td><strong>${esc(p.name)}</strong>${p.socialName ? `<br><span class="muted small">Nome social: ${esc(p.socialName)}</span>` : ''}${p.active === false ? ' <span class="chip">Inativo</span>' : ''}</td>
        <td>${esc(fmtDate(p.birthDate))}<br><span class="muted small">${esc(age(p.birthDate))}</span></td>
        <td>${esc(maskCpf(p.cpf)) || '—'}</td>
        <td>${esc(p.phone || '—')}</td>
        <td>${p.noKnownAllergies ? '<span class="muted">Nega</span>' : `<span class="chip emergencia">${esc(p.allergies.length > 40 ? p.allergies.slice(0, 40) + '…' : p.allergies)}</span>`}</td>
      </tr>`).join('')}</tbody></table></div>`;
    el.querySelectorAll('[data-pid]').forEach((tr) => { tr.onclick = () => { location.hash = `#/paciente/${tr.dataset.pid}`; }; });
  };
  let t;
  $('#search').oninput = (e) => { clearTimeout(t); t = setTimeout(() => load(e.target.value.trim()), 300); };
  await load(q);
}

const waLink = (phone, text) => {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length < 10) return null;
  return `https://wa.me/${d.length <= 11 ? '55' + d : d}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
};

export async function patientDetailPage(page, id, params = new URLSearchParams()) {
  const TABS = [['cadastro', 'Cadastro', null], ['prontuario', 'Prontuário e anamnese', 'records:read'], ['odontograma', 'Odontograma', 'records:read'],
    ['exames', 'Exames', 'records:read'], ['imagens', 'Imagens', 'records:read'], ['portal', 'Portal do paciente', 'patients:read']].filter((t) => !t[2] || can(t[2]));
  const tab = TABS.some((t) => t[0] === params.get('aba')) ? params.get('aba') : 'cadastro';
  const [p, surgeries, sigs] = await Promise.all([
    api('GET', `/api/patients/${encodeURIComponent(id)}`),
    api('GET', `/api/surgeries?patientId=${encodeURIComponent(id)}`),
    api('GET', `/api/signatures?patientId=${encodeURIComponent(id)}`),
  ]);
  const M = state.meta;
  const kv = (label, v) => (v ? `<dt>${esc(label)}</dt><dd>${esc(v)}</dd>` : '');
  page.innerHTML = `
    <div class="page-head">
      <div><button class="btn menu-toggle" id="menuToggle" aria-label="Abrir menu">${ICONS.menu}</button>
        <a href="#/pacientes" class="small">‹ Pacientes</a>
        <h1>${esc(p.name)}</h1>
        <p class="muted">${p.socialName ? `Nome social: ${esc(p.socialName)} · ` : ''}${esc(fmtDate(p.birthDate))} · ${esc(age(p.birthDate))}${p.cpf ? ` · CPF ${esc(fmtCpf(p.cpf))}` : ''}${p.active === false ? ' · Inativo' : ''}</p></div>
      <div class="toolbar">
        ${can('patients:write') ? '<button class="btn" id="editP">Editar cadastro</button>' : ''}
        ${waLink(p.phone) ? `<a class="btn" id="waP" target="_blank" rel="noopener" href="${esc(waLink(p.phone, `Olá, ${(p.socialName || p.name).split(' ')[0]}!`))}">WhatsApp</a>` : ''}
        ${can('emails:send') && p.email ? '<button class="btn" id="mailP">Enviar e-mail</button>' : ''}
        ${can('signatures:create') ? '<button class="btn" id="signP">Coletar assinatura</button>' : ''}
        ${can('surgeries:write') && p.active !== false ? '<button class="btn primary" id="sxP">Agendar consulta</button>' : ''}
      </div>
    </div>
    ${p.noKnownAllergies ? '<div class="allergy none">Nega alergias</div>' : `<div class="allergy">Alergias: ${esc(p.allergies)}</div>`}
    <div class="tabs" role="tablist" style="margin-top:16px">${TABS.map(([k, l]) => `<button role="tab" data-ptab="${k}" class="${k === tab ? 'active' : ''}">${esc(l)}</button>`).join('')}</div>
    <div id="ptab"${tab === 'cadastro' ? '' : ' class="hidden"'}>
    <div class="grid2">
      <section class="panel"><h3 style="margin-bottom:10px">Identificação e contato</h3><dl class="kv">
        ${kv('Sexo', { F: 'Feminino', M: 'Masculino', I: 'Intersexo / não informado' }[p.sex])}
        ${kv('RG', p.rg)}${kv('Cartão SUS', p.cns)}${kv('Nome da mãe', p.motherName)}
        ${kv('Telefone', p.phone)}${kv('E-mail', p.email ? `${p.email}${p.emailReminders ? ' (recebe lembretes)' : ' (não recebe lembretes)'}` : '')}${kv('Endereço', [p.address, p.city].filter(Boolean).join(' — '))}
        ${kv('Contato de emergência', [p.emergencyName, p.emergencyPhone].filter(Boolean).join(' — '))}
        ${kv('Atendimento', p.coverage === 'convenio' ? `Convênio ${p.insurer || ''}${p.insuranceCard ? ` — carteirinha ${p.insuranceCard}` : ''}` : p.coverage === 'particular' ? 'Particular' : '')}
      </dl></section>
      <section class="panel"><h3 style="margin-bottom:10px">Dados clínicos</h3><dl class="kv">
        ${kv('Tipo sanguíneo', p.bloodType)}${kv('Peso', p.weightKg ? `${p.weightKg} kg` : '')}${kv('Altura', p.heightCm ? `${p.heightCm} cm` : '')}
        ${kv('Comorbidades', p.comorbidities)}${kv('Medicamentos em uso', p.medications)}${kv('Observações', p.notes)}
      </dl>${!p.bloodType && !p.comorbidities && !p.medications && !p.notes ? '<p class="muted">Nenhum dado clínico registrado.</p>' : ''}</section>
    </div>
    <section class="panel"><h3 style="margin-bottom:10px">Consultas e cirurgias</h3>
      ${surgeries.length ? `<div class="table-wrap"><table class="list"><thead><tr><th>Data</th><th>Atendimento</th><th>Sala / médico(a)</th><th>Situação</th></tr></thead><tbody>
      ${surgeries.slice().reverse().map((s) => `<tr class="clickable" data-sx="${esc(s.id)}"><td>${esc(fmtDate(s.date))}<br><span class="muted small">${esc(s.startTime)}–${esc(endTime(s.startTime, s.durationMin))}</span></td>
        <td><span class="chip">${esc(M.types[s.type])}</span> ${esc(s.procedureName)}${s.type === 'cirurgia' ? ` <span class="chip">${esc(M.laterality[s.laterality])}</span>` : ''}</td><td>${esc(s.roomName)}<br><span class="muted small">${esc(s.surgeonName)}</span></td>
        <td><span class="chip ${esc(s.status)}">${esc(M.status[s.status])}</span></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nenhum atendimento registrado.</p>'}
    </section>
    <section class="panel"><h3 style="margin-bottom:10px">Documentos assinados</h3>
      ${sigs.length ? `<ul class="history">${sigs.map((x) => `<li><a href="#" data-sig="${esc(x.id)}">${esc(x.title)}</a> — ${esc(x.signerName)} (${esc(M.signerRoles[x.signerRole])}), ${esc(fmtDateTime(x.signedAt))}</li>`).join('')}</ul>` : '<p class="muted">Nenhum documento assinado.</p>'}
    </section></div>
    <div id="ptab2"${tab === 'cadastro' ? ' class="hidden"' : ''}></div>`;
  page.querySelectorAll('[data-ptab]').forEach((b) => { b.onclick = () => { location.hash = `#/paciente/${p.id}?aba=${b.dataset.ptab}`; }; });
  const loaders = { prontuario: notesTab, odontograma: odontoTab, exames: examsTab, imagens: imagesTab, portal: portalTab };
  if (loaders[tab]) loaders[tab]($('#ptab2'), p).catch((e) => { $('#ptab2').innerHTML = `<div class="alert danger">${esc(e.message)}</div>`; });
  const e1 = $('#editP'); if (e1) e1.onclick = () => openPatientForm(p, () => notifyChange());
  const e2 = $('#signP'); if (e2) e2.onclick = () => openSignatureForm({ patient: p, onDone: () => notifyChange() });
  const e3 = $('#sxP'); if (e3) e3.onclick = () => openSurgeryForm({ patientId: p.id });
  const e4 = $('#mailP'); if (e4) e4.onclick = () => openMailForm(p);
  page.querySelectorAll('[data-sx]').forEach((tr) => { tr.onclick = () => openSurgeryDetail(tr.dataset.sx); });
  page.querySelectorAll('[data-sig]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); openSignatureView(a.dataset.sig); }; });
}

function openMailForm(p) {
  const m = modal({
    title: 'Enviar e-mail ao paciente',
    body: `<div class="form" id="mForm">
      <div class="field s6 alert info" style="display:block">Para: <strong>${esc(p.name)}</strong> &lt;${esc(p.email)}&gt;${p.emailReminders ? '' : '<br><span class="small">Este paciente não autorizou lembretes automáticos. Use para assuntos do atendimento dele.</span>'}</div>
      <div class="field s6"><label class="req" for="subject">Assunto</label><input name="subject" id="subject" maxlength="150"></div>
      <div class="field s6"><label class="req" for="message">Mensagem</label><textarea name="message" id="message" style="min-height:160px"></textarea>
        <span class="hint">O e-mail sai com o nome da clínica e assinado com o seu nome. Evite dados de saúde além do necessário.</span></div>
      <div class="field s6" id="mErr"></div></div>`,
    foot: '<button class="btn" data-cancel>Cancelar</button><button class="btn primary" data-save>Enviar</button>',
  });
  const f = m.el.querySelector('#mForm');
  m.el.querySelector('[data-cancel]').onclick = m.close;
  const btn = m.el.querySelector('[data-save]');
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await api('POST', `/api/patients/${encodeURIComponent(p.id)}/email`, readForm(f));
      m.close(); toast('E-mail enviado para a fila de envio.');
    } catch (e) { showErrors(f, e, f.querySelector('#mErr')); } finally { btn.disabled = false; }
  };
}

export function openPatientForm(existing, onSaved) {
  // existing com id = edição; sem id = cadastro novo com dados pré-preenchidos (ex.: vindo do CRM)
  const isEdit = !!(existing && existing.id);
  const p = existing || { sex: '', coverage: 'particular' };
  const m = modal({
    title: isEdit ? 'Editar paciente' : 'Cadastrar paciente',
    wide: true,
    body: `
    <div class="form" id="pForm">
      <div class="field s4"><label class="req" for="name">Nome completo</label><input name="name" id="name" value="${esc(p.name || '')}" maxlength="200"></div>
      <div class="field s2"><label for="socialName">Nome social</label><input name="socialName" id="socialName" value="${esc(p.socialName || '')}"></div>
      <div class="field s2"><label class="req" for="birthDate">Data de nascimento</label><input type="date" name="birthDate" id="birthDate" value="${esc(p.birthDate || '')}"></div>
      <div class="field s2"><label class="req" for="sex">Sexo</label><select name="sex" id="sex">${options({ F: 'Feminino', M: 'Masculino', I: 'Intersexo / não informado' }, p.sex, 'Selecione…')}</select></div>
      <div class="field s2"><label for="cpf">CPF</label><input name="cpf" id="cpf" inputmode="numeric" value="${esc(fmtCpf(p.cpf))}" placeholder="000.000.000-00"></div>
      <div class="field s2"><label for="rg">RG</label><input name="rg" id="rg" value="${esc(p.rg || '')}"></div>
      <div class="field s2"><label for="cns">Cartão SUS</label><input name="cns" id="cns" value="${esc(p.cns || '')}"></div>
      <div class="field s2"><label for="motherName">Nome da mãe</label><input name="motherName" id="motherName" value="${esc(p.motherName || '')}"></div>

      <div class="fieldset-title">Alergias e dados clínicos</div>
      <div class="field s4"><label class="req" for="allergies">Alergias</label><textarea name="allergies" id="allergies" placeholder="Medicamentos, látex, alimentos, esparadrapo…">${esc(p.allergies || '')}</textarea>
        <span class="hint">Obrigatório: descreva as alergias ou marque "Nega alergias".</span></div>
      <div class="field s2"><label class="check" style="margin-top:28px"><input type="checkbox" name="noKnownAllergies" id="nka"${p.noKnownAllergies ? ' checked' : ''}> Nega alergias (confirmado com o paciente)</label></div>
      <div class="field s2"><label for="bloodType">Tipo sanguíneo</label><select name="bloodType" id="bloodType">${options(Object.fromEntries(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((x) => [x, x])), p.bloodType, 'Não informado')}</select></div>
      <div class="field s2"><label for="weightKg">Peso (kg)</label><input type="number" name="weightKg" id="weightKg" min="1" max="400" value="${esc(p.weightKg ?? '')}"></div>
      <div class="field s2"><label for="heightCm">Altura (cm)</label><input type="number" name="heightCm" id="heightCm" min="20" max="250" value="${esc(p.heightCm ?? '')}"></div>
      <div class="field"><label for="comorbidities">Comorbidades</label><textarea name="comorbidities" id="comorbidities">${esc(p.comorbidities || '')}</textarea></div>
      <div class="field"><label for="medications">Medicamentos em uso</label><textarea name="medications" id="medications">${esc(p.medications || '')}</textarea></div>

      <div class="fieldset-title">Contato</div>
      <div class="field s2"><label for="phone">Telefone</label><input name="phone" id="phone" inputmode="tel" value="${esc(p.phone || '')}"></div>
      <div class="field s2"><label for="email">E-mail</label><input type="email" name="email" id="email" value="${esc(p.email || '')}"></div>
      <div class="field s2"><label for="city">Cidade</label><input name="city" id="city" value="${esc(p.city || '')}"></div>
      <div class="field s3"><label class="check"><input type="checkbox" name="emailReminders"${p.emailReminders ? ' checked' : ''}> Autorizou lembretes por e-mail</label></div>
      <div class="field s3"><label class="check"><input type="checkbox" name="whatsappReminders"${p.whatsappReminders ? ' checked' : ''}> Autorizou lembretes por WhatsApp (celular com DDD)</label></div>
      <div class="field s6"><span class="hint">Os lembretes informam data, horário, local, orientações e um link para o paciente confirmar ou cancelar. Só marque com a autorização do paciente.</span></div>
      <div class="field s6"><label for="address">Endereço</label><input name="address" id="address" value="${esc(p.address || '')}"></div>
      <div class="field"><label for="emergencyName">Contato de emergência</label><input name="emergencyName" id="emergencyName" value="${esc(p.emergencyName || '')}"></div>
      <div class="field"><label for="emergencyPhone">Telefone de emergência</label><input name="emergencyPhone" id="emergencyPhone" value="${esc(p.emergencyPhone || '')}"></div>

      <div class="fieldset-title">Atendimento</div>
      <div class="field s2"><label for="coverage">Tipo</label><select name="coverage" id="coverage">${options({ particular: 'Particular', convenio: 'Convênio' }, p.coverage)}</select></div>
      <div class="field s2"><label for="insurer">Convênio</label><input name="insurer" id="insurer" value="${esc(p.insurer || '')}"></div>
      <div class="field s2"><label for="insuranceCard">Carteirinha</label><input name="insuranceCard" id="insuranceCard" value="${esc(p.insuranceCard || '')}"></div>
      <div class="field s6"><label for="notes">Observações</label><textarea name="notes" id="notes">${esc(p.notes || '')}</textarea></div>
      ${isEdit ? `<div class="field s6"><label class="check"><input type="checkbox" name="active"${p.active !== false ? ' checked' : ''}> Cadastro ativo</label></div>` : ''}
      <div class="field s6" id="pErr"></div>
    </div>`,
    foot: `<button class="btn" data-cancel>Cancelar</button><button class="btn primary" data-save>${isEdit ? 'Salvar alterações' : 'Cadastrar paciente'}</button>`,
  });
  const f = m.el.querySelector('#pForm');
  cpfInputMask(f.querySelector('#cpf'));
  const nka = f.querySelector('#nka'); const alg = f.querySelector('#allergies');
  const sync = () => { alg.disabled = nka.checked; if (nka.checked) alg.value = ''; };
  nka.onchange = sync; sync();
  m.el.querySelector('[data-cancel]').onclick = m.close;
  const btn = m.el.querySelector('[data-save]');
  btn.onclick = async () => {
    const data = readForm(f);
    btn.disabled = true;
    try {
      const saved = isEdit
        ? await api('PUT', `/api/patients/${encodeURIComponent(existing.id)}`, data)
        : await api('POST', '/api/patients', data);
      m.close();
      toast(isEdit ? 'Cadastro atualizado.' : 'Paciente cadastrado.');
      if (onSaved) onSaved(saved);
    } catch (e) { showErrors(f, e, f.querySelector('#pErr')); } finally { btn.disabled = false; }
  };
}

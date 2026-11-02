import { api, state, esc, fmtDateTime, toast, $, modal, showErrors, readForm, options, notifyChange, ICONS, fmtMoney, parseMoney, moneyInput } from './core.js';

const TABS = {
  rooms: { label: 'Salas e consultórios', singular: 'sala' },
  professionals: { label: 'Profissionais', singular: 'profissional' },
  procedures: { label: 'Procedimentos', singular: 'procedimento' },
};

export async function catalogPage(page, params) {
  const tab = TABS[params.get('tab')] ? params.get('tab') : 'rooms';
  const list = await api('GET', `/api/${tab}`);
  const M = state.meta;
  const cols = {
    rooms: ['Sala', 'Observações', 'Situação'],
    professionals: ['Nome', 'Função', 'Especialidade', 'Conselho', 'Consulta', 'Situação'],
    procedures: ['Procedimento', 'Especialidade', 'Código TUSS', 'Preço', 'Duração padrão', 'Situação'],
  }[tab];
  const row = (d) => {
    const st = d.active ? '<span class="chip concluida">Ativo</span>' : '<span class="chip">Inativo</span>';
    if (tab === 'rooms') return [esc(d.name), esc(d.notes || '—'), st];
    if (tab === 'professionals') {
      return [`<span class="color-dot" data-color="${esc(d.color || '')}"></span>${esc(d.name)}`, esc(M.professionalRoles[d.role]), esc(d.specialty || '—'), esc(d.council || '—'), d.consultPriceCents ? esc(fmtMoney(d.consultPriceCents)) : '—', st];
    }
    return [esc(d.name), esc(d.category || '—'), esc(d.code || '—'), d.priceCents ? esc(fmtMoney(d.priceCents)) : '—', d.defaultDurationMin ? `${esc(d.defaultDurationMin)} min` : '—', st];
  };
  page.innerHTML = `
    <div class="page-head">
      <div><button class="btn menu-toggle" id="menuToggle" aria-label="Abrir menu">${ICONS.menu}</button><h1>Salas e equipe</h1></div>
      <div class="toolbar">
        ${tab === 'procedures' ? '<button class="btn" id="impDefault">Importar catálogo padrão</button><button class="btn" id="impCsv">Importar planilha (TUSS)</button>' : ''}
        <button class="btn primary" id="addBtn">Cadastrar ${esc(TABS[tab].singular)}</button></div>
    </div>
    <div class="tabs" role="tablist">${Object.entries(TABS).map(([k, t]) => `<button role="tab" data-tab="${k}" class="${k === tab ? 'active' : ''}" aria-selected="${k === tab}">${esc(t.label)}</button>`).join('')}</div>
    ${list.length ? `<div class="table-wrap"><table class="list"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>
      ${list.map((d) => `<tr class="clickable" data-id="${esc(d.id)}">${row(d).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
      : `<div class="panel empty">Nenhum(a) ${esc(TABS[tab].singular)} cadastrado(a).</div>`}
    <p class="muted small" style="margin-top:12px">Para preservar o histórico, cadastros não são apagados: desative-os quando não forem mais usados.</p>`;
  page.querySelectorAll('[data-color]').forEach((el) => { if (/^#[0-9a-fA-F]{6}$/.test(el.dataset.color)) el.style.background = el.dataset.color; else el.remove(); });
  page.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { location.hash = `#/cadastros?tab=${b.dataset.tab}`; }; });
  $('#addBtn').onclick = () => openCatalogForm(tab, null);
  const idf = $('#impDefault'); if (idf) idf.onclick = importDefault;
  const icsv = $('#impCsv'); if (icsv) icsv.onclick = importCsv;
  page.querySelectorAll('[data-id]').forEach((tr) => { tr.onclick = () => openCatalogForm(tab, list.find((x) => x.id === tr.dataset.id)); });
}

function importDefault() {
  const cats = state.meta.procedureCategories || [];
  const m = modal({
    title: 'Importar catálogo padrão de procedimentos',
    body: `<p class="small">São cerca de 170 procedimentos comuns, com duração sugerida. Eles entram <strong>sem preço e sem código TUSS</strong>: preencha esses dados ou importe a tabela TUSS oficial da ANS pela planilha. Procedimentos com o mesmo nome não são duplicados.</p>
      <div class="form" id="cForm">${cats.map((c) => `<div class="field s2"><label class="check"><input type="checkbox" data-cat="${esc(c)}" checked> ${esc(c)}</label></div>`).join('')}</div>`,
    foot: '<button class="btn" data-cancel>Cancelar</button><button class="btn primary" data-save>Importar selecionados</button>',
  });
  m.el.querySelector('[data-cancel]').onclick = m.close;
  m.el.querySelector('[data-save]').onclick = async () => {
    const categories = [...m.el.querySelectorAll('[data-cat]:checked')].map((x) => x.dataset.cat);
    if (!categories.length) { toast('Selecione pelo menos uma especialidade.', 'error'); return; }
    try { const r = await api('POST', '/api/procedures/import-default', { categories }); m.close(); toast(`${r.added} procedimentos importados${r.skipped ? ` (${r.skipped} já existiam)` : ''}.`); notifyChange(); } catch (e) { toast(e.message, 'error'); }
  };
}

function importCsv() {
  const m = modal({
    title: 'Importar procedimentos de planilha',
    body: `<p class="small">Salve a planilha como <strong>CSV</strong> (no Excel: Arquivo → Salvar como → CSV). A primeira linha deve ter os títulos das colunas. Colunas aceitas: <strong>nome</strong> (obrigatória), codigo, preco, duracao, especialidade. Separador: ponto e vírgula ou vírgula.</p>
      <pre class="doc-text" style="max-height:none">nome;codigo;preco;duracao;especialidade
Consulta em consultório;10101012;250,00;30;Consultas</pre>
      <div class="form" id="csvForm"><div class="field s6"><label class="req" for="csv">Arquivo CSV</label><input type="file" id="csv" accept=".csv,text/csv"></div><div class="field s6" id="csvErr"></div></div>`,
    foot: '<button class="btn" data-cancel>Cancelar</button><button class="btn primary" data-save>Importar</button>',
  });
  const f = m.el.querySelector('#csvForm');
  m.el.querySelector('[data-cancel]').onclick = m.close;
  m.el.querySelector('[data-save]').onclick = async () => {
    const file = f.querySelector('#csv').files[0];
    const errBox = f.querySelector('#csvErr');
    if (!file) { errBox.innerHTML = '<div class="alert danger">Escolha o arquivo.</div>'; return; }
    try {
      const rows = parseCsv(await file.text());
      if (!rows.length) throw new Error('Nenhuma linha encontrada. Confira se a primeira linha tem os títulos (nome, codigo, preco…).');
      const r = await api('POST', '/api/procedures/import', { rows });
      m.close(); toast(`${r.added} procedimentos importados${r.skipped ? `, ${r.skipped} já existiam` : ''}.`); notifyChange();
    } catch (e) { errBox.innerHTML = `<div class="alert danger">${esc(e.message)}${e.fields && e.fields.rows ? `<br><span class="small">${esc(e.fields.rows)}</span>` : ''}</div>`; }
  };
}

/** Lê CSV simples (; ou ,) com aspas. Converte preço "250,00" em centavos. */
function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const sep = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ',';
  const split = (line) => {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; } else if (ch === sep && !q) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur); return out.map((x) => x.trim());
  };
  const norm = (h) => h.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const head = split(lines[0]).map(norm);
  const idx = (names) => head.findIndex((h) => names.includes(h));
  const iN = idx(['nome', 'procedimento', 'descricao', 'termo']); const iC = idx(['codigo', 'cod', 'tuss', 'codigo tuss']);
  const iP = idx(['preco', 'valor']); const iD = idx(['duracao', 'minutos']); const iE = idx(['especialidade', 'categoria', 'grupo']);
  if (iN < 0) throw new Error('A planilha precisa de uma coluna "nome".');
  return lines.slice(1).map((l) => {
    const c = split(l);
    const price = iP >= 0 && c[iP] ? parseMoney(c[iP]) : null;
    return {
      name: c[iN], code: iC >= 0 ? c[iC] || null : null,
      priceCents: Number.isNaN(price) ? -1 : price,
      defaultDurationMin: iD >= 0 && c[iD] ? Number(c[iD]) : null,
      category: iE >= 0 ? c[iE] || null : null,
    };
  });
}

function openCatalogForm(tab, d) {
  const M = state.meta;
  const v = d || { active: true, color: '#1565D8' };
  const activeField = d ? `<div class="field s6"><label class="check"><input type="checkbox" name="active"${v.active ? ' checked' : ''}> Ativo</label></div>` : '';
  const fields = {
    rooms: `
      <div class="field s6"><label class="req" for="name">Nome da sala</label><input name="name" id="name" value="${esc(v.name || '')}" placeholder="Ex.: Sala 1"></div>
      <div class="field s6"><label for="notes">Observações</label><textarea name="notes" id="notes">${esc(v.notes || '')}</textarea></div>`,
    professionals: `
      <div class="field s4"><label class="req" for="name">Nome completo</label><input name="name" id="name" value="${esc(v.name || '')}"></div>
      <div class="field s2"><label class="req" for="role">Função</label><select name="role" id="role">${options(M.professionalRoles, v.role, 'Selecione…')}</select></div>
      <div class="field s2"><label for="specialty">Especialidade</label><input name="specialty" id="specialty" value="${esc(v.specialty || '')}"></div>
      <div class="field s2"><label for="council">Conselho (CRM/COREN e UF)</label><input name="council" id="council" value="${esc(v.council || '')}" placeholder="Ex.: CRM-MG 12345"></div>
      <div class="field s2"><label for="color">Cor na agenda</label><input type="color" name="color" id="color" value="${esc(v.color || '#1565D8')}"></div>
      <div class="field s3"><label for="phone">Telefone</label><input name="phone" id="phone" value="${esc(v.phone || '')}"></div>
      <div class="field s3"><label for="email">E-mail</label><input type="email" name="email" id="email" value="${esc(v.email || '')}"></div>
      <div class="field s3"><label for="priceC">Valor da consulta (R$)</label><input id="priceC" data-money="consultPriceCents" inputmode="decimal" value="${esc(moneyInput(v.consultPriceCents))}" placeholder="0,00">
        <span class="hint">Sugerido ao agendar consultas deste médico.</span></div>
      <div class="fieldset-title">Expediente (usado para sugerir horários livres)</div>
      <div class="field s6"><div class="table-wrap"><table class="list" id="whTable"><thead><tr><th>Dia</th><th>Atende</th><th>Manhã / 1º período</th><th>Tarde / 2º período</th></tr></thead><tbody>
        ${['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'].map((dn, i) => {
          const wh = v.workHours || (d ? null : null);
          const def = i >= 1 && i <= 5 ? [['08:00', '12:00'], ['13:00', '18:00']] : [];
          const r = wh ? wh[String(i)] || [] : def;
          return `<tr data-day="${i}"><td>${dn}</td><td><input type="checkbox" data-on${r.length ? ' checked' : ''} aria-label="Atende ${dn}"></td>
            <td><input type="time" data-a1 value="${esc((r[0] || [])[0] || '')}"> às <input type="time" data-b1 value="${esc((r[0] || [])[1] || '')}"></td>
            <td><input type="time" data-a2 value="${esc((r[1] || [])[0] || '')}"> às <input type="time" data-b2 value="${esc((r[1] || [])[1] || '')}"></td></tr>`;
        }).join('')}</tbody></table></div>
        <span class="hint">Deixe o 2º período em branco se o médico atende em um único horário corrido.</span></div>
      <div class="field s6"><label class="check"><input type="checkbox" name="emailReminders"${v.emailReminders ? ' checked' : ''}> Receber por e-mail os avisos e lembretes das cirurgias em que participa</label></div>`,
    procedures: `
      <div class="field s4"><label class="req" for="name">Nome do procedimento</label><input name="name" id="name" value="${esc(v.name || '')}"></div>
      <div class="field s2"><label for="code">Código TUSS</label><input name="code" id="code" value="${esc(v.code || '')}"></div>
      <div class="field s3"><label for="category">Especialidade</label><input name="category" id="category" list="cats" value="${esc(v.category || '')}"><datalist id="cats">${(M.procedureCategories || []).map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div>
      <div class="field s3"><label for="kind">Tipo</label><select name="kind" id="kind">${options({ consulta: 'Consulta / procedimento ambulatorial', cirurgia: 'Cirurgia' }, v.kind || 'consulta')}</select></div>
      <div class="field s2"><label for="priceP">Preço (R$)</label><input id="priceP" data-money="priceCents" inputmode="decimal" value="${esc(moneyInput(v.priceCents))}" placeholder="0,00"></div>
      <div class="field s2"><label for="defaultDurationMin">Duração padrão (min)</label><input type="number" min="10" max="1440" step="5" name="defaultDurationMin" id="defaultDurationMin" value="${esc(v.defaultDurationMin ?? '')}"></div>
      <div class="field s4"><label class="check" style="margin-top:28px"><input type="checkbox" name="requiresLaterality"${v.requiresLaterality ? ' checked' : ''}> Exige informar o lado (direito/esquerdo/bilateral)</label></div>`,
  }[tab];
  const m = modal({
    title: `${d ? 'Editar' : 'Cadastrar'} ${TABS[tab].singular}`,
    body: `<div class="form" id="cForm">${fields}${activeField}<div class="field s6" id="cErr"></div></div>`,
    foot: `<button class="btn" data-cancel>Cancelar</button><button class="btn primary" data-save>${d ? 'Salvar alterações' : 'Cadastrar'}</button>`,
  });
  const f = m.el.querySelector('#cForm');
  m.el.querySelector('[data-cancel]').onclick = m.close;
  m.el.querySelector('[data-save]').onclick = async () => {
    const data = readForm(f);
    const wt = f.querySelector('#whTable');
    if (wt) {
      const wh = {};
      for (const tr of wt.querySelectorAll('[data-day]')) {
        if (!tr.querySelector('[data-on]').checked) continue;
        const r = [];
        const a1 = tr.querySelector('[data-a1]').value; const b1 = tr.querySelector('[data-b1]').value;
        const a2 = tr.querySelector('[data-a2]').value; const b2 = tr.querySelector('[data-b2]').value;
        if (a1 || b1) r.push([a1, b1]);
        if (a2 || b2) r.push([a2, b2]);
        if (r.length) wh[tr.dataset.day] = r;
      }
      data.workHours = wh;
    }
    for (const el of f.querySelectorAll('[data-money]')) {
      const cents = parseMoney(el.value);
      if (Number.isNaN(cents)) { showErrors(f, { message: 'Valor inválido. Use o formato 150,00.', fields: {} }, f.querySelector('#cErr')); return; }
      data[el.dataset.money] = cents;
    }
    try {
      if (d) await api('PUT', `/api/${tab}/${encodeURIComponent(d.id)}`, data);
      else await api('POST', `/api/${tab}`, data);
      m.close(); toast('Cadastro salvo.'); notifyChange();
    } catch (e) { showErrors(f, e, f.querySelector('#cErr')); }
  };
}

export async function usersPage(page) {
  const [users, pros] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/professionals')]);
  const proName = (id) => (pros.find((p) => p.id === id) || {}).name || '';
  page.innerHTML = `
    <div class="page-head">
      <div><button class="btn menu-toggle" id="menuToggle" aria-label="Abrir menu">${ICONS.menu}</button><h1>Médicos e acessos</h1>
      <p class="muted">Cada pessoa tem o próprio acesso: as ações ficam registradas em nome de quem as fez.</p></div>
      <div class="toolbar">
        <button class="btn" data-new="funcionario">Cadastrar funcionário</button>
        <button class="btn" data-new="outro">Outro acesso</button>
        <button class="btn primary" data-new="medico">Cadastrar médico</button>
      </div>
    </div>
    <div class="table-wrap"><table class="list"><thead><tr><th>Nome</th><th>E-mail (login)</th><th>Perfil</th><th>Médico vinculado</th><th>Situação</th></tr></thead><tbody>
    ${users.map((u) => `<tr class="clickable" data-id="${esc(u.id)}"><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.roleLabel)}</td>
      <td>${esc(proName(u.professionalId)) || '<span class="muted">—</span>'}</td>
      <td>${u.active ? '<span class="chip concluida">Ativo</span>' : '<span class="chip">Inativo</span>'}</td></tr>`).join('')}
    </tbody></table></div>
    <section class="panel" style="margin-top:16px"><h3>O que cada perfil pode fazer</h3>
      <dl class="kv" style="margin-top:8px">
        <dt>Médico(a) responsável</dt><dd>Acesso total à clínica: agenda de todos os médicos, financeiro completo, cadastros, acessos, e-mails e auditoria.</dd>
        <dt>Médico(a)</dt><dd>Dia a dia: a própria agenda, pacientes, termos, checklist, e-mails aos pacientes e o próprio financeiro.</dd>
        <dt>Funcionário(a) do médico</dt><dd>Agenda e financeiro do médico ao qual está vinculado, pacientes, coleta de termos e e-mails. Não faz checklist cirúrgico.</dd>
        <dt>Recepção da clínica</dt><dd>Agenda e financeiro de todos os médicos, pacientes e coleta de termos.</dd>
        <dt>Enfermagem</dt><dd>Pacientes, termos, checklist e início/fim de cirurgias. Sem financeiro.</dd>
      </dl></section>`;
  page.querySelectorAll('[data-new]').forEach((b) => { b.onclick = () => openUserForm(null, pros, b.dataset.new); });
  page.querySelectorAll('[data-id]').forEach((tr) => { tr.onclick = () => openUserForm(users.find((u) => u.id === tr.dataset.id), pros); });
}

function openUserForm(u, pros, preset) {
  const M = state.meta;
  const role0 = u ? u.role : preset === 'outro' ? '' : preset;
  const titles = { medico: 'Cadastrar médico', funcionario: 'Cadastrar funcionário do médico', outro: 'Criar acesso' };
  const doctors = pros.filter((p) => p.active && ['medico', 'cirurgiao'].includes(p.role));
  const m = modal({
    title: u ? 'Editar acesso' : titles[preset] || 'Criar acesso',
    body: `<div class="form" id="uForm">
      <div class="field"><label class="req" for="name">Nome completo</label><input name="name" id="name" value="${esc(u ? u.name : '')}"></div>
      <div class="field"><label class="req" for="email">E-mail (login)</label><input type="email" name="email" id="email" value="${esc(u ? u.email : '')}" autocomplete="off"></div>
      <div class="field"><label class="req" for="role">Perfil</label><select name="role" id="role">${options(M.roles, role0, 'Selecione…')}</select></div>
      <div class="field" id="linkBox"><label id="linkLabel" for="professionalId">Médico vinculado</label><select name="professionalId" id="professionalId"><option value="">Nenhum</option>
        ${pros.map((p) => `<option value="${esc(p.id)}"${u && u.professionalId === p.id ? ' selected' : ''}>${esc(p.name)} — ${esc(M.professionalRoles[p.role])}</option>`).join('')}</select>
        <span class="hint" id="linkHint"></span></div>
      ${u ? '' : `<div class="field s6" id="newProBox"><div class="alert info small" style="margin:0">Será criado também o cadastro deste médico na agenda, com o mesmo nome. Depois você pode definir cor, telefone e valor da consulta em "Salas e equipe".</div></div>
      <div class="field s3 np"><label for="specialty">Especialidade</label><input id="specialty" placeholder="Ex.: Dermatologia"></div>
      <div class="field s3 np"><label for="council">CRM</label><input id="council" placeholder="Ex.: CRM-MG 12345"></div>`}
      <div class="field s6"><label class="${u ? '' : 'req'}" for="password">${u ? 'Nova senha (deixe em branco para manter)' : 'Senha inicial'}</label>
        <input type="password" name="password" id="password" autocomplete="new-password"><span class="hint">Mínimo de 10 caracteres, com letras e números. Peça para a pessoa trocar no primeiro acesso.</span></div>
      ${u ? `<div class="field s6"><label class="check"><input type="checkbox" name="active"${u.active ? ' checked' : ''}> Acesso ativo</label></div>` : ''}
      <div class="field s6" id="uErr"></div></div>`,
    foot: `<button class="btn" data-cancel>Cancelar</button><button class="btn primary" data-save>${u ? 'Salvar alterações' : 'Criar acesso'}</button>`,
  });
  const f = m.el.querySelector('#uForm');
  const roleSel = f.querySelector('#role'); const proSel = f.querySelector('#professionalId');
  const sync = () => {
    const r = roleSel.value;
    const needs = ['medico', 'funcionario'].includes(r);
    f.querySelector('#linkLabel').classList.toggle('req', r === 'funcionario' || (r === 'medico' && !!u));
    f.querySelector('#linkHint').textContent = r === 'funcionario' ? 'O funcionário verá a agenda e o financeiro só deste médico.'
      : r === 'medico' ? (u ? 'Cadastro do médico na agenda.' : 'Deixe "Nenhum" para criar o cadastro automaticamente, ou escolha um já existente.')
        : r === 'admin' ? 'Se o médico responsável também atende, vincule o cadastro dele na agenda.' : 'Opcional.';
    const np = !u && r === 'medico' && !proSel.value;
    f.querySelectorAll('#newProBox, .np').forEach((el) => el.classList.toggle('hidden', !np));
    if (r === 'funcionario') {
      // Funcionário: só médicos na lista
      [...proSel.options].forEach((o) => { o.hidden = !!o.value && !doctors.some((d) => d.id === o.value); });
    } else [...proSel.options].forEach((o) => { o.hidden = false; });
    void needs;
  };
  roleSel.onchange = sync; proSel.onchange = sync; sync();
  m.el.querySelector('[data-cancel]').onclick = m.close;
  m.el.querySelector('[data-save]').onclick = async () => {
    const data = readForm(f);
    if (!data.professionalId) data.professionalId = null;
    if (u && !data.password) delete data.password;
    if (!u && data.role === 'medico' && !data.professionalId) {
      data.newProfessional = { specialty: f.querySelector('#specialty').value || null, council: f.querySelector('#council').value || null };
    }
    try {
      if (u) await api('PUT', `/api/users/${encodeURIComponent(u.id)}`, data);
      else await api('POST', '/api/users', data);
      m.close(); toast('Acesso salvo.'); notifyChange();
    } catch (e) { showErrors(f, e, f.querySelector('#uErr')); }
  };
}

const ACTIONS = {
  create: 'Criou', update: 'Alterou', status: 'Mudou situação', view: 'Consultou', login: 'Entrou no sistema',
  login_failed: 'Login recusado', signature: 'Registrou assinatura', checklist: 'Checklist', email_test: 'Teste de e-mail',
  payment: 'Registrou pagamento', reverse: 'Estornou pagamento', cancel: 'Cancelou', email: 'Enviou e-mail',
  support_access: 'Acesso do suporte ClinPay',
};
const ENTITIES = {
  patients: 'Paciente', surgeries: 'Cirurgia', signatures: 'Assinatura', users: 'Usuário',
  rooms: 'Sala', professionals: 'Profissional', procedures: 'Procedimento', settings: 'Configuração', emails: 'E-mail',
  charges: 'Financeiro', clinics: 'Clínica',
};

export async function auditPage(page, params) {
  const entity = ENTITIES[params.get('entity')] ? params.get('entity') : '';
  const list = await api('GET', `/api/audit?limit=1000${entity ? `&entity=${entity}` : ''}`);
  page.innerHTML = `
    <div class="page-head">
      <div><button class="btn menu-toggle" id="menuToggle" aria-label="Abrir menu">${ICONS.menu}</button><h1>Auditoria</h1>
      <p class="muted">Registro de quem acessou e alterou dados, com data, hora e IP. Mostrando os 1.000 mais recentes.</p></div>
      <div class="toolbar"><select id="ent" class="btn" aria-label="Filtrar por tipo"><option value="">Todos os registros</option>${options(ENTITIES, entity)}</select></div>
    </div>
    ${list.length ? `<div class="table-wrap"><table class="list"><thead><tr><th>Data e hora</th><th>Usuário</th><th>Ação</th><th>Registro</th><th>Detalhe</th><th>IP</th></tr></thead><tbody>
    ${list.map((a) => `<tr><td>${esc(fmtDateTime(a.at))}</td><td>${esc(a.userName)}</td><td>${esc(ACTIONS[a.action] || a.action)}</td>
      <td>${esc(ENTITIES[a.entity] || a.entity)}</td><td>${esc(a.summary || '')}</td><td class="small">${esc(a.ip)}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="panel empty">Nenhum registro.</div>'}`;
  $('#ent').onchange = (e) => { location.hash = `#/auditoria${e.target.value ? `?entity=${e.target.value}` : ''}`; };
}

export function openPasswordModal() {
  const m = modal({
    title: 'Alterar senha',
    body: `<div class="form" id="pwForm">
      <div class="field s6"><label class="req" for="currentPassword">Senha atual</label><input type="password" name="currentPassword" id="currentPassword" autocomplete="current-password"></div>
      <div class="field s6"><label class="req" for="newPassword">Nova senha</label><input type="password" name="newPassword" id="newPassword" autocomplete="new-password"><span class="hint">Mínimo de 10 caracteres, com letras e números.</span></div>
      <div class="field s6"><label class="req" for="newPassword2">Repita a nova senha</label><input type="password" id="newPassword2" autocomplete="new-password"></div>
      <div class="field s6" id="pwErr"></div></div>`,
    foot: '<button class="btn" data-cancel>Cancelar</button><button class="btn primary" data-save>Alterar senha</button>',
  });
  const f = m.el.querySelector('#pwForm');
  m.el.querySelector('[data-cancel]').onclick = m.close;
  m.el.querySelector('[data-save]').onclick = async () => {
    if (f.querySelector('#newPassword').value !== f.querySelector('#newPassword2').value) {
      f.querySelector('#pwErr').innerHTML = '<div class="alert danger">As senhas não conferem.</div>'; return;
    }
    try {
      await api('PUT', '/api/me/password', readForm(f));
      m.close(); toast('Senha alterada.');
    } catch (e) { showErrors(f, e, f.querySelector('#pwErr')); }
  };
}

// ---------------- E-mails e lembretes ----------------
const STATUS_EMAIL = { pendente: 'Aguardando envio', enviado: 'Enviado', falhou: 'Não enviado' };
const STATUS_CHIP = { pendente: 'em_andamento', enviado: 'concluida', falhou: 'cancelada' };

export async function emailsPage(page, params) {
  const filter = STATUS_EMAIL[params.get('status')] ? params.get('status') : '';
  const [st, list, wa, ai] = await Promise.all([
    api('GET', '/api/settings/email'),
    api('GET', `/api/emails?limit=300${filter ? `&status=${filter}` : ''}`),
    api('GET', '/api/settings/whatsapp'),
    api('GET', '/api/settings/ai'),
  ]);
  page.innerHTML = `
    <div class="page-head">
      <div><button class="btn menu-toggle" id="menuToggle" aria-label="Abrir menu">${ICONS.menu}</button><h1>Integrações</h1>
      <p class="muted">Avisos automáticos de agendamento, alteração, adiamento, cancelamento e lembretes antes da cirurgia.</p></div>
    </div>
    ${st.ready ? '<div class="alert ok">O envio de e-mails está ativado.</div>' : '<div class="alert warn">O envio de e-mails está desativado. Preencha os dados abaixo, envie um e-mail de teste e marque "Ativar o envio".</div>'}
    <div class="grid2">
      <section class="panel">
        <h2 style="margin-bottom:12px">Conta de envio</h2>
        <div class="toolbar" style="margin-bottom:12px"><span class="small muted">Preencher com:</span>
          <button class="btn sm" data-preset="gmail">Gmail</button>
          <button class="btn sm" data-preset="outro">Outro provedor</button></div>
        <div id="presetHelp"></div>
        <div class="form" id="eForm">
          <div class="field"><label for="host">Servidor SMTP</label><input name="host" id="host" value="${esc(st.host)}" placeholder="smtp.gmail.com"></div>
          <div class="field s1"><label class="req" for="port">Porta</label><input type="number" name="port" id="port" value="${esc(st.port)}"></div>
          <div class="field s2"><label class="req" for="security">Segurança</label><select name="security" id="security">${options({ ssl: 'SSL', starttls: 'STARTTLS', none: 'Nenhuma' }, st.security)}</select></div>
          <div class="field"><label for="user">Usuário (normalmente o e-mail)</label><input name="user" id="user" value="${esc(st.user)}" autocomplete="off"></div>
          <div class="field"><label for="pass">Senha ${st.hasPassword ? '(deixe em branco para manter a atual)' : ''}</label><input type="password" name="pass" id="pass" autocomplete="new-password"></div>
          <div class="field"><label class="req" for="fromName">Nome do remetente</label><input name="fromName" id="fromName" value="${esc(st.fromName)}"></div>
          <div class="field"><label for="fromAddr">E-mail remetente</label><input type="email" name="fromAddr" id="fromAddr" value="${esc(st.fromAddr)}"></div>
          <div class="fieldset-title">Dados que aparecem nos e-mails</div>
          <div class="field s4"><label for="clinicAddress">Endereço da clínica</label><input name="clinicAddress" id="clinicAddress" value="${esc(st.clinicAddress)}"></div>
          <div class="field s2"><label for="clinicPhone">Telefone da clínica</label><input name="clinicPhone" id="clinicPhone" value="${esc(st.clinicPhone)}"></div>
          <div class="fieldset-title">Quando enviar</div>
          <div class="field s6"><label for="reminderHours">Lembretes antes da cirurgia (em horas)</label><input name="reminderHours" id="reminderHours" value="${esc(st.reminderHours.join(', '))}">
            <span class="hint">Ex.: "48, 24" envia um lembrete 2 dias antes e outro 1 dia antes. Avisos de agendamento, alteração, adiamento e cancelamento são enviados na hora.</span></div>
          <div class="field s6"><label class="check"><input type="checkbox" name="notifyTeam"${st.notifyTeam ? ' checked' : ''}> Avisar também a equipe (profissionais que autorizaram no cadastro)</label></div>
          <div class="field s6"><label class="check"><input type="checkbox" name="includeProcedureForPatient"${st.includeProcedureForPatient ? ' checked' : ''}> Mostrar o nome do procedimento nos e-mails do paciente</label>
            <span class="hint">Desmarcado por padrão: o e-mail do paciente pode ser lido por outras pessoas. Dado de saúde é sensível pela LGPD.</span></div>
          <div class="field s6"><label class="check"><input type="checkbox" name="enabled"${st.enabled ? ' checked' : ''}> <strong>Ativar o envio de e-mails</strong></label></div>
          <div class="field s6" id="eErr"></div>
          <div class="field s6"><div class="toolbar"><button class="btn primary" id="saveE">Salvar configuração</button></div></div>
        </div>
      </section>
      <section class="panel">
        <h2 style="margin-bottom:12px">Testar o envio</h2>
        <p class="muted small">Salve a configuração antes de testar.</p>
        <div class="form" id="tForm">
          <div class="field s4"><label for="testTo">Enviar um e-mail de teste para</label><input type="email" name="to" id="testTo" value="${esc(state.me.email)}"></div>
          <div class="field s2"><label>&nbsp;</label><button class="btn" id="testBtn">Enviar teste</button></div>
          <div class="field s6" id="tOut"></div>
        </div>
        <h3 style="margin:18px 0 8px">Quem recebe</h3>
        <p class="small">Pacientes com e-mail cadastrado e a opção de autorização marcada no cadastro. Profissionais da equipe da cirurgia com e-mail e a opção "Receber por e-mail" marcada em Salas e equipe.</p>
        <p class="small">Se um envio falhar (internet fora, senha errada), o sistema tenta de novo até 5 vezes. O servidor precisa estar ligado para os lembretes saírem no horário.</p>
      </section>
    </div>
    <section class="panel">
      <h2 style="margin-bottom:6px">WhatsApp (lembretes automáticos)</h2>
      ${wa.ready ? '<div class="alert ok">Lembretes pelo WhatsApp ativados.</div>' : ''}
      <p class="small">Usa a <strong>API oficial do WhatsApp Business (Meta)</strong>. Você precisa de: uma conta Meta Business verificada, um número ligado à API, um token de acesso permanente e um <strong>modelo de mensagem aprovado</strong> (categoria Utilidade) com 5 variáveis, por exemplo:</p>
      <pre class="doc-text" style="max-height:none">Olá, {{1}}! Lembramos do seu atendimento em {{2}} às {{3}} na {{4}}. Para confirmar ou cancelar, acesse: {{5}}</pre>
      <p class="small muted">Sem isso configurado, use o botão "Lembrete por WhatsApp" em cada consulta: ele abre o WhatsApp com a mensagem pronta para enviar manualmente.</p>
      <div class="form" id="waForm">
        <div class="field s2"><label for="phoneNumberId">ID do número de telefone</label><input name="phoneNumberId" id="phoneNumberId" value="${esc(wa.phoneNumberId)}" inputmode="numeric"></div>
        <div class="field s2"><label for="waToken">Token de acesso ${wa.hasToken ? '(em branco mantém o atual)' : ''}</label><input type="password" id="waToken" autocomplete="off"></div>
        <div class="field s1"><label for="templateName">Nome do modelo</label><input name="templateName" id="templateName" value="${esc(wa.templateName)}" placeholder="lembrete_consulta"></div>
        <div class="field s1"><label for="languageCode">Idioma</label><input name="languageCode" id="languageCode" value="${esc(wa.languageCode || 'pt_BR')}"></div>
        <div class="field s6"><label class="check"><input type="checkbox" name="enabled"${wa.enabled ? ' checked' : ''}> <strong>Ativar lembretes pelo WhatsApp</strong> (para pacientes que autorizaram no cadastro)</label></div>
        <div class="field s6" id="waErr"></div>
        <div class="field s6"><div class="toolbar"><button class="btn primary" id="saveWa">Salvar WhatsApp</button></div></div>
      </div>
    </section>
    <section class="panel">
      <h2 style="margin-bottom:6px">✦ Assistente de IA</h2>
      ${ai.available ? `
      <p class="small">O assistente ajuda a equipe a analisar indicadores, escrever mensagens para pacientes e tirar dúvidas sobre o sistema. Ele usa o Claude, da Anthropic. Cada pergunta conta para o limite diário da clínica. Hoje: <strong>${ai.usedToday}</strong> de ${ai.dailyLimit}.</p>
      <div class="form" id="aiForm">
        <div class="field s6"><label class="check"><input type="checkbox" name="enabled"${ai.enabled ? ' checked' : ''}> <strong>Ativar o assistente de IA para a equipe</strong></label></div>
        <div class="field s2"><label for="dailyLimit">Limite de perguntas por dia</label><input type="number" name="dailyLimit" id="dailyLimit" min="1" max="5000" value="${esc(ai.dailyLimit)}"></div>
        <div class="field s6"><label class="check"><input type="checkbox" name="allowPatientData" id="allowPd"${ai.allowPatientData ? ' checked' : ''}> Permitir que médicos e enfermagem enviem dados do prontuário à IA (para resumos)</label>
          <span class="hint">Mesmo autorizado, o sistema nunca envia nome, CPF, telefone, e-mail ou endereço. Só idade, sexo, alergias, medicamentos, evoluções, exames e odontograma.</span></div>
        <div class="field s6 ${ai.allowPatientData ? 'hidden' : ''}" id="termsBox"><div class="alert warn" style="margin:0"><label class="check"><input type="checkbox" id="aiTerms"> Declaro que a clínica tem base legal (LGPD) para compartilhar dados de saúde com um serviço de IA externo, e que a equipe revisará as respostas antes de qualquer uso clínico.</label></div></div>
        <div class="field s6" id="aiErr"></div>
        <div class="field s6"><div class="toolbar"><button class="btn primary" id="saveAi">Salvar assistente</button></div></div>
      </div>` : '<div class="alert info">O assistente de IA ainda não foi liberado nesta plataforma. Fale com o suporte ClinPay.</div>'}
    </section>
    <section class="panel">
      <div class="page-head" style="margin-bottom:10px"><h2>Histórico de envios</h2>
        <select id="stFilter" class="btn" aria-label="Filtrar por situação"><option value="">Todos</option>${options(STATUS_EMAIL, filter)}</select></div>
      ${list.length ? `<div class="table-wrap"><table class="list"><thead><tr><th>Criado em</th><th>Tipo</th><th>Para</th><th>Canal / assunto</th><th>Situação</th><th></th></tr></thead><tbody>
      ${list.map((e) => `<tr><td>${esc(fmtDateTime(e.createdAt))}</td><td>${esc(e.kindLabel)}</td>
        <td>${esc(e.toName || '')}<br><span class="muted small">${esc(e.to)} (${esc(e.audience)})</span></td><td>${esc(e.subject)}</td>
        <td><span class="chip ${STATUS_CHIP[e.status]}">${esc(STATUS_EMAIL[e.status])}</span>${e.status === 'enviado' ? `<br><span class="small muted">${esc(fmtDateTime(e.sentAt))}</span>` : ''}${e.lastError ? `<br><span class="small" style="color:var(--danger)">${esc(e.lastError)}</span>` : ''}</td>
        <td>${e.status !== 'enviado' ? `<button class="btn sm" data-retry="${esc(e.id)}">Tentar de novo</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="empty">Nenhum e-mail no histórico.</p>'}
    </section>`;

  const f = $('#eForm');
  const help = {
    gmail: `<div class="alert info small"><strong>Gmail:</strong> use uma <strong>senha de app</strong>, não a senha normal da conta.
      Ative a verificação em duas etapas na conta Google e crie a senha de app em myaccount.google.com/apppasswords.
      Contas Gmail gratuitas enviam no máximo cerca de 500 e-mails por dia.</div>`,
    outro: `<div class="alert info small">Use os dados de SMTP informados pelo seu provedor de e-mail (por exemplo, a hospedagem do domínio da clínica).
      Normalmente a porta 465 usa SSL e a porta 587 usa STARTTLS.</div>`,
  };
  page.querySelectorAll('[data-preset]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.preset === 'gmail') {
        f.querySelector('#host').value = 'smtp.gmail.com'; f.querySelector('#port').value = 465; f.querySelector('#security').value = 'ssl';
        if (!f.querySelector('#fromAddr').value && f.querySelector('#user').value) f.querySelector('#fromAddr').value = f.querySelector('#user').value;
      }
      $('#presetHelp').innerHTML = help[b.dataset.preset];
    };
  });
  f.querySelector('#user').addEventListener('change', (e) => { if (!f.querySelector('#fromAddr').value) f.querySelector('#fromAddr').value = e.target.value; });
  $('#saveE').onclick = async () => {
    const data = readForm(f);
    if (!data.pass) delete data.pass;
    try {
      await api('PUT', '/api/settings/email', data);
      toast('Configuração de e-mail salva.'); notifyChange();
    } catch (e) { showErrors(f, e, $('#eErr')); }
  };
  $('#testBtn').onclick = async () => {
    const out = $('#tOut'); const b = $('#testBtn');
    b.disabled = true; out.innerHTML = '<p class="muted small">Enviando…</p>';
    try {
      await api('POST', '/api/settings/email/test', { to: $('#testTo').value });
      out.innerHTML = '<div class="alert ok">E-mail de teste enviado. Confira a caixa de entrada (e a de spam).</div>';
    } catch (e) { out.innerHTML = `<div class="alert danger">${esc(e.message)}</div>`; } finally { b.disabled = false; }
  };
  const sai = $('#saveAi');
  if (sai) sai.onclick = async () => {
    const af = $('#aiForm'); const d = readForm(af);
    d.dailyLimit = Number(d.dailyLimit) || 200;
    d.acceptPatientDataTerms = !!($('#aiTerms') && $('#aiTerms').checked);
    try { await api('PUT', '/api/settings/ai', d); toast('Assistente salvo. Recarregue a página para ver o botão do assistente.'); notifyChange(); } catch (e) { showErrors(af, e, $('#aiErr')); }
  };
  $('#saveWa').onclick = async () => {
    const wf = $('#waForm'); const d = readForm(wf);
    const tok = $('#waToken').value.trim(); if (tok) d.token = tok;
    try { await api('PUT', '/api/settings/whatsapp', d); toast('WhatsApp salvo.'); notifyChange(); } catch (e) { showErrors(wf, e, $('#waErr')); }
  };
  $('#stFilter').onchange = (e) => { location.hash = `#/emails${e.target.value ? `?status=${e.target.value}` : ''}`; };
  page.querySelectorAll('[data-retry]').forEach((b) => {
    b.onclick = async () => {
      try { await api('POST', `/api/emails/${encodeURIComponent(b.dataset.retry)}/retry`); toast('Reenvio solicitado.'); setTimeout(notifyChange, 1500); } catch (e) { toast(e.message, 'error'); }
    };
  });
}

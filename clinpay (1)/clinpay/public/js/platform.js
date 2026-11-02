// Painel da plataforma ClinPay: clínicas parceiras, administradores e auditoria
import { api, esc, fmtDateTime, toast, $, modal, showErrors, readForm, ICONS, fmtMoney, confirmDialog } from './core.js';

const fmtCnpj = (c) => (c && c.length === 14 ? `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}` : c || '');

export async function enterClinic(id) {
  await api('POST', '/api/platform/enter', { clinicId: id });
  location.hash = '#/painel';
  location.reload();
}

export async function leaveClinic() {
  await api('POST', '/api/platform/leave');
  location.hash = '#/p/clinicas';
  location.reload();
}

export async function clinicsPage(page) {
  const list = await api('GET', '/api/platform/clinics');
  const active = list.filter((c) => c.status === 'ativa');
  const total = list.reduce((s, c) => s + c.stats.receivedMonthCents, 0);
  page.innerHTML = `
    <div class="page-head">
      <div><button class="btn menu-toggle" id="menuToggle" aria-label="Abrir menu">${ICONS.menu}</button><h1>Clínicas parceiras</h1>
      <p class="muted">Cada clínica tem a própria agenda, pacientes e financeiro, separados das demais.</p></div>
      <div class="toolbar"><button class="btn primary" id="newClinic">Cadastrar clínica</button></div>
    </div>
    <div class="stats">
      <div class="stat"><b>${active.length}</b><span>clínicas ativas</span></div>
      <div class="stat"><b>${list.length - active.length}</b><span>suspensas</span></div>
      <div class="stat"><b>${list.reduce((s, c) => s + c.stats.users, 0)}</b><span>acessos ativos</span></div>
      <div class="stat"><b>${esc(fmtMoney(total))}</b><span>recebido pelas clínicas no mês</span></div>
    </div>
    ${list.length ? `<div class="table-wrap"><table class="list"><thead><tr><th>Clínica</th><th>Acessos</th><th>Pacientes</th><th>Próximos atendimentos</th><th>Recebido no mês</th><th>Situação</th><th></th></tr></thead><tbody>
      ${list.map((c) => `<tr>
        <td><span class="color-dot" data-color="${esc(c.color || '')}"></span><strong>${esc(c.name)}</strong><br><span class="muted small">${esc([c.city, fmtCnpj(c.cnpj)].filter(Boolean).join(' · '))}</span></td>
        <td>${c.stats.users}</td><td>${c.stats.patients}</td><td>${c.stats.upcoming}</td><td>${esc(fmtMoney(c.stats.receivedMonthCents))}</td>
        <td>${c.status === 'ativa' ? '<span class="chip concluida">Ativa</span>' : '<span class="chip cancelada">Suspensa</span>'}</td>
        <td><div class="toolbar"><button class="btn sm primary" data-enter="${esc(c.id)}">Entrar</button><button class="btn sm" data-edit="${esc(c.id)}">Editar</button></div></td>
      </tr>`).join('')}</tbody></table></div>`
      : `<div class="panel empty"><h2>Nenhuma clínica cadastrada</h2><p>Cadastre a primeira clínica parceira e o médico responsável por ela.</p>
         <button class="btn primary" id="newClinic2">Cadastrar clínica</button></div>`}
    <p class="muted small" style="margin-top:12px">Ao entrar em uma clínica, você vê o sistema como o médico responsável. Sua entrada e tudo o que você fizer ficam registrados na auditoria da clínica, identificados como ClinPay.</p>`;
  page.querySelectorAll('[data-color]').forEach((el) => { if (/^#[0-9a-fA-F]{6}$/.test(el.dataset.color)) el.style.background = el.dataset.color; else el.remove(); });
  [$('#newClinic'), $('#newClinic2')].filter(Boolean).forEach((b) => { b.onclick = () => openClinicForm(null, () => clinicsPage(page)); });
  page.querySelectorAll('[data-enter]').forEach((b) => { b.onclick = () => enterClinic(b.dataset.enter).catch((e) => toast(e.message, 'error')); });
  page.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => openClinicForm(list.find((c) => c.id === b.dataset.edit), () => clinicsPage(page)); });
}

function openClinicForm(c, onDone) {
  const v = c || { color: '#1565D8' };
  const m = modal({
    title: c ? `Editar ${c.name}` : 'Cadastrar clínica parceira',
    wide: true,
    body: `<div class="form" id="clForm">
      <div class="fieldset-title" style="border:0;padding-top:0;margin-top:0">Dados da clínica</div>
      <div class="field s4"><label class="req" for="name">Nome da clínica</label><input name="name" id="name" value="${esc(v.name || '')}"></div>
      <div class="field s2"><label for="cnpj">CNPJ</label><input name="cnpj" id="cnpj" value="${esc(fmtCnpj(v.cnpj))}" placeholder="00.000.000/0000-00"></div>
      <div class="field s2"><label for="phone">Telefone</label><input name="phone" id="phone" value="${esc(v.phone || '')}"></div>
      <div class="field s2"><label for="email">E-mail da clínica</label><input type="email" name="email" id="email" value="${esc(v.email || '')}"></div>
      <div class="field s1"><label for="city">Cidade</label><input name="city" id="city" value="${esc(v.city || '')}"></div>
      <div class="field s1"><label for="color">Cor</label><input type="color" name="color" id="color" value="${esc(v.color || '#1565D8')}"></div>
      <div class="field s6"><label for="notes">Observações internas (só a ClinPay vê)</label><textarea name="notes" id="notes">${esc(v.notes || '')}</textarea></div>
      ${c ? `<div class="field s6"><label class="check"><input type="checkbox" id="active"${c.status === 'ativa' ? ' checked' : ''}> Clínica ativa (desmarque para suspender o acesso de todos os usuários dela)</label></div>` : `
      <div class="fieldset-title">Médico responsável (acesso total à clínica)</div>
      <div class="field s3"><label class="req" for="oname">Nome completo</label><input id="oname" name="owner.name"></div>
      <div class="field s3"><label class="req" for="oemail">E-mail de acesso</label><input type="email" id="oemail" name="owner.email" autocomplete="off"></div>
      <div class="field s2"><label for="ocouncil">CRM</label><input id="ocouncil" name="owner.council"></div>
      <div class="field s2"><label for="ospec">Especialidade</label><input id="ospec" name="owner.specialty"></div>
      <div class="field s2"><label class="req" for="opass">Senha inicial</label><input type="password" id="opass" name="owner.password" autocomplete="new-password">
        <span class="hint">Mín. 10 caracteres, letras e números.</span></div>`}
      <div class="field s6" id="clErr"></div></div>`,
    foot: `<button class="btn" data-cancel>Cancelar</button><button class="btn primary" data-save>${c ? 'Salvar' : 'Cadastrar clínica'}</button>`,
  });
  const f = m.el.querySelector('#clForm');
  m.el.querySelector('[data-cancel]').onclick = m.close;
  m.el.querySelector('[data-save]').onclick = async () => {
    const d = readForm(f);
    const payload = { name: d.name, cnpj: d.cnpj, phone: d.phone, email: d.email, city: d.city, color: d.color, notes: d.notes };
    try {
      if (c) {
        const active = f.querySelector('#active').checked;
        if (!active && c.status === 'ativa' && !(await confirmDialog(`Suspender ${c.name}? Todos os usuários da clínica perdem o acesso imediatamente. Os dados ficam guardados.`, { okLabel: 'Suspender', danger: true }))) return;
        payload.status = active ? 'ativa' : 'suspensa';
        await api('PUT', `/api/platform/clinics/${encodeURIComponent(c.id)}`, payload);
      } else {
        payload.owner = { name: d['owner.name'], email: d['owner.email'], council: d['owner.council'], specialty: d['owner.specialty'], password: d['owner.password'] };
        await api('POST', '/api/platform/clinics', payload);
      }
      m.close(); toast(c ? 'Clínica atualizada.' : 'Clínica cadastrada. Envie ao médico responsável o e-mail e a senha de acesso.');
      onDone();
    } catch (e) { showErrors(f, e, f.querySelector('#clErr')); }
  };
}

export async function adminsPage(page) {
  const list = await api('GET', '/api/platform/admins');
  page.innerHTML = `
    <div class="page-head">
      <div><button class="btn menu-toggle" id="menuToggle" aria-label="Abrir menu">${ICONS.menu}</button><h1>Administradores ClinPay</h1>
      <p class="muted">Acessos da sua equipe à plataforma. Eles veem e podem entrar em todas as clínicas parceiras.</p></div>
      <div class="toolbar"><button class="btn primary" id="newAdmin">Cadastrar administrador</button></div>
    </div>
    <div class="table-wrap"><table class="list"><thead><tr><th>Nome</th><th>E-mail</th><th>Situação</th><th></th></tr></thead><tbody>
    ${list.map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.email)}</td><td>${a.active ? '<span class="chip concluida">Ativo</span>' : '<span class="chip">Inativo</span>'}</td>
      <td><div class="toolbar"><button class="btn sm" data-toggle="${esc(a.id)}">${a.active ? 'Desativar' : 'Reativar'}</button><button class="btn sm" data-pass="${esc(a.id)}">Nova senha</button></div></td></tr>`).join('')}
    </tbody></table></div>
    <div class="alert warn" style="margin-top:16px">Administradores ClinPay acessam dados de saúde de todas as clínicas. Cadastre apenas pessoas da sua equipe que precisam dar suporte, e formalize isso no contrato com as clínicas (LGPD: a ClinPay atua como operadora dos dados).</div>`;
  $('#newAdmin').onclick = () => {
    const m = modal({
      title: 'Cadastrar administrador ClinPay',
      body: `<div class="form" id="aForm">
        <div class="field s3"><label class="req" for="name">Nome</label><input name="name" id="name"></div>
        <div class="field s3"><label class="req" for="email">E-mail</label><input type="email" name="email" id="email" autocomplete="off"></div>
        <div class="field s6"><label class="req" for="password">Senha inicial</label><input type="password" name="password" id="password" autocomplete="new-password"><span class="hint">Mín. 10 caracteres, letras e números.</span></div>
        <div class="field s6" id="aErr"></div></div>`,
      foot: '<button class="btn" data-cancel>Cancelar</button><button class="btn primary" data-save>Cadastrar</button>',
    });
    const f = m.el.querySelector('#aForm');
    m.el.querySelector('[data-cancel]').onclick = m.close;
    m.el.querySelector('[data-save]').onclick = async () => {
      try { await api('POST', '/api/platform/admins', readForm(f)); m.close(); toast('Administrador cadastrado.'); adminsPage(page); } catch (e) { showErrors(f, e, f.querySelector('#aErr')); }
    };
  };
  page.querySelectorAll('[data-toggle]').forEach((b) => {
    b.onclick = async () => {
      const a = list.find((x) => x.id === b.dataset.toggle);
      try { await api('PUT', `/api/platform/admins/${encodeURIComponent(a.id)}`, { active: !a.active }); toast('Atualizado.'); adminsPage(page); } catch (e) { toast(e.message, 'error'); }
    };
  });
  page.querySelectorAll('[data-pass]').forEach((b) => {
    b.onclick = () => {
      const m = modal({
        title: 'Definir nova senha',
        body: '<div class="form" id="pForm"><div class="field s6"><label class="req" for="password">Nova senha</label><input type="password" name="password" id="password" autocomplete="new-password"></div><div class="field s6" id="pErr"></div></div>',
        foot: '<button class="btn" data-cancel>Cancelar</button><button class="btn primary" data-save>Salvar</button>',
      });
      const f = m.el.querySelector('#pForm');
      m.el.querySelector('[data-cancel]').onclick = m.close;
      m.el.querySelector('[data-save]').onclick = async () => {
        try { await api('PUT', `/api/platform/admins/${encodeURIComponent(b.dataset.pass)}`, readForm(f)); m.close(); toast('Senha alterada.'); } catch (e) { showErrors(f, e, f.querySelector('#pErr')); }
      };
    };
  });
}

export async function platformAuditPage(page) {
  const list = await api('GET', '/api/platform/audit');
  page.innerHTML = `
    <div class="page-head"><div><button class="btn menu-toggle" id="menuToggle" aria-label="Abrir menu">${ICONS.menu}</button><h1>Auditoria da plataforma</h1>
      <p class="muted">Ações no painel ClinPay e tentativas de login não associadas a uma clínica. Ações dentro de cada clínica ficam na auditoria da própria clínica.</p></div></div>
    ${list.length ? `<div class="table-wrap"><table class="list"><thead><tr><th>Data e hora</th><th>Usuário</th><th>Ação</th><th>Detalhe</th><th>IP</th></tr></thead><tbody>
    ${list.map((a) => `<tr><td>${esc(fmtDateTime(a.at))}</td><td>${esc(a.userName)}</td><td>${esc(a.action)}</td><td>${esc(a.summary || '')}</td><td class="small">${esc(a.ip)}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="panel empty">Nenhum registro.</div>'}`;
}

// ClinPay — interface da plataforma e das clínicas (sem dependências externas)
import { agendaPage, openSurgeryForm, openSurgeryDetail } from './js/surgeries.js';
import { patientsPage, patientDetailPage } from './js/patients.js';
import { signaturesPage } from './js/signatures.js';
import { catalogPage, usersPage, auditPage, openPasswordModal, emailsPage } from './js/admin.js';
import { api, state, esc, fmtDate, todayStr, addDays, toast, $, setPageHandler, ICONS, fmtMoney, myPro, can } from './js/core.js';
import { financePage } from './js/finance.js';
import { drePage } from './js/dre.js';
import { clinicsPage, adminsPage, platformAuditPage, leaveClinic } from './js/platform.js';
import { analyticsPage } from './js/dashboard.js';
import { crmPage } from './js/crm.js';
import { portalPage } from './js/portal.js';
import { loadAi } from './js/assistant.js';

// ---------- Tema claro/escuro ----------
const currentTheme = () => document.documentElement.getAttribute('data-theme') || 'light';
function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('clinpay-theme', next); } catch { /* sem armazenamento: vale só nesta visita */ }
  document.querySelectorAll('[data-theme-label]').forEach((el) => { el.textContent = themeLabel(); });
}
const themeLabel = () => (currentTheme() === 'dark' ? '☀ Modo claro' : '☾ Modo escuro');
document.addEventListener('click', (e) => { if (e.target.closest('[data-theme-toggle]')) toggleTheme(); });

const root = document.getElementById('root');

async function boot() {
  try {
    const setup = await api('GET', '/api/setup');
    state.clinicName = setup.clinicName;
    if (setup.needsSetup) return renderSetup();
    const me = await api('GET', '/api/me').catch(() => null);
    if (!me) return renderLogin();
    await startSession(me);
  } catch (e) {
    root.innerHTML = `<div class="empty"><h2>Não foi possível conectar ao servidor</h2><p>${esc(e.message)}</p>
      <button class="btn primary" id="retry">Tentar de novo</button></div>`;
    $('#retry').onclick = boot;
  }
}

async function startSession(me) {
  state.me = me.user;
  state.perms = new Set(me.permissions);
  state.platform = me.platform;
  state.clinic = me.clinic;
  state.meta = await api('GET', '/api/meta');
  // Administrador ClinPay fora de uma clínica: painel da plataforma. Paciente: portal.
  state.mode = me.platform && !me.clinic ? 'platform' : me.user.role === 'paciente' ? 'portal' : 'clinic';
  if (state.mode === 'portal' && !location.hash.startsWith('#/portal')) location.hash = '#/portal';
  if (state.mode === 'platform' && !location.hash.startsWith('#/p/')) location.hash = '#/p/clinicas';
  if (state.mode === 'clinic' && location.hash.startsWith('#/p/')) location.hash = '#/painel';
  renderLayout();
  window.addEventListener('hashchange', route);
  route();
  if (state.mode === 'clinic') loadAi();
}

// Quando a sessão expira em qualquer chamada, volta ao login
window.addEventListener('session-expired', () => {
  state.me = null;
  window.removeEventListener('hashchange', route);
  renderLogin('Sua sessão expirou. Entre novamente.');
});

function loginShell(inner) {
  root.innerHTML = `
  <div class="login-page">
    <section class="login-art">
      <div></div>
      <div>
        <h1>Agenda, pacientes e financeiro da clínica em um só lugar.</h1>
        <p>Consultas e cirurgias, lembretes por e-mail, termos assinados e o controle do que cada médico recebe.</p>
      </div>
      <svg class="cross" viewBox="0 0 100 100" aria-hidden="true"><rect x="36" y="0" width="28" height="100" rx="6" fill="#12A4DC"/><rect x="0" y="36" width="100" height="28" rx="6" fill="#12A4DC"/></svg>
      <p class="small">${esc(state.clinicName || '')}</p>
    </section>
    <section class="login-form"><button class="btn sm login-theme" data-theme-toggle data-theme-label>${esc(themeLabel())}</button>
      <div class="box"><img src="/logo.svg" alt="ClinPay" class="logo-on-light"><img src="/logo-white.svg" alt="ClinPay" class="logo-on-dark">${inner}</div></section>
  </div>`;
}

function renderLogin(message) {
  loginShell(`
    <h2>Entrar</h2>
    <p class="muted">Use o e-mail e a senha recebidos da clínica.</p>
    ${message ? `<div class="alert warn">${esc(message)}</div>` : ''}
    <form id="loginForm" class="form" novalidate>
      <div class="field"><label for="email">E-mail</label><input id="email" name="email" type="email" autocomplete="username" required></div>
      <div class="field"><label for="password">Senha</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
      <div id="loginErr"></div>
      <button class="btn primary" type="submit">Entrar</button>
    </form>`);
  $('#email').focus();
  $('#loginForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = ev.target.querySelector('button'); btn.disabled = true;
    try {
      await api('POST', '/api/login', { email: $('#email').value, password: $('#password').value });
      await startSession(await api('GET', '/api/me'));
    } catch (e) {
      $('#loginErr').innerHTML = `<div class="alert danger">${esc(e.message)}</div>`;
      btn.disabled = false;
    }
  };
}

function renderSetup() {
  loginShell(`
    <h2>Primeiro acesso</h2>
    <p class="muted">Crie a sua conta de administrador ClinPay. Depois, cadastre as clínicas parceiras e o médico responsável de cada uma.</p>
    <form id="setupForm" class="form" novalidate>
      <div class="field"><label class="req" for="name">Nome completo</label><input id="name" name="name" required></div>
      <div class="field"><label class="req" for="email">E-mail</label><input id="email" name="email" type="email" autocomplete="username" required></div>
      <div class="field"><label class="req" for="password">Senha</label><input id="password" name="password" type="password" autocomplete="new-password" required>
        <span class="hint">Mínimo de 10 caracteres, com letras e números.</span></div>
      <div class="field"><label class="req" for="password2">Repita a senha</label><input id="password2" type="password" autocomplete="new-password" required></div>
      <div id="setupErr"></div>
      <button class="btn primary" type="submit">Criar administrador ClinPay</button>
    </form>`);
  $('#setupForm').onsubmit = async (ev) => {
    ev.preventDefault();
    if ($('#password').value !== $('#password2').value) {
      $('#setupErr').innerHTML = '<div class="alert danger">As senhas não conferem.</div>'; return;
    }
    try {
      await api('POST', '/api/setup', { name: $('#name').value, email: $('#email').value, password: $('#password').value });
      await startSession(await api('GET', '/api/me'));
    } catch (e) {
      $('#setupErr').innerHTML = `<div class="alert danger">${esc(e.message)}${e.fields ? '<ul>' + Object.values(e.fields).map((m) => `<li>${esc(m)}</li>`).join('') + '</ul>' : ''}</div>`;
    }
  };
}

const NAV = [
  { href: '#/painel', label: 'Painel do dia', icon: 'home' },
  { href: '#/agenda', label: 'Agenda', icon: 'calendar' },
  { href: '#/pacientes', label: 'Pacientes', icon: 'users', perm: 'patients:read' },
  { href: '#/financeiro', label: 'Financeiro', icon: 'money', perm: 'finance:read' },
  { href: '#/dre', label: 'DRE gerencial', icon: 'list', perm: 'finance:read' },
  { href: '#/indicadores', label: 'Indicadores', icon: 'chart', perm: 'analytics:read' },
  { href: '#/crm', label: 'CRM e vendas', icon: 'funnel', perm: 'crm:read' },
  { href: '#/assinaturas', label: 'Termos assinados', icon: 'pen', perm: 'signatures:read' },
  { sep: 'Administração', perm: 'catalog:manage' },
  { href: '#/cadastros', label: 'Salas e equipe', icon: 'grid', perm: 'catalog:manage' },
  { href: '#/usuarios', label: 'Médicos e acessos', icon: 'key', perm: 'users:manage' },
  { href: '#/emails', label: 'Integrações', icon: 'mail', perm: 'settings:manage' },
  { href: '#/auditoria', label: 'Auditoria', icon: 'list', perm: 'audit:read' },
];

const PLATFORM_NAV = [
  { href: '#/p/clinicas', label: 'Clínicas parceiras', icon: 'grid' },
  { href: '#/p/admins', label: 'Administradores ClinPay', icon: 'key' },
  { href: '#/p/auditoria', label: 'Auditoria da plataforma', icon: 'list' },
];

const PORTAL_NAV = [
  { href: '#/portal', label: 'Meus exames', icon: 'list' },
  { href: '#/portal/consultas', label: 'Minhas consultas', icon: 'calendar' },
];

function renderLayout() {
  const navItems = state.mode === 'platform' ? PLATFORM_NAV : state.mode === 'portal' ? PORTAL_NAV : NAV;
  const nav = navItems.filter((n) => !n.perm || state.perms.has(n.perm)).map((n) => n.sep
    ? `<div class="sep">${esc(n.sep)}</div>`
    : `<a href="${n.href}" data-nav>${ICONS[n.icon]}<span>${esc(n.label)}</span></a>`).join('');
  root.innerHTML = `
  <div class="app">
    <aside class="sidebar" id="sidebar">
      <div class="brand"><img src="/logo-white.svg" alt="ClinPay"></div>
      <div class="clinic" id="clinicTag">${state.mode === 'platform' ? '<strong>Painel da plataforma</strong>' : `<strong>${esc(state.clinic ? state.clinic.name : state.meta.clinicName)}</strong>`}</div>
      <nav class="nav">${nav}</nav>
      <div class="userbox">
        <strong>${esc(state.me.name)}</strong><span class="muted">${esc(state.me.roleLabel)}</span>
        <div class="links"><button id="pwBtn">Alterar senha</button><button id="logoutBtn">Sair</button></div>
        <div class="links"><button data-theme-toggle data-theme-label>${esc(themeLabel())}</button></div>
      </div>
    </aside>
    <main class="main">
      ${state.mode === 'clinic' && state.platform ? `<div class="alert warn no-print support-bar"><span>Você está na clínica <strong>${esc(state.clinic.name)}</strong> como administrador ClinPay. Suas ações ficam registradas na auditoria da clínica.</span>
        <button class="btn sm" id="leaveBtn">Voltar ao painel ClinPay</button></div>` : ''}
      <div id="page"></div>
    </main>
  </div>`;
  const lb = $('#leaveBtn'); if (lb) lb.onclick = () => leaveClinic().catch((e) => toast(e.message, 'error'));
  const tag = $('#clinicTag');
  if (state.mode === 'clinic' && state.clinic && /^#[0-9a-fA-F]{6}$/.test(state.clinic.color || '')) tag.style.borderLeft = `4px solid ${state.clinic.color}`;
  $('#logoutBtn').onclick = async () => { await api('POST', '/api/logout').catch(() => {}); location.hash = ''; location.reload(); };
  $('#pwBtn').onclick = openPasswordModal;
  root.addEventListener('click', (e) => {
    if (e.target.closest('#menuToggle')) $('#sidebar').classList.toggle('open');
    else if (e.target.closest('[data-nav]')) $('#sidebar').classList.remove('open');
  });
}

function route() {
  if (!state.me) return;
  const hash = location.hash || '#/painel';
  const [path, qs] = hash.slice(1).split('?');
  const params = new URLSearchParams(qs || '');
  const parts = path.split('/').filter(Boolean);
  document.querySelectorAll('[data-nav]').forEach((a) => {
    a.classList.toggle('active', hash.startsWith(a.getAttribute('href')) ||
      (a.getAttribute('href') === '#/pacientes' && parts[0] === 'paciente'));
  });
  const page = $('#page');
  setPageHandler(null);
  if (state.mode === 'portal') {
    Promise.resolve(portalPage(page, parts[1] || 'exames')).catch((e) => { if (e.status !== 401) page.innerHTML = `<div class="alert danger">Erro ao carregar: ${esc(e.message)}</div>`; });
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === (parts[1] ? '#/portal/consultas' : '#/portal')));
    return;
  }
  if (state.mode === 'platform') {
    const p = { clinicas: clinicsPage, admins: adminsPage, auditoria: platformAuditPage }[parts[1]];
    if (parts[0] !== 'p' || !p) { location.hash = '#/p/clinicas'; return; }
    Promise.resolve(p(page)).catch((e) => { if (e.status !== 401) page.innerHTML = `<div class="alert danger">Erro ao carregar: ${esc(e.message)}</div>`; });
    return;
  }
  const go = {
    painel: () => dashboardPage(page),
    agenda: () => agendaPage(page, params),
    pacientes: () => patientsPage(page, params),
    paciente: () => patientDetailPage(page, parts[1], params),
    assinaturas: () => signaturesPage(page, params),
    cadastros: () => catalogPage(page, params),
    usuarios: () => usersPage(page),
    auditoria: () => auditPage(page, params),
    financeiro: () => financePage(page, params),
    dre: () => drePage(page, params),
    indicadores: () => analyticsPage(page, params),
    crm: () => crmPage(page, params),
    emails: () => emailsPage(page, params),
  }[parts[0]] || (() => { location.hash = '#/painel'; });
  Promise.resolve(go()).catch((e) => {
    if (e.status === 401) return;
    page.innerHTML = `<div class="alert danger">Erro ao carregar a página: ${esc(e.message)}</div>`;
  });
}
window.addEventListener('data-changed', () => route());

// ---------------- Painel do dia ----------------
async function dashboardPage(page) {
  const today = todayStr();
  const pro = myPro();
  const [surgeries, rooms, pros, fin] = await Promise.all([
    api('GET', `/api/surgeries?from=${today}&to=${addDays(today, 7)}${pro ? `&professionalId=${pro}` : ''}`),
    api('GET', '/api/rooms'), api('GET', '/api/professionals'),
    can('finance:read') ? api('GET', `/api/finance/summary?from=${today}&to=${today}`) : Promise.resolve(null),
  ]);
  const todays = surgeries.filter((s) => s.date === today && !['cancelada', 'faltou'].includes(s.status));
  const running = surgeries.filter((s) => s.status === 'em_andamento');
  const pending = surgeries.filter((s) => ['agendada', 'confirmada'].includes(s.status) && s.missingDocs.length);
  const needSetup = !pros.some((p) => p.active);
  const canWrite = can('surgeries:write');

  const dt = new Date(today + 'T12:00:00');
  const longDate = dt.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  page.innerHTML = `
    <div class="page-head">
      <div><button class="btn menu-toggle" id="menuToggle" aria-label="Abrir menu">${ICONS.menu}</button>
      <h1>${pro ? `Olá, ${esc(state.me.name.split(' ')[0])}` : 'Painel do dia'}</h1><p class="muted">${esc(longDate.charAt(0).toUpperCase() + longDate.slice(1))}</p></div>
      <div class="toolbar">${canWrite && !needSetup ? '<button class="btn primary" id="newSx">Agendar consulta</button>' : ''}</div>
    </div>
    ${needSetup ? setupGuide(rooms.some((r) => r.active), false) : ''}
    <div class="stats">
      <div class="stat"><b>${todays.length}</b><span>atendimentos hoje</span></div>
      <div class="stat"><b>${running.length}</b><span>em atendimento agora</span></div>
      ${fin ? `<div class="stat"><b>${esc(fmtMoney(fin.receivedCents))}</b><span>recebido hoje</span></div>
      <div class="stat"><b>${esc(fmtMoney(fin.overdueCents))}</b><span>em atraso</span></div>`
      : `<div class="stat"><b>${pending.length}</b><span>cirurgias com termos pendentes</span></div><div class="stat"><b>${rooms.filter((r) => r.active).length}</b><span>salas ativas</span></div>`}
    </div>
    <div class="grid2">
      <section class="panel"><h2>Atendimentos de hoje</h2>${listBlock(todays, 'Nenhum atendimento marcado para hoje.')}</section>
      <section class="panel"><h2>Próximos 7 dias</h2>
        ${listBlock(surgeries.filter((s) => s.date > today && ['agendada', 'confirmada'].includes(s.status)).slice(0, 15), 'Nenhum atendimento nos próximos dias.', true)}</section>
    </div>`;
  const nb = $('#newSx'); if (nb) nb.onclick = () => openSurgeryForm({ date: today });
  page.querySelectorAll('[data-sx]').forEach((el) => { el.onclick = () => openSurgeryDetail(el.dataset.sx); });
}

function setupGuide(hasRooms, hasPros) {
  if (!state.perms.has('catalog:manage')) {
    return '<div class="alert info">O sistema ainda não tem médicos cadastrados. Peça ao administrador para concluir a configuração.</div>';
  }
  return `<div class="alert info"><strong>Para começar a agendar, conclua a configuração:</strong>
    <ul>
      <li>${hasPros ? '✓' : '○'} <a href="#/usuarios">Cadastrar os médicos</a> (cria o acesso e o cadastro na agenda) e os funcionários de cada médico</li>
      <li>${hasRooms ? '✓' : '○'} <a href="#/cadastros?tab=rooms">Cadastrar salas e consultórios</a> (obrigatório para cirurgias)</li>
      <li>○ <a href="#/cadastros?tab=procedures">Cadastrar procedimentos e preços</a> (opcional, agiliza o agendamento)</li>
      <li>○ <a href="#/emails">Configurar o envio de e-mails</a> para os lembretes</li>
    </ul></div>`;
}

function listBlock(list, emptyMsg, showDocs) {
  if (!list.length) return `<p class="empty">${esc(emptyMsg)}</p>`;
  return `<div class="table-wrap"><table class="list"><tbody>${list.map((s) => `
    <tr class="clickable" data-sx="${esc(s.id)}">
      <td><strong>${esc(s.startTime)}</strong><br><span class="muted small">${esc(fmtDate(s.date))}</span></td>
      <td><strong>${esc(s.patientName)}</strong>${s.patientAllergies ? ' <span class="chip emergencia">Alergia</span>' : ''}<br>
        <span class="chip">${esc(state.meta.types[s.type])}</span> ${esc(s.procedureName)}${s.type === 'cirurgia' ? ` · ${esc(state.meta.laterality[s.laterality])}` : ''}<br>
        <span class="muted small">${s.roomId ? `${esc(s.roomName)} · ` : ''}${esc(s.surgeonName)}</span>
        ${showDocs && s.missingDocs.length ? `<br><span class="small" style="color:var(--warn)">Termos pendentes: ${s.missingDocs.map((d) => esc(state.meta.docTypes[d])).join(', ')}</span>` : ''}</td>
      <td><span class="chip ${esc(s.status)}">${esc(state.meta.status[s.status])}</span>
        ${s.priority !== 'eletiva' ? `<br><span class="chip ${esc(s.priority)}">${esc(state.meta.priority[s.priority])}</span>` : ''}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

boot();

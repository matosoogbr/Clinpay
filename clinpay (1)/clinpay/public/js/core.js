// Utilitários compartilhados da interface

export const state = { me: null, perms: new Set(), meta: null, clinicName: '' };

export const $ = (sel, el = document) => el.querySelector(sel);

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || `Erro ${status}`);
    this.status = status;
    this.fields = body && body.fields;
    this.conflicts = body && body.conflicts;
    this.overridable = body && body.overridable;
  }
}

export async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : method !== 'GET' ? '{}' : undefined,
    });
  } catch {
    throw new ApiError(0, { error: 'Sem conexão com o servidor. Verifique a rede; nada foi salvo.' });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && state.me && !url.startsWith('/api/login') && !url.startsWith('/api/me/password')) {
      window.dispatchEvent(new Event('session-expired'));
    }
    throw new ApiError(res.status, data);
  }
  return data;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const pad = (n) => String(n).padStart(2, '0');
export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}
export const fmtDate = (s) => (s ? s.split('-').reverse().join('/') : '');
export const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR') : '');
export function endTime(start, minutes) {
  const [h, m] = start.split(':').map(Number);
  const t = h * 60 + m + minutes;
  const days = Math.floor(t / 1440);
  const r = t % 1440;
  return `${pad(Math.floor(r / 60))}:${pad(r % 60)}${days ? ` (+${days}d)` : ''}`;
}
export function age(birth) {
  if (!birth) return '';
  const [y, m, d] = birth.split('-').map(Number);
  const now = new Date();
  let a = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) a--;
  if (a < 1) {
    const months = (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - m) - (now.getDate() < d ? 1 : 0);
    return `${Math.max(months, 0)} ${months === 1 ? 'mês' : 'meses'}`;
  }
  return `${a} ${a === 1 ? 'ano' : 'anos'}`;
}
export const fmtCpf = (c) => (c && c.length === 11 ? `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}` : c || '');
export const maskCpf = (c) => (c && c.length === 11 ? `***.${c.slice(3, 6)}.${c.slice(6, 9)}-**` : '');

export function cpfInputMask(input) {
  input.addEventListener('input', () => {
    const d = input.value.replace(/\D/g, '').slice(0, 11);
    let out = d;
    if (d.length > 9) out = `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
    else if (d.length > 6) out = `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
    else if (d.length > 3) out = `${d.slice(0, 3)}.${d.slice(3)}`;
    input.value = out;
  });
}

export function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 7000 : 3500);
}

let pageHandler = null;
export const setPageHandler = (fn) => { pageHandler = fn; };
export const getPageHandler = () => pageHandler;

/** Abre um modal. Retorna { el, close }. Esc fecha (a não ser que locked). */
export function modal({ title, body, foot = '', wide = false, onClose }) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="mt">
      <div class="modal-head"><h2 id="mt">${title}</h2><button class="close-x" aria-label="Fechar">×</button></div>
      <div class="modal-body">${body}</div>
      ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
    </div>`;
  document.body.appendChild(ov);
  const prevFocus = document.activeElement;
  const close = () => {
    ov.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  };
  const onKey = (e) => { if (e.key === 'Escape' && document.body.lastElementChild === ov) close(); };
  document.addEventListener('keydown', onKey);
  ov.querySelector('.close-x').onclick = close;
  const first = ov.querySelector('.modal-body input:not([type=hidden]):not([disabled]), .modal-body select, .modal-body textarea');
  // Só coloca o cursor no primeiro campo se a pessoa ainda não clicou em outro campo da janela
  if (first) setTimeout(() => { if (!ov.contains(document.activeElement)) first.focus(); }, 30);
  return { el: ov, close };
}

export function confirmDialog(message, { okLabel = 'Confirmar', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title: 'Confirmar',
      body: `<p>${esc(message)}</p>`,
      foot: `<button class="btn" data-no>Voltar</button><button class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(okLabel)}</button>`,
      onClose: () => { if (!done) resolve(false); },
    });
    m.el.querySelector('[data-no]').onclick = () => m.close();
    m.el.querySelector('[data-yes]').onclick = () => { done = true; m.close(); resolve(true); };
    setTimeout(() => m.el.querySelector('[data-yes]').focus(), 30);
  });
}

export function promptDialog(title, label, { okLabel = 'Confirmar', min = 3 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title: esc(title),
      body: `<div class="form"><div class="field s6"><label class="req" for="pr">${esc(label)}</label><textarea id="pr" maxlength="1000"></textarea><span class="err"></span></div></div>`,
      foot: `<button class="btn" data-no>Voltar</button><button class="btn primary" data-yes>${esc(okLabel)}</button>`,
      onClose: () => { if (!done) resolve(null); },
    });
    m.el.querySelector('[data-no]').onclick = () => m.close();
    m.el.querySelector('[data-yes]').onclick = () => {
      const v = m.el.querySelector('#pr').value.trim();
      if (v.length < min) { m.el.querySelector('.err').textContent = `Escreva pelo menos ${min} caracteres.`; return; }
      done = true; m.close(); resolve(v);
    };
  });
}

/** Mostra erros de validação do servidor junto aos campos. */
export function showErrors(container, err, summaryEl) {
  container.querySelectorAll('.field.invalid').forEach((f) => f.classList.remove('invalid'));
  container.querySelectorAll('.field .err').forEach((e) => { e.textContent = ''; });
  const unmatched = [];
  if (err.fields) {
    for (const [k, msg] of Object.entries(err.fields)) {
      const input = container.querySelector(`[name="${CSS.escape(k)}"]`);
      const field = input && input.closest('.field');
      if (field) {
        field.classList.add('invalid');
        let e = field.querySelector('.err');
        if (!e) { e = document.createElement('span'); e.className = 'err'; field.appendChild(e); }
        e.textContent = msg;
      } else unmatched.push(msg);
    }
  }
  if (summaryEl) {
    summaryEl.innerHTML = `<div class="alert danger">${esc(err.message)}${unmatched.length ? `<ul>${unmatched.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}</div>`;
    summaryEl.scrollIntoView({ block: 'nearest' });
  }
  const firstInvalid = container.querySelector('.field.invalid input, .field.invalid select, .field.invalid textarea');
  if (firstInvalid) firstInvalid.focus();
}

/** Lê os campos de um formulário pelo atributo name. */
export function readForm(container) {
  const out = {};
  container.querySelectorAll('[name]').forEach((el) => {
    if (el.type === 'checkbox') { if (!el.dataset.multi) out[el.name] = el.checked; }
    else if (el.type === 'number') out[el.name] = el.value === '' ? null : Number(el.value);
    else out[el.name] = el.value;
  });
  container.querySelectorAll('[data-multi]').forEach((el) => {
    const k = el.dataset.multi;
    if (!out[k]) out[k] = [];
    if (el.checked) out[k].push(el.value);
  });
  return out;
}

export const options = (obj, selected, empty) =>
  (empty !== undefined ? `<option value="">${esc(empty)}</option>` : '') +
  Object.entries(obj).map(([v, l]) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(l)}</option>`).join('');

export const can = (p) => state.perms.has(p);

/** Médico ou funcionário do médico: id do médico vinculado; demais perfis: null. */
export const myPro = () => (state.meta && state.meta.scopedRoles.includes(state.me.role) ? state.me.professionalId : null);

// ---------- Dinheiro (sempre em centavos) ----------
export const fmtMoney = (cents) => (cents == null ? '' : (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
/** Converte "1.234,56", "1234.56" ou "150" em centavos. Retorna null se vazio e NaN se inválido. */
export function parseMoney(v) {
  let t = String(v ?? '').trim().replace(/[R$\s]/g, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return NaN;
  return Math.round(Number(t) * 100);
}
export const moneyInput = (cents) => (cents == null ? '' : (cents / 100).toFixed(2).replace('.', ','));

export const notifyChange = () => window.dispatchEvent(new Event('data-changed'));

export function printModal(m) {
  document.body.classList.add('printing-modal');
  const done = () => { document.body.classList.remove('printing-modal'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
  void m;
}

const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const ICONS = {
  home: svg('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>'),
  calendar: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
  users: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 010 7M18 14.8c1.9.7 3 2.5 3.5 5.2"/>'),
  pen: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>'),
  grid: svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
  key: svg('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>'),
  list: svg('<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>'),
  menu: svg('<path d="M3 6h18M3 12h18M3 18h18"/>'),
  mail: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>'),
  money: svg('<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 10v4M18 10v4"/>'),
  chart: svg('<path d="M3 20h18"/><rect x="5" y="11" width="3" height="7" rx="1"/><rect x="10.5" y="6" width="3" height="12" rx="1"/><rect x="16" y="13" width="3" height="5" rx="1"/>'),
  funnel: svg('<path d="M3 5h18l-7 8v6l-4 2v-8z"/>'),
  print: svg('<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>'),
};

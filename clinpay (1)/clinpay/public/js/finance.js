import {
  api, state, esc, fmtDate, fmtDateTime, todayStr, addDays, toast, $, modal, confirmDialog, promptDialog,
  showErrors, readForm, options, can, notifyChange, ICONS, myPro, fmtMoney, parseMoney, moneyInput,
} from './core.js';
import { donut } from './charts.js';

const PERIODS = { mes: 'Este mês', mes_passado: 'Mês passado', hoje: 'Hoje', semana: 'Últimos 7 dias', ano: 'Este ano', personalizado: 'Personalizado' };
const TABS = { pendente: 'A receber', atrasado: 'Em atraso', pago: 'Pagas', cancelado: 'Canceladas', '': 'Todas', despesas: 'Despesas' };
const STATUS_CHIP = { aberto: 'agendada', parcial: 'em_andamento', pago: 'concluida', cancelado: 'cancelada' };

function periodRange(p, params) {
  const t = todayStr();
  const [y, m] = t.split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const lastDay = (yy, mm) => new Date(yy, mm, 0).getDate();
  if (p === 'hoje') return [t, t];
  if (p === 'semana') return [addDays(t, -6), t];
  if (p === 'ano') return [`${y}-01-01`, `${y}-12-31`];
  if (p === 'mes_passado') {
    const py = m === 1 ? y - 1 : y; const pm = m === 1 ? 12 : m - 1;
    return [`${py}-${pad(pm)}-01`, `${py}-${pad(pm)}-${lastDay(py, pm)}`];
  }
  if (p === 'personalizado') return [params.get('from') || `${y}-${pad(m)}-01`, params.get('to') || t];
  return [`${y}-${pad(m)}-01`, `${y}-${pad(m)}-${lastDay(y, m)}`];
}

export async function financePage(page, params) {
  const period = PERIODS[params.get('p')] ? params.get('p') : 'mes';
  const [from, to] = periodRange(period, params);
  const tab = TABS[params.get('tab')] !== undefined ? params.get('tab') || '' : 'pendente';
  const mine = myPro();
  const pro = mine || params.get('pro') || '';
  const go = (changes) => {
    const q = new URLSearchParams({ p: period, tab, ...(pro && !mine ? { pro } : {}), ...(period === 'personalizado' ? { from, to } : {}), ...changes });
    for (const [k, v] of [...q]) if (v === '') q.delete(k);
    location.hash = `#/financeiro?${q}`;
  };
  const qs = `from=${from}&to=${to}${pro ? `&professionalId=${encodeURIComponent(pro)}` : ''}`;
  const listQs = `${tab === 'pendente' || tab === 'atrasado' ? '' : `from=${from}&to=${to}&`}${tab ? `status=${tab}` : ''}${pro ? `&professionalId=${encodeURIComponent(pro)}` : ''}`;
  const [sum, list, pros] = await Promise.all([
    api('GET', `/api/finance/summary?${qs}`),
    tab === 'despesas' ? api('GET', `/api/finance/expenses?from=${from}&to=${to}`) : api('GET', `/api/finance/charges?${listQs}`),
    api('GET', '/api/professionals'),
  ]);
  const M = state.meta;

  page.innerHTML = `
    <div class="page-head">
      <div><button class="btn menu-toggle" id="menuToggle" aria-label="Abrir menu">${ICONS.menu}</button><h1>Financeiro</h1>
      <p class="muted">${mine ? `Atendimentos de ${esc((pros.find((p) => p.id === mine) || {}).name || 'seu médico')}` : 'Todos os médicos da clínica'} · ${esc(fmtDate(from))} a ${esc(fmtDate(to))}</p></div>
      <div class="toolbar">
        <select id="per" class="btn" aria-label="Período">${options(PERIODS, period)}</select>
        ${period === 'personalizado' ? `<input type="date" id="from" class="btn" value="${esc(from)}" aria-label="De"><input type="date" id="to" class="btn" value="${esc(to)}" aria-label="Até">` : ''}
        ${mine ? '' : `<select id="proF" class="btn" aria-label="Médico"><option value="">Todos os médicos</option>${pros.map((p) => `<option value="${esc(p.id)}"${p.id === pro ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`}
        ${can('finance:write') ? '<button class="btn" id="newExpense">Nova despesa</button><button class="btn primary" id="newCharge">Nova cobrança</button>' : ''}
      </div>
    </div>
    <div class="stats">
      <div class="stat"><b style="color:var(--ok)">${esc(fmtMoney(sum.receivedCents))}</b><span>recebido no período</span></div>
      <div class="stat"><b>${esc(fmtMoney(sum.expensesPaidCents))}</b><span>despesas pagas no período</span></div>
      <div class="stat"><b style="color:${sum.profitCents < 0 ? 'var(--danger)' : 'var(--ok)'}">${esc(fmtMoney(sum.profitCents))}</b><span>lucro (recebido − despesas)</span></div>
      <div class="stat"><b style="color:${sum.overdueCents ? 'var(--danger)' : 'inherit'}">${esc(fmtMoney(sum.overdueCents))}</b><span>em atraso · ${esc(fmtMoney(sum.toReceiveCents))} a receber</span></div>
    </div>
    <div class="grid2">
      <section class="panel"><h3 style="margin-bottom:10px">Recebido por forma de pagamento</h3>
        ${donut(sum.byMethod.map((x) => ({ label: x.label, value: x.cents })), { fmt: fmtMoney, center: fmtMoney(sum.receivedCents), centerSub: 'recebido', size: 190, empty: 'Nenhum recebimento no período.' })}
      </section>
      <section class="panel"><h3 style="margin-bottom:10px">Cobrado no período</h3>
        ${donut([
          { label: 'Já recebido', value: Math.max(sum.billedCents - sum.toReceiveCents, 0), color: '#17A673' },
          { label: 'Ainda a receber', value: sum.toReceiveCents, color: '#F0A93B' },
        ], { fmt: fmtMoney, center: fmtMoney(sum.billedCents), centerSub: 'cobrado', size: 190, empty: 'Nenhuma cobrança com vencimento no período.' })}
      </section>
    </div>
    <div class="grid2">
      <section class="panel"><h3 style="margin-bottom:10px">Receita × despesas</h3>
        ${donut([{ label: 'Lucro', value: Math.max(sum.profitCents, 0), color: '#17A673' }, { label: 'Despesas pagas', value: sum.expensesPaidCents, color: '#E35D6A' }],
          { fmt: fmtMoney, center: fmtMoney(sum.receivedCents), centerSub: 'recebido', size: 190, empty: 'Sem receitas nem despesas no período.' })}
        ${sum.profitCents < 0 ? '<div class="alert danger small" style="margin-top:10px">As despesas superaram o recebido no período.</div>' : ''}
      </section>
      <section class="panel"><h3 style="margin-bottom:10px">Despesas por categoria</h3>
        ${donut(sum.byExpenseCategory.map((x) => ({ label: x.label, value: x.cents })), { fmt: fmtMoney, size: 190, empty: 'Nenhuma despesa paga no período. Registre em "Nova despesa".' })}
      </section>
    </div>
    ${sum.byProfessional.length ? `<section class="panel"><h3 style="margin-bottom:10px">Por médico</h3>
      <div class="grid2"><div>${donut(sum.byProfessional.map((r) => ({ label: r.name, value: r.receivedCents })), { fmt: fmtMoney, size: 170, empty: 'Nenhum recebimento no período.' })}</div>
      <div class="table-wrap"><table class="list"><thead><tr><th>Médico(a)</th><th>Recebido</th><th>A receber</th></tr></thead><tbody>
        ${sum.byProfessional.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(fmtMoney(r.receivedCents))}</td><td>${esc(fmtMoney(r.toReceiveCents))}</td></tr>`).join('')}</tbody></table></div></div></section>`
      : `<section class="panel"><h3 style="margin-bottom:6px">Como cobrar</h3><p class="small" style="margin:0">Informe o valor e a forma de cobrança ao agendar a consulta: a cobrança é criada aqui automaticamente. Orçamentos aprovados no CRM também viram cobrança. Para cobranças avulsas (relatórios, exames, pacotes), use "Nova cobrança". Quando o paciente pagar, clique em "Receber".</p></section>`}
    <section class="panel">
      <div class="tabs" role="tablist">${Object.entries(TABS).map(([k, l]) => `<button role="tab" data-tab="${k}" class="${k === tab ? 'active' : ''}">${esc(l)}</button>`).join('')}</div>
      ${tab === 'despesas' ? expensesTable(list, mine) : list.length ? `<div class="table-wrap"><table class="list"><thead><tr><th>Vencimento</th><th>Paciente</th><th>Descrição</th>${mine ? '' : '<th>Médico(a)</th>'}<th>Valor</th><th>Recebido</th><th>Situação</th><th></th></tr></thead><tbody>
        ${list.map((c) => `<tr class="clickable" data-charge="${esc(c.id)}">
          <td>${esc(fmtDate(c.dueDate))}${c.overdue ? '<br><span class="small" style="color:var(--danger)">atrasada</span>' : ''}</td>
          <td>${esc(c.patientName)}</td><td>${esc(c.description)}<br><span class="muted small">${esc(M.paymentMethods[c.method])}${c.installments > 1 ? ` em ${c.installments}x` : ''}${c.coverage === 'convenio' ? ` · ${esc(c.insurer || 'convênio')}` : ''}</span></td>
          ${mine ? '' : `<td>${esc(c.professionalName)}</td>`}
          <td>${esc(fmtMoney(c.amountCents))}</td><td>${esc(fmtMoney(c.paidCents))}</td>
          <td><span class="chip ${STATUS_CHIP[c.status]}">${esc(M.chargeStatus[c.status])}</span></td>
          <td>${['aberto', 'parcial'].includes(c.status) && can('finance:write') ? `<button class="btn ok sm" data-receive="${esc(c.id)}">Receber</button>` : ''}</td>
        </tr>`).join('')}</tbody></table></div>`
        : `<p class="empty">Nenhuma cobrança ${tab === 'pendente' ? 'a receber' : tab === 'atrasado' ? 'em atraso' : 'neste filtro'}.</p>`}
    </section>`;

  $('#per').onchange = (e) => go({ p: e.target.value });
  if ($('#from')) { $('#from').onchange = (e) => go({ from: e.target.value }); $('#to').onchange = (e) => go({ to: e.target.value }); }
  if ($('#proF')) $('#proF').onchange = (e) => go({ pro: e.target.value });
  page.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => go({ tab: b.dataset.tab }); });
  const nc = $('#newCharge'); if (nc) nc.onclick = () => openChargeForm(null, notifyChange);
  const ne = $('#newExpense'); if (ne) ne.onclick = () => openExpenseForm(pros, notifyChange);
  page.querySelectorAll('[data-exp-pay]').forEach((b) => { b.onclick = () => payExpense(list.find((x) => x.id === b.dataset.expPay)); });
  page.querySelectorAll('[data-exp-cancel]').forEach((b) => {
    b.onclick = async () => {
      const reason = await promptDialog('Cancelar despesa', 'Motivo'); if (!reason) return;
      try { await api('POST', `/api/finance/expenses/${encodeURIComponent(b.dataset.expCancel)}/cancel`, { reason }); toast('Despesa cancelada.'); notifyChange(); } catch (e) { toast(e.message, 'error'); }
    };
  });
  page.querySelectorAll('[data-receive]').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); openPaymentForm(list.find((c) => c.id === b.dataset.receive), notifyChange); };
  });
  page.querySelectorAll('[data-charge]').forEach((tr) => { tr.onclick = () => openChargeDetail(tr.dataset.charge); });
  if (params.get('charge')) openChargeDetail(params.get('charge'));
}

// ---------- Despesas ----------
function expensesTable(list, mine) {
  const M = state.meta;
  if (!list.length) return '<p class="empty">Nenhuma despesa no período. Use "Nova despesa" para registrar aluguel, laboratório, materiais e outros custos.</p>';
  const chip = { aberto: 'agendada', pago: 'concluida', cancelado: 'cancelada' };
  const lab = { aberto: 'Em aberto', pago: 'Paga', cancelado: 'Cancelada' };
  return `<div class="table-wrap"><table class="list"><thead><tr><th>Vencimento / pago em</th><th>Descrição</th><th>Categoria</th>${mine ? '' : '<th>Médico</th>'}<th>Valor</th><th>Situação</th><th></th></tr></thead><tbody>
    ${list.map((e) => `<tr><td>${esc(fmtDate(e.dueDate))}${e.paidAt ? `<br><span class="small muted">pago ${esc(fmtDate(e.paidAt))}</span>` : e.overdue ? '<br><span class="small" style="color:var(--danger)">vencida</span>' : ''}</td>
      <td>${esc(e.description)}${e.supplier ? `<br><span class="small muted">${esc(e.supplier)}</span>` : ''}</td><td>${esc(M.expenseCategories[e.category])}</td>
      ${mine ? '' : `<td>${esc(e.professionalName || 'Clínica')}</td>`}<td>${esc(fmtMoney(e.amountCents))}</td>
      <td><span class="chip ${chip[e.status]}">${lab[e.status]}</span></td>
      <td><div class="toolbar">${e.status === 'aberto' && can('finance:write') ? `<button class="btn ok sm" data-exp-pay="${esc(e.id)}">Pagar</button>` : ''}
        ${e.status !== 'cancelado' && (e.status === 'aberto' ? can('finance:write') : can('finance:reverse')) ? `<button class="btn sm ghost" data-exp-cancel="${esc(e.id)}">Cancelar</button>` : ''}</div></td></tr>`).join('')}</tbody></table></div>`;
}

function openExpenseForm(pros, onDone) {
  const M = state.meta; const mine = myPro();
  const m = modal({
    title: 'Nova despesa',
    body: `<div class="form" id="exForm">
      <div class="field s4"><label class="req" for="description">Descrição</label><input name="description" id="description" maxlength="200" placeholder="Ex.: Laboratório — coroa do paciente, aluguel de março"></div>
      <div class="field s2"><label class="req" for="category">Categoria</label><select name="category" id="category">${options(M.expenseCategories, 'laboratorio')}</select></div>
      <div class="field s2"><label class="req" for="amount">Valor (R$)</label><input id="amount" inputmode="decimal" placeholder="0,00"></div>
      <div class="field s2"><label class="req" for="dueDate">Vencimento</label><input type="date" name="dueDate" id="dueDate" value="${esc(todayStr())}"></div>
      <div class="field s2"><label for="supplier">Fornecedor</label><input name="supplier" id="supplier" maxlength="150"></div>
      ${mine ? '' : `<div class="field s3"><label for="professionalId">Ligada a um médico?</label><select name="professionalId" id="professionalId"><option value="">Não — despesa da clínica</option>${pros.filter((p) => p.active).map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></div>`}
      <div class="field s3"><label class="check" style="margin-top:26px"><input type="checkbox" id="alreadyPaid"> Já foi paga</label></div>
      <div class="field s3 hidden pd"><label for="paidAt">Pago em</label><input type="date" id="paidAt" value="${esc(todayStr())}" max="${esc(todayStr())}"></div>
      <div class="field s3 hidden pd"><label for="pmethod">Forma de pagamento</label><select id="pmethod">${options(M.paymentMethods, 'pix')}</select></div>
      <div class="field s6"><label for="notes">Observações</label><textarea name="notes" id="notes"></textarea></div>
      <div class="field s6" id="exErr"></div></div>`,
    foot: '<button class="btn" data-cancel>Cancelar</button><button class="btn primary" data-save>Salvar despesa</button>',
  });
  const f = m.el.querySelector('#exForm');
  const ap = f.querySelector('#alreadyPaid');
  ap.onchange = () => f.querySelectorAll('.pd').forEach((el) => el.classList.toggle('hidden', !ap.checked));
  m.el.querySelector('[data-cancel]').onclick = m.close;
  m.el.querySelector('[data-save]').onclick = async () => {
    const d = readForm(f); const cents = parseMoney(f.querySelector('#amount').value);
    if (!cents || Number.isNaN(cents)) { showErrors(f, { message: 'Informe um valor válido, por exemplo 350,00.', fields: {} }, f.querySelector('#exErr')); return; }
    const payload = { ...d, amountCents: cents, professionalId: d.professionalId || null };
    if (ap.checked) { payload.paidAt = f.querySelector('#paidAt').value; payload.method = f.querySelector('#pmethod').value; }
    try { await api('POST', '/api/finance/expenses', payload); m.close(); toast('Despesa registrada.'); onDone(); } catch (e) { showErrors(f, e, f.querySelector('#exErr')); }
  };
}

function payExpense(e) {
  const M = state.meta;
  const m = modal({
    title: `Pagar: ${e.description}`,
    body: `<div class="form" id="peForm"><div class="field s6 alert info" style="display:block">Valor: <strong>${esc(fmtMoney(e.amountCents))}</strong></div>
      <div class="field s3"><label class="req" for="paidAt">Data do pagamento</label><input type="date" name="paidAt" id="paidAt" value="${esc(todayStr())}" max="${esc(todayStr())}"></div>
      <div class="field s3"><label class="req" for="method">Forma</label><select name="method" id="method">${options(M.paymentMethods, 'pix')}</select></div>
      <div class="field s6" id="peErr"></div></div>`,
    foot: '<button class="btn" data-cancel>Cancelar</button><button class="btn ok" data-save>Confirmar pagamento</button>',
  });
  const f = m.el.querySelector('#peForm');
  m.el.querySelector('[data-cancel]').onclick = m.close;
  m.el.querySelector('[data-save]').onclick = async () => {
    try { await api('POST', `/api/finance/expenses/${encodeURIComponent(e.id)}/pay`, readForm(f)); m.close(); toast('Despesa paga.'); notifyChange(); } catch (err) { showErrors(f, err, f.querySelector('#peErr')); }
  };
}

// ---------- Receber pagamento ----------
export function openPaymentForm(c, onDone) {
  const M = state.meta;
  const balance = c.amountCents - c.paidCents;
  const m = modal({
    title: 'Registrar pagamento',
    body: `<div class="form" id="payForm">
      <div class="field s6 alert info" style="display:block"><strong>${esc(c.patientName)}</strong> — ${esc(c.description)}<br>
        Valor: ${esc(fmtMoney(c.amountCents))} · Já recebido: ${esc(fmtMoney(c.paidCents))} · <strong>Saldo: ${esc(fmtMoney(balance))}</strong></div>
      <div class="field s2"><label class="req" for="amount">Valor recebido (R$)</label><input id="amount" name="amount" inputmode="decimal" value="${esc(moneyInput(balance))}"></div>
      <div class="field s2"><label class="req" for="method">Forma de pagamento</label><select name="method" id="method">${options(M.paymentMethods, c.method)}</select></div>
      <div class="field s2"><label class="req" for="paidAt">Data</label><input type="date" name="paidAt" id="paidAt" value="${esc(todayStr())}" max="${esc(todayStr())}"></div>
      <div class="field s2" id="instP"><label for="installments">Parcelas no cartão</label><select name="installments" id="installments">${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}"${(c.installments || 1) === i + 1 ? ' selected' : ''}>${i + 1}x</option>`).join('')}</select></div>
      <div class="field s4"><label for="notes">Observação</label><input name="notes" id="notes" maxlength="300" placeholder="Ex.: comprovante PIX, nº da autorização do cartão"></div>
      <div class="field s6" id="payErr"></div></div>`,
    foot: '<button class="btn" data-cancel>Cancelar</button><button class="btn ok" data-save>Confirmar recebimento</button>',
  });
  const f = m.el.querySelector('#payForm');
  const inst = f.querySelector('#instP');
  const sync = () => inst.classList.toggle('hidden', f.querySelector('#method').value !== 'cartao_credito');
  f.querySelector('#method').onchange = sync; sync();
  m.el.querySelector('[data-cancel]').onclick = m.close;
  const btn = m.el.querySelector('[data-save]');
  btn.onclick = async () => {
    const d = readForm(f);
    const cents = parseMoney(d.amount);
    if (!cents || Number.isNaN(cents)) { showErrors(f, { message: 'Informe um valor válido, por exemplo 150,00.', fields: { amount: 'Valor inválido.' } }, f.querySelector('#payErr')); return; }
    btn.disabled = true;
    try {
      await api('POST', `/api/finance/charges/${encodeURIComponent(c.id)}/payments`, {
        amountCents: cents, method: d.method, paidAt: d.paidAt, installments: d.method === 'cartao_credito' ? Number(d.installments) : 1, notes: d.notes || null,
      });
      m.close(); toast(`Recebido ${fmtMoney(cents)}.`);
      if (onDone) onDone();
    } catch (e) {
      if (e.fields && e.fields.amountCents) e.fields.amount = e.fields.amountCents;
      showErrors(f, e, f.querySelector('#payErr'));
    } finally { btn.disabled = false; }
  };
}

// ---------- Detalhe da cobrança ----------
async function openChargeDetail(id) {
  const m = modal({ title: 'Cobrança', wide: true, body: '<p class="muted">Carregando…</p>' });
  const load = async () => {
    let c;
    try { c = await api('GET', `/api/finance/charges/${encodeURIComponent(id)}`); } catch (e) {
      m.el.querySelector('.modal-body').innerHTML = `<div class="alert danger">${esc(e.message)}</div>`; return;
    }
    const M = state.meta;
    const open = ['aberto', 'parcial'].includes(c.status);
    m.el.querySelector('#mt').textContent = c.description;
    m.el.querySelector('.modal-body').innerHTML = `
      <div class="toolbar" style="margin-bottom:12px">
        <span class="chip ${STATUS_CHIP[c.status]}">${esc(M.chargeStatus[c.status])}</span>
        ${c.overdue ? '<span class="chip emergencia">Em atraso</span>' : ''}
      </div>
      <dl class="kv">
        <dt>Paciente</dt><dd>${esc(c.patientName)}</dd>
        <dt>Médico(a)</dt><dd>${esc(c.professionalName)}</dd>
        <dt>Valor</dt><dd><strong>${esc(fmtMoney(c.amountCents))}</strong></dd>
        <dt>Recebido</dt><dd>${esc(fmtMoney(c.paidCents))}</dd>
        <dt>Saldo</dt><dd><strong>${esc(fmtMoney(c.balanceCents))}</strong></dd>
        <dt>Vencimento</dt><dd>${esc(fmtDate(c.dueDate))}</dd>
        <dt>Forma de cobrança</dt><dd>${esc(M.paymentMethods[c.method])}${c.installments > 1 ? ` em ${c.installments}x` : ''}</dd>
        <dt>Atendimento</dt><dd>${c.coverage === 'convenio' ? `Convênio ${esc(c.insurer || '')}` : 'Particular'}${c.appointmentId ? ' · ligada a um agendamento' : ' · cobrança avulsa'}</dd>
        ${c.notes ? `<dt>Observações</dt><dd>${esc(c.notes)}</dd>` : ''}
        ${c.status === 'cancelado' ? `<dt>Cancelada</dt><dd>${esc(fmtDateTime(c.canceledAt))} por ${esc(c.canceledByName)} — ${esc(c.cancelReason)}</dd>` : ''}
      </dl>
      <div class="toolbar no-print" style="margin:14px 0">
        ${open && can('finance:write') ? '<button class="btn ok" data-receive>Receber</button><button class="btn" data-edit>Editar</button>' : ''}
        ${open && c.paidCents === 0 && can('finance:write') ? '<button class="btn danger" data-cancel-charge>Cancelar cobrança</button>' : ''}
      </div>
      <div id="chErr"></div>
      <h3 style="margin:10px 0 6px">Pagamentos</h3>
      ${c.payments.length ? `<ul class="history">${c.payments.map((p) => `<li${p.reversedAt ? ' style="opacity:.6"' : ''}>
        <strong>${esc(fmtMoney(p.amountCents))}</strong> — ${esc(M.paymentMethods[p.method])}${p.installments > 1 ? ` em ${p.installments}x` : ''}, em ${esc(fmtDate(p.paidAt))} (registrado por ${esc(p.byName)})${p.notes ? ` — ${esc(p.notes)}` : ''}
        ${p.reversedAt ? `<br><span class="small" style="color:var(--danger)">Estornado por ${esc(p.reversedByName)} em ${esc(fmtDateTime(p.reversedAt))}: ${esc(p.reverseReason)}</span>`
          : can('finance:reverse') ? ` <button class="btn sm danger" data-reverse="${esc(p.id)}">Estornar</button>` : ''}</li>`).join('')}</ul>`
        : '<p class="muted small">Nenhum pagamento registrado.</p>'}`;
    const body = m.el.querySelector('.modal-body');
    const fail = (e) => { body.querySelector('#chErr').innerHTML = `<div class="alert danger">${esc(e.message)}</div>`; };
    const refresh = async (msg) => { toast(msg); notifyChange(); await load(); };
    const rc = body.querySelector('[data-receive]'); if (rc) rc.onclick = () => openPaymentForm(c, () => refresh('Pagamento registrado.'));
    const ed = body.querySelector('[data-edit]'); if (ed) ed.onclick = () => openChargeForm(c, () => refresh('Cobrança atualizada.'));
    const cc = body.querySelector('[data-cancel-charge]');
    if (cc) cc.onclick = async () => {
      const reason = await promptDialog('Cancelar cobrança', 'Motivo', { okLabel: 'Cancelar cobrança' });
      if (!reason) return;
      try { await api('POST', `/api/finance/charges/${encodeURIComponent(c.id)}/cancel`, { reason }); await refresh('Cobrança cancelada.'); } catch (e) { fail(e); }
    };
    body.querySelectorAll('[data-reverse]').forEach((b) => {
      b.onclick = async () => {
        const reason = await promptDialog('Estornar pagamento', 'Motivo do estorno (fica registrado)', { okLabel: 'Estornar', min: 5 });
        if (!reason) return;
        try { await api('POST', `/api/finance/charges/${encodeURIComponent(c.id)}/payments/${encodeURIComponent(b.dataset.reverse)}/reverse`, { reason }); await refresh('Pagamento estornado.'); } catch (e) { fail(e); }
      };
    });
  };
  await load();
}

// ---------- Nova cobrança / editar ----------
async function openChargeForm(existing, onDone) {
  const M = state.meta;
  const pros = (await api('GET', '/api/professionals')).filter((p) => p.active || (existing && p.id === existing.professionalId));
  const mine = myPro();
  const doctors = pros.filter((p) => p.active && ['medico', 'cirurgiao'].includes(p.role));
  const v = existing || { dueDate: todayStr(), method: 'pix', installments: 1, coverage: 'particular', professionalId: mine || (doctors.length === 1 ? doctors[0].id : '') };
  const m = modal({
    title: existing ? 'Editar cobrança' : 'Nova cobrança',
    body: `<div class="form" id="chForm">
      <div class="field s6"><label class="req">Paciente</label>
        ${existing ? `<input disabled value="${esc(existing.patientName)}"><input type="hidden" name="patientId" value="${esc(existing.patientId)}">`
          : `<input type="hidden" name="patientId"><div class="typeahead"><input id="pq" placeholder="Digite o nome ou CPF" autocomplete="off" aria-label="Buscar paciente"><div class="results hidden" id="pres"></div></div>`}</div>
      <div class="field s3"><label class="req" for="professionalId">Médico(a)</label><select name="professionalId" id="professionalId"${existing && existing.appointmentId ? ' disabled' : ''}>
        ${mine ? pros.filter((p) => p.id === mine).map((p) => `<option value="${esc(p.id)}" selected>${esc(p.name)}</option>`).join('')
          : `<option value="">Selecione…</option>${pros.map((p) => `<option value="${esc(p.id)}"${p.id === v.professionalId ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}`}</select></div>
      <div class="field s3"><label class="req" for="description">Descrição</label><input name="description" id="description" maxlength="200" value="${esc(v.description || '')}" placeholder="Ex.: Relatório médico, Pacote de sessões"></div>
      <div class="field s2"><label class="req" for="amount">Valor (R$)</label><input id="amount" inputmode="decimal" value="${esc(moneyInput(v.amountCents))}" placeholder="0,00"></div>
      <div class="field s2"><label class="req" for="dueDate">Vencimento</label><input type="date" name="dueDate" id="dueDate" value="${esc(v.dueDate)}"></div>
      <div class="field s2"><label class="req" for="method">Forma de cobrança</label><select name="method" id="method">${options(M.paymentMethods, v.method)}</select></div>
      <div class="field s2" id="instC"><label for="installments">Parcelas</label><select name="installments" id="installments">${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}"${(v.installments || 1) === i + 1 ? ' selected' : ''}>${i + 1}x</option>`).join('')}</select></div>
      <div class="field s2"><label for="coverage">Atendimento</label><select name="coverage" id="coverage">${options({ particular: 'Particular', convenio: 'Convênio' }, v.coverage)}</select></div>
      <div class="field s2"><label for="insurer">Convênio</label><input name="insurer" id="insurer" value="${esc(v.insurer || '')}"></div>
      <div class="field s6"><label for="notes">Observações</label><textarea name="notes" id="notes">${esc(v.notes || '')}</textarea></div>
      <div class="field s6" id="chErr"></div></div>`,
    foot: `<button class="btn" data-cancel>Cancelar</button><button class="btn primary" data-save>${existing ? 'Salvar' : 'Criar cobrança'}</button>`,
  });
  const f = m.el.querySelector('#chForm');
  const inst = f.querySelector('#instC');
  const sync = () => inst.classList.toggle('hidden', f.querySelector('#method').value !== 'cartao_credito');
  f.querySelector('#method').onchange = sync; sync();
  if (!existing) {
    const q = f.querySelector('#pq'); const res = f.querySelector('#pres'); let t;
    q.oninput = () => {
      clearTimeout(t);
      f.querySelector('[name=patientId]').value = '';
      t = setTimeout(async () => {
        const term = q.value.trim();
        if (term.length < 2) { res.classList.add('hidden'); return; }
        const list = (await api('GET', `/api/patients?q=${encodeURIComponent(term)}`)).slice(0, 15);
        res.innerHTML = list.length ? list.map((p) => `<button type="button" data-pid="${esc(p.id)}">${esc(p.name)} <span class="muted small">${esc(fmtDate(p.birthDate))}</span></button>`).join('') : '<div style="padding:10px" class="muted">Nenhum paciente encontrado.</div>';
        res.classList.remove('hidden');
        res.querySelectorAll('[data-pid]').forEach((b) => { b.onclick = () => { f.querySelector('[name=patientId]').value = b.dataset.pid; q.value = list.find((p) => p.id === b.dataset.pid).name; res.classList.add('hidden'); }; });
      }, 250);
    };
  }
  m.el.querySelector('[data-cancel]').onclick = m.close;
  m.el.querySelector('[data-save]').onclick = async () => {
    const d = readForm(f);
    const cents = parseMoney(f.querySelector('#amount').value);
    const errBox = f.querySelector('#chErr');
    if (!d.patientId) { showErrors(f, { message: 'Selecione o paciente na lista.', fields: { patientId: 'Selecione o paciente.' } }, errBox); return; }
    if (!cents || Number.isNaN(cents)) { showErrors(f, { message: 'Informe um valor válido, por exemplo 150,00.', fields: {} }, errBox); return; }
    const payload = { ...d, amountCents: cents, installments: d.method === 'cartao_credito' ? Number(d.installments) : 1 };
    if (existing && existing.appointmentId) delete payload.professionalId;
    try {
      if (existing) await api('PUT', `/api/finance/charges/${encodeURIComponent(existing.id)}`, payload);
      else await api('POST', '/api/finance/charges', payload);
      m.close(); toast(existing ? 'Cobrança atualizada.' : 'Cobrança criada.');
      if (onDone) onDone();
    } catch (e) { showErrors(f, e, errBox); }
  };
}

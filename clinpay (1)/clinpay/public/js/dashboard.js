// Dashboard analítico: KPIs, faturamento, metas e funil (atualiza sozinho a cada minuto)
import { api, state, esc, fmtDate, todayStr, addDays, toast, $, modal, showErrors, options, can, ICONS, myPro, fmtMoney, parseMoney, moneyInput, notifyChange } from './core.js';
import { donut, bars, hbars, PALETTE } from './charts.js';
import { openAssistant } from './assistant.js';

const PERIODS = { mes: 'Este mês', '7d': 'Últimos 7 dias', '30d': 'Últimos 30 dias', '90d': 'Últimos 90 dias', ano: 'Este ano' };
let timer = null;

function range(p) {
  const t = todayStr();
  if (p === '7d') return [addDays(t, -6), t];
  if (p === '30d') return [addDays(t, -29), t];
  if (p === '90d') return [addDays(t, -89), t];
  if (p === 'ano') return [`${t.slice(0, 4)}-01-01`, t];
  return [t.slice(0, 8) + '01', t];
}

export async function analyticsPage(page, params) {
  clearInterval(timer);
  const period = PERIODS[params.get('p')] ? params.get('p') : 'mes';
  const mine = myPro();
  const pro = mine || params.get('pro') || '';
  const [from, to] = range(period);
  const pros = await api('GET', '/api/professionals');
  const render = async () => {
    if (!document.body.contains(page) || !location.hash.startsWith('#/indicadores')) { clearInterval(timer); return; }
    const a = await api('GET', `/api/analytics?from=${from}&to=${to}${pro ? `&professionalId=${encodeURIComponent(pro)}` : ''}`);
    const k = a.kpis; const M = state.meta;
    const pctTxt = (v) => (v == null ? '—' : `${String(v).replace('.', ',')}%`);
    const g = a.goal;
    page.innerHTML = `
      <div class="page-head">
        <div><button class="btn menu-toggle" id="menuToggle" aria-label="Abrir menu">${ICONS.menu}</button><h1>Indicadores</h1>
        <p class="muted">${mine ? `Seu desempenho` : pro ? esc((pros.find((p) => p.id === pro) || {}).name || '') : 'Toda a clínica'} · ${esc(fmtDate(a.from))} a ${esc(fmtDate(a.to))} · atualizado às ${esc(new Date(a.generatedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }))}</p></div>
        <div class="toolbar">
          <select id="per" class="btn" aria-label="Período">${options(PERIODS, period)}</select>
          ${mine ? '' : `<select id="proF" class="btn" aria-label="Médico"><option value="">Toda a clínica</option>${pros.map((p) => `<option value="${esc(p.id)}"${p.id === pro ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`}
          ${can('settings:manage') ? '<button class="btn" id="goalsBtn">Definir metas</button>' : ''}
          ${state.ai && state.ai.enabled ? '<button class="btn primary" id="aiAnalyze">✦ Analisar com IA</button>' : ''}
        </div>
      </div>
      <div class="stats kpis">
        <div class="stat"><b>${esc(fmtMoney(k.receivedCents))}</b><span>faturamento recebido</span></div>
        <div class="stat"><b style="color:${k.profitCents < 0 ? 'var(--danger)' : 'var(--ok)'}">${esc(fmtMoney(k.profitCents))}</b><span>lucro${k.marginPct == null ? '' : ` · margem ${pctTxt(k.marginPct)}`}</span></div>
        <div class="stat"><b>${esc(fmtMoney(k.expensesPaidCents))}</b><span>despesas pagas</span></div>
        <div class="stat"><b>${k.avgTicketCents == null ? '—' : esc(fmtMoney(k.avgTicketCents))}</b><span>ticket médio por atendimento</span></div>
        <div class="stat"><b>${k.completed} / ${k.appointments}</b><span>atendimentos concluídos / agendados</span></div>
        <div class="stat"><b>${k.newPatients}</b><span>pacientes novos</span></div>
        <div class="stat"><b style="color:${k.noShowRate > 15 ? 'var(--danger)' : 'inherit'}">${pctTxt(k.noShowRate)}</b><span>taxa de faltas</span></div>
        <div class="stat"><b>${pctTxt(k.cancelRate)}</b><span>taxa de cancelamento</span></div>
        <div class="stat"><b>${pctTxt(k.quoteConversion)}</b><span>orçamentos aprovados (${esc(fmtMoney(k.quotesApprovedCents))})</span></div>
        <div class="stat"><b style="color:${k.overdueCents ? 'var(--danger)' : 'inherit'}">${esc(fmtMoney(k.overdueCents))}</b><span>em atraso · ${esc(fmtMoney(k.openCents))} a receber</span></div>
      </div>
      <section class="panel">
        <div class="page-head" style="margin-bottom:8px"><h2>Meta do mês</h2>
          <span class="muted small">${g.monthCents ? `${esc(fmtMoney(g.receivedMonthCents))} de ${esc(fmtMoney(g.monthCents))}` : 'Nenhuma meta definida'}</span></div>
        ${g.monthCents ? `<div class="progress" title="A linha marca onde deveria estar hoje (${g.expectedProgress}% do mês)"><i style="width:${Math.min(g.progress, 100)}%"></i><em style="left:${g.expectedProgress}%"></em></div>
          <p class="small" style="margin:8px 0 0">${pctTxt(g.progress)} da meta · ${g.progress >= g.expectedProgress ? '<span style="color:var(--ok)">no ritmo ou acima</span>' : `<span style="color:var(--warn)">abaixo do ritmo esperado (${pctTxt(g.expectedProgress)})</span>`}</p>`
          : `<p class="muted small">${can('settings:manage') ? 'Clique em "Definir metas" para acompanhar o faturamento do mês.' : 'O médico responsável ainda não definiu uma meta.'}</p>`}
      </section>
      <section class="panel"><h2 style="margin-bottom:10px">Faturamento recebido por dia</h2>
        ${bars(a.revenueByDay.map((d) => ({ label: d.date.slice(8) + '/' + d.date.slice(5, 7), value: d.cents })), { fmt: fmtMoney })}</section>
      <h2 style="margin:22px 0 10px">Lucro e vendas</h2>
      <div class="grid3">
        <section class="panel"><h3 style="margin-bottom:10px">Receita × despesas</h3>${donut([
          { label: 'Lucro', value: Math.max(k.profitCents, 0), color: '#17A673' }, { label: 'Despesas', value: k.expensesPaidCents, color: '#E35D6A' },
        ], { fmt: fmtMoney, size: 160, center: fmtMoney(k.receivedCents), centerSub: 'recebido', empty: 'Sem receitas nem despesas no período.' })}
          ${k.profitCents < 0 ? '<p class="small" style="color:var(--danger);margin:8px 0 0">Prejuízo no período: as despesas superaram o recebido.</p>' : ''}</section>
        <section class="panel"><h3 style="margin-bottom:10px">Vendas por especialidade</h3>${donut(a.revenueByCategory.map((x) => ({ label: x.label, value: x.cents })), { fmt: fmtMoney, size: 160 })}</section>
        <section class="panel"><h3 style="margin-bottom:10px">Procedimentos mais vendidos</h3>${donut(a.revenueByProcedure.map((x) => ({ label: x.label, value: x.cents })), { fmt: fmtMoney, size: 160 })}</section>
      </div>
      <div class="grid3">
        <section class="panel"><h3 style="margin-bottom:10px">Receita por origem</h3>${donut(a.revenueByOrigin.map((x) => ({ label: x.label, value: x.cents })), { fmt: fmtMoney, size: 160 })}</section>
        <section class="panel"><h3 style="margin-bottom:10px">Orçamentos do período</h3>${donut(a.quotesByStatus.map((x) => ({ label: M.quoteStatus[x.key], value: x.cents, color: { aprovado: '#17A673', enviado: '#1565D8', rascunho: '#8A9AB0', recusado: '#E35D6A', vencido: '#F0A93B' }[x.key] })), { fmt: fmtMoney, size: 160, empty: 'Nenhum orçamento criado no período.' })}</section>
        <section class="panel"><h3 style="margin-bottom:10px">Despesas por categoria</h3>${donut(a.expensesByCategory.map((x) => ({ label: x.label, value: x.cents })), { fmt: fmtMoney, size: 160, empty: 'Nenhuma despesa paga no período.' })}</section>
      </div>
      <h2 style="margin:22px 0 10px">Atendimentos e pagamentos</h2>
      <div class="grid3">
        <section class="panel"><h3 style="margin-bottom:10px">Recebido por forma de pagamento</h3>${donut(a.byMethod.map((x) => ({ label: x.label, value: x.cents })), { fmt: fmtMoney, size: 160 })}</section>
        <section class="panel"><h3 style="margin-bottom:10px">Situação dos atendimentos</h3>${donut(a.byStatus.map((x) => ({ label: x.label, value: x.count, color: statusColor(x.key) })), { size: 160, center: String(k.appointments), centerSub: 'atendimentos' })}</section>
        <section class="panel"><h3 style="margin-bottom:10px">Consultas e cirurgias</h3>${donut(a.byType.map((x, i) => ({ label: x.label, value: x.count, color: PALETTE[i] })), { size: 160 })}</section>
      </div>
      <div class="grid2">
        <section class="panel"><h3 style="margin-bottom:10px">${a.byProfessional.length ? 'Faturamento por médico' : 'Funil de vendas (oportunidades)'}</h3>
          ${a.byProfessional.length ? donut(a.byProfessional.map((x) => ({ label: x.label, value: x.cents })), { fmt: fmtMoney, size: 160 }) : funnel(a.leadsByStage, M)}</section>
        <section class="panel"><h3 style="margin-bottom:10px">${a.byProfessional.length ? 'Funil de vendas (oportunidades)' : 'Origem dos novos contatos'}</h3>
          ${a.byProfessional.length ? funnel(a.leadsByStage, M) : donut(Object.entries(a.leadsBySource).map(([key, v]) => ({ label: M.leadSources[key], value: v })), { size: 150, empty: 'Nenhum contato novo no período.' })}</section>
      </div>`;
    $('#per').onchange = (e) => { location.hash = `#/indicadores?p=${e.target.value}${pro && !mine ? `&pro=${pro}` : ''}`; };
    const ai = $('#aiAnalyze'); if (ai) ai.onclick = () => openAssistant({ context: 'indicadores', from: a.from, to: a.to, prompt: 'Analise os indicadores deste período: o que está bom, o que preocupa e 3 ações práticas para melhorar o lucro e reduzir faltas.' });
    if ($('#proF')) $('#proF').onchange = (e) => { location.hash = `#/indicadores?p=${period}${e.target.value ? `&pro=${e.target.value}` : ''}`; };
    const gb = $('#goalsBtn'); if (gb) gb.onclick = () => openGoals(pros);
  };
  await render();
  timer = setInterval(() => render().catch(() => clearInterval(timer)), 60000);
}

function statusColor(k) {
  return { agendada: '#5B8DB8', confirmada: '#1565D8', em_andamento: '#F0A93B', concluida: '#17A673', adiada: '#7C5CDB', cancelada: '#8A9AB0', faltou: '#E35D6A' }[k];
}

function funnel(byStage, M) {
  const order = ['novo', 'contato', 'avaliacao', 'orcamento', 'ganho', 'perdido'];
  const items = order.map((k) => ({ label: M.leadStages[k], value: byStage[k] || 0 }));
  if (!items.some((x) => x.value)) return '<p class="muted small">Nenhuma oportunidade cadastrada. Use "CRM e vendas" para registrar os contatos.</p>';
  return hbars(items, { fmt: (v) => String(v) });
}

async function openGoals(pros) {
  const g = await api('GET', '/api/analytics/goals');
  const docs = pros.filter((p) => p.active && ['medico', 'cirurgiao'].includes(p.role));
  const m = modal({
    title: 'Metas de faturamento mensal',
    body: `<div class="form" id="gForm">
      <div class="field s6"><label for="clinicGoal">Meta da clínica (R$ por mês)</label><input id="clinicGoal" inputmode="decimal" value="${esc(moneyInput(g.clinicMonthlyCents))}" placeholder="0,00"></div>
      ${docs.map((p) => `<div class="field s3"><label>${esc(p.name)}</label><input data-pro="${esc(p.id)}" inputmode="decimal" value="${esc(moneyInput(g.byProfessional[p.id]))}" placeholder="Sem meta"></div>`).join('')}
      <div class="field s6" id="gErr"></div></div>`,
    foot: '<button class="btn" data-cancel>Cancelar</button><button class="btn primary" data-save>Salvar metas</button>',
  });
  const f = m.el.querySelector('#gForm');
  m.el.querySelector('[data-cancel]').onclick = m.close;
  m.el.querySelector('[data-save]').onclick = async () => {
    const clinic = parseMoney(f.querySelector('#clinicGoal').value);
    const byProfessional = {};
    let bad = Number.isNaN(clinic);
    f.querySelectorAll('[data-pro]').forEach((el) => { const v = parseMoney(el.value); if (Number.isNaN(v)) bad = true; else if (v) byProfessional[el.dataset.pro] = v; });
    if (bad) { showErrors(f, { message: 'Valor inválido. Use o formato 50.000,00 ou 50000.', fields: {} }, f.querySelector('#gErr')); return; }
    try { await api('PUT', '/api/analytics/goals', { clinicMonthlyCents: clinic, byProfessional }); m.close(); toast('Metas salvas.'); notifyChange(); } catch (e) { showErrors(f, e, f.querySelector('#gErr')); }
  };
}

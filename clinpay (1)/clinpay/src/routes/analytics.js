'use strict';

/**
 * Dashboard analítico: indicadores (KPIs), faturamento, metas e funil.
 * Médico e funcionário veem só os números do próprio médico.
 */

const { HttpError, sendJson } = require('../http/core');
const { validate } = require('../validation');
const auth = require('../auth');
const { audit } = require('../audit');
const F = require('../domain/finance');
const S = require('../domain/surgeries');
const R = require('../domain/revenue');

const GOALS_KEY = 'goals';

function registerAnalytics(r, store, { requirePerm, query, readJsonBody }) {
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  async function getGoals() {
    const doc = await store.findOne('settings', (s) => s.key === GOALS_KEY);
    return { clinicMonthlyCents: null, byProfessional: {}, ...(doc ? doc.value : {}) };
  }

  /** Calcula todos os indicadores (usado pela tela e pela IA). q: URLSearchParams. */
  async function compute(u, q) {
    const scope = auth.proScope(u);
    const pro = scope || q.get('professionalId') || null;
    const now = new Date();
    const today = ymd(now);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(q.get('from') || '') ? q.get('from') : today.slice(0, 8) + '01';
    const to = /^\d{4}-\d{2}-\d{2}$/.test(q.get('to') || '') ? q.get('to') : today;
    if (from > to) throw new HttpError(422, 'Período inválido.');

    const [appts, charges, patients, quotes, leads, pros, expenses, procs] = await Promise.all([
      store.list('surgeries', (s) => (!pro || s.surgeonId === pro)),
      store.list('charges', (c) => (!pro || c.professionalId === pro)),
      store.list('patients'),
      store.list('quotes', (x) => (!pro || x.professionalId === pro)),
      store.list('leads', (l) => (!pro || !l.professionalId || l.professionalId === pro)),
      store.list('professionals'),
      store.list('expenses', (e) => e.status === 'pago' && (!pro || e.professionalId === pro)),
      store.list('procedures'),
    ]);
    const apptById = new Map(appts.map((a) => [a.id, a]));
    const quoteById = new Map(quotes.map((x) => [x.id, x]));
    const procById = new Map(procs.map((x) => [x.id, x]));
    const proName = new Map(pros.map((p) => [p.id, p.name]));

    // Faturamento recebido por dia
    const days = [];
    for (let d = new Date(`${from}T12:00:00`); ymd(d) <= to && days.length < 400; d.setDate(d.getDate() + 1)) days.push(ymd(d));
    const byDay = Object.fromEntries(days.map((d) => [d, 0]));
    const byMethod = {}; const byPro = {}; const byProcedure = {}; const byCategory = {}; const byOrigin = {};
    let received = 0;
    const maps = { appts: apptById, quotes: quoteById, procs: procById };
    for (const c of charges) {
      for (const p of F.activePayments(c)) {
        if (p.paidAt < from || p.paidAt > to) continue;
        received += p.amountCents;
        const src = R.chargeSources(c, maps);
        byOrigin[src.origin] = (byOrigin[src.origin] || 0) + p.amountCents;
        for (const part of R.allocatePayment(p.amountCents, src)) {
          byProcedure[part.name] = (byProcedure[part.name] || 0) + part.cents;
          const cat = part.category || 'Outros';
          byCategory[cat] = (byCategory[cat] || 0) + part.cents;
        }
        if (byDay[p.paidAt] !== undefined) byDay[p.paidAt] += p.amountCents;
        byMethod[p.method] = (byMethod[p.method] || 0) + p.amountCents;
        byPro[c.professionalId] = (byPro[c.professionalId] || 0) + p.amountCents;
      }
    }
    const openCents = charges.filter((c) => c.status !== 'cancelado').reduce((s, c) => s + F.balanceCents(c), 0);
    const overdueCents = charges.filter((c) => c.status !== 'cancelado' && c.dueDate < today).reduce((s, c) => s + F.balanceCents(c), 0);

    // Atendimentos no período
    const inPeriod = appts.filter((s) => s.date >= from && s.date <= to);
    const byStatus = {}; const byType = {};
    for (const s of inPeriod) { byStatus[s.status] = (byStatus[s.status] || 0) + 1; byType[s.type || 'cirurgia'] = (byType[s.type || 'cirurgia'] || 0) + 1; }
    const done = byStatus.concluida || 0; const noShow = byStatus.faltou || 0; const canceled = byStatus.cancelada || 0;
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

    // Funil e orçamentos
    const quotesInPeriod = quotes.filter((x) => x.createdAt.slice(0, 10) >= from && x.createdAt.slice(0, 10) <= to);
    const approved = quotesInPeriod.filter((x) => x.status === 'aprovado');
    const decided = quotesInPeriod.filter((x) => ['aprovado', 'recusado'].includes(x.status) || x.status === 'enviado');
    const leadsByStage = {}; const leadsBySource = {};
    for (const l of leads) { leadsByStage[l.stage] = (leadsByStage[l.stage] || 0) + 1; }
    for (const l of leads.filter((x) => x.createdAt.slice(0, 10) >= from && x.createdAt.slice(0, 10) <= to)) leadsBySource[l.source] = (leadsBySource[l.source] || 0) + 1;

    // Despesas pagas no período e lucro
    let expensesPaid = 0; const byExpense = {};
    for (const e of expenses) {
      if (e.paidAt < from || e.paidAt > to) continue;
      expensesPaid += e.amountCents;
      byExpense[e.category] = (byExpense[e.category] || 0) + e.amountCents;
    }
    const profit = received - expensesPaid;
    // Vendas: valor dos orçamentos criados no período, por situação
    const quoteValue = {};
    for (const x of quotesInPeriod) {
      const st = x.status === 'enviado' && x.validUntil < today ? 'vencido' : x.status;
      quoteValue[st] = (quoteValue[st] || 0) + x.totalCents;
    }
    const top = (obj, n = 8) => {
      const arr = Object.entries(obj).map(([label, cents]) => ({ label, cents })).sort((a, b) => b.cents - a.cents);
      if (arr.length <= n) return arr;
      const rest = arr.slice(n - 1).reduce((t, x) => t + x.cents, 0);
      return [...arr.slice(0, n - 1), { label: 'Outros', cents: rest }];
    };

    // Meta do mês corrente
    const goals = await getGoals();
    const goalCents = pro ? goals.byProfessional[pro] || null : goals.clinicMonthlyCents;
    const monthStart = today.slice(0, 8) + '01';
    let monthReceived = 0;
    for (const c of charges) for (const p of F.activePayments(c)) if (p.paidAt >= monthStart && p.paidAt <= today) monthReceived += p.amountCents;
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

    return {
      from, to, scoped: !!scope, professionalId: pro,
      kpis: {
        receivedCents: received,
        expensesPaidCents: expensesPaid,
        profitCents: profit,
        marginPct: received ? Math.round((profit / received) * 1000) / 10 : null,
        openCents, overdueCents,
        appointments: inPeriod.length,
        completed: done,
        avgTicketCents: done ? Math.round(received / done) : null,
        noShowRate: pct(noShow, done + noShow),
        cancelRate: pct(canceled, inPeriod.length),
        newPatients: patients.filter((p) => p.createdAt.slice(0, 10) >= from && p.createdAt.slice(0, 10) <= to).length,
        quotesApprovedCents: approved.reduce((s, x) => s + x.totalCents, 0),
        quoteConversion: pct(approved.length, decided.length),
      },
      revenueByDay: days.map((d) => ({ date: d, cents: byDay[d] })),
      byMethod: Object.entries(byMethod).map(([k, v]) => ({ key: k, label: F.METHODS[k], cents: v })).sort((a, b) => b.cents - a.cents),
      byProfessional: scope ? [] : Object.entries(byPro).map(([k, v]) => ({ key: k, label: proName.get(k) || '(profissional)', cents: v })).sort((a, b) => b.cents - a.cents),
      byStatus: Object.entries(byStatus).map(([k, v]) => ({ key: k, label: S.STATUS[k], count: v })),
      byType: Object.entries(byType).map(([k, v]) => ({ key: k, label: S.TYPES[k], count: v })),
      leadsByStage, leadsBySource,
      goal: {
        monthCents: goalCents, receivedMonthCents: monthReceived,
        progress: goalCents ? Math.round((monthReceived / goalCents) * 1000) / 10 : null,
        expectedProgress: Math.round((now.getDate() / daysInMonth) * 1000) / 10,
      },
      expensesByCategory: Object.entries(byExpense).map(([k, v]) => ({ key: k, label: F.EXPENSE_CATEGORIES[k], cents: v })).sort((a, b) => b.cents - a.cents),
      revenueByProcedure: top(byProcedure),
      revenueByCategory: top(byCategory),
      revenueByOrigin: Object.entries(byOrigin).map(([label, cents]) => ({ label, cents })).sort((a, b) => b.cents - a.cents),
      quotesByStatus: Object.entries(quoteValue).map(([k, v]) => ({ key: k, cents: v })),
      generatedAt: now.toISOString(),
    };
  }

  r.get('/api/analytics', async (req, res) => {
    const u = requirePerm(req, 'analytics:read');
    sendJson(res, 200, await compute(u, query(req)));
  });

  r.get('/api/analytics/goals', async (req, res) => {
    requirePerm(req, 'analytics:read');
    sendJson(res, 200, await getGoals());
  });

  r.put('/api/analytics/goals', async (req, res) => {
    const u = requirePerm(req, 'settings:manage');
    const body = await readJsonBody(req);
    const data = validate(body, { clinicMonthlyCents: { type: 'int', label: 'Meta da clínica', min: 0, max: 100000000000 } });
    const byProfessional = {};
    for (const [id, v] of Object.entries(body.byProfessional || {})) {
      if (v === null || v === '') continue;
      if (!Number.isInteger(v) || v < 0 || v > 100000000000) throw new HttpError(422, 'Meta inválida.', { byProfessional: 'Valor inválido.' });
      if (!(await store.get('professionals', id))) throw new HttpError(422, 'Médico da meta não encontrado.');
      byProfessional[id] = v;
    }
    const value = { clinicMonthlyCents: data.clinicMonthlyCents || null, byProfessional };
    const doc = await store.findOne('settings', (s) => s.key === GOALS_KEY);
    if (doc) await store.update('settings', doc.id, { value }); else await store.insert('settings', { key: GOALS_KEY, value });
    await audit(store, req, u, 'update', 'settings', null, 'Metas de faturamento atualizadas');
    sendJson(res, 200, value);
  });

  return { compute };
}

module.exports = { registerAnalytics };

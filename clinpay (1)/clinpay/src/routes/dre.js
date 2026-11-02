'use strict';

/**
 * DRE GERENCIAL — regime de CAIXA.
 * Considera só o que foi efetivamente RECEBIDO (pagamentos não estornados) e PAGO
 * (despesas pagas), na data do pagamento. Cobranças em aberto e contas a pagar não entram.
 *
 * Plano de contas (clínica odontológica):
 *   1   Receita bruta de serviços (por especialidade)
 *   2   (−) Deduções da receita
 *   =   Receita líquida
 *   3   (−) Custos dos serviços prestados
 *   =   Lucro bruto
 *   4   (−) Despesas operacionais
 *   =   Resultado operacional
 *   5   (−) Investimentos
 *   =   Resultado do período (geração de caixa)
 */

const { HttpError, sendJson } = require('../http/core');
const auth = require('../auth');
const F = require('../domain/finance');
const R = require('../domain/revenue');
const { CATALOG } = require('../domain/procedures-catalog');

const SPECIALTIES = [...new Set(CATALOG.map((c) => c[0]))];
const OTHER_REVENUE = '__outras__';

// Contas de despesa: código, nome e categorias de despesa que alimentam a conta
const EXPENSE_PLAN = [
  { code: '2', name: '(−) Deduções da receita', children: [
    { code: '2.1', name: 'Impostos sobre o faturamento (Simples Nacional, ISS)', cats: ['impostos'] },
    { code: '2.2', name: 'Taxas de cartão e bancárias', cats: ['taxas_bancarias'] },
  ] },
  { code: '3', name: '(−) Custos dos serviços prestados', children: [
    { code: '3.1', name: 'Laboratório de prótese', cats: ['laboratorio'] },
    { code: '3.2', name: 'Materiais odontológicos', cats: ['materiais'] },
    { code: '3.3', name: 'Esterilização e descartáveis', cats: ['esterilizacao'] },
    { code: '3.4', name: 'Comissões e repasses a profissionais', cats: ['comissoes'] },
  ] },
  { code: '4', name: '(−) Despesas operacionais', children: [
    { code: '4.1', name: 'Pessoal', children: [{ code: '4.1.1', name: 'Salários e pró-labore', cats: ['salarios'] }] },
    { code: '4.2', name: 'Ocupação', children: [
      { code: '4.2.1', name: 'Aluguel e condomínio', cats: ['aluguel'] },
      { code: '4.2.2', name: 'Água, luz, telefone e internet', cats: ['contas'] },
      { code: '4.2.3', name: 'Manutenção', cats: ['manutencao'] },
    ] },
    { code: '4.3', name: 'Administrativas', children: [
      { code: '4.3.1', name: 'Sistemas e software', cats: ['software'] },
      { code: '4.3.2', name: 'Contabilidade', cats: ['contabilidade'] },
      { code: '4.3.3', name: 'Outras despesas', cats: ['outros'] },
    ] },
    { code: '4.4', name: 'Comerciais', children: [{ code: '4.4.1', name: 'Marketing e anúncios', cats: ['marketing'] }] },
  ] },
  { code: '5', name: '(−) Investimentos', children: [{ code: '5.1', name: 'Equipamentos', cats: ['equipamentos'] }] },
];

// Toda categoria de despesa precisa cair em alguma conta; o que não estiver mapeado vai para "Outras despesas"
const CAT_TO_ACCOUNT = {};
(function walk(nodes) { for (const n of nodes) { if (n.cats) n.cats.forEach((c) => { CAT_TO_ACCOUNT[c] = n.code; }); if (n.children) walk(n.children); } })(EXPENSE_PLAN);
const accountForCategory = (cat) => CAT_TO_ACCOUNT[cat] || '4.3.3';

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return ymd(new Date(y, m - 1, d + n)); };
const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000) + 1;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

function registerDre(r, store, { requirePerm, query }) {
  /** Valores de cada conta-folha num período (receitas positivas, saídas negativas). */
  function computeColumn(data, from, to) {
    const revenue = {}; const accounts = {};
    let payments = 0; let expensesCount = 0;
    for (const c of data.charges) {
      for (const p of F.activePayments(c)) {
        if (p.paidAt < from || p.paidAt > to) continue;
        payments++;
        for (const part of R.allocatePayment(p.amountCents, R.chargeSources(c, data.maps))) {
          const key = part.category || OTHER_REVENUE;
          revenue[key] = (revenue[key] || 0) + part.cents;
        }
      }
    }
    for (const e of data.expenses) {
      if (e.paidAt < from || e.paidAt > to) continue;
      expensesCount++;
      const acc = accountForCategory(e.category);
      accounts[acc] = (accounts[acc] || 0) - e.amountCents;
    }
    return { revenue, accounts, payments, expensesCount };
  }

  /** Monta as linhas da DRE (contas, subtotais e resultados) para várias colunas. */
  function buildLines(cols) {
    const lines = [];
    const sum = (arrs) => cols.map((_, i) => arrs.reduce((s, a) => s + a[i], 0));
    // Receitas: especialidades do catálogo na ordem, depois outras categorias, por fim "outras receitas"
    const present = new Set(cols.flatMap((c) => Object.keys(c.revenue)));
    const keys = [
      ...SPECIALTIES.filter((k) => present.has(k)),
      ...[...present].filter((k) => k !== OTHER_REVENUE && !SPECIALTIES.includes(k)).sort((a, b) => a.localeCompare(b, 'pt-BR')),
      ...(present.has(OTHER_REVENUE) ? [OTHER_REVENUE] : []),
    ];
    const revLines = keys.map((k, i) => ({
      code: k === OTHER_REVENUE ? '1.99' : `1.${pad(i + 1)}`, level: 1, type: 'account',
      name: k === OTHER_REVENUE ? 'Outras receitas (avulsas e sem especialidade)' : k,
      values: cols.map((c) => c.revenue[k] || 0),
    }));
    const gross = sum(revLines.map((l) => l.values));
    lines.push({ code: '1', level: 0, type: 'group', name: 'Receita bruta de serviços', values: gross }, ...revLines);

    const groupValues = {};
    const emit = (node, level) => {
      if (node.cats) {
        const values = cols.map((c) => c.accounts[node.code] || 0);
        lines.push({ code: node.code, level, type: 'account', name: node.name, values });
        return values;
      }
      const idx = lines.length;
      lines.push(null); // reservado para o total do grupo
      const values = sum(node.children.map((ch) => emit(ch, level + 1)));
      lines[idx] = { code: node.code, level, type: 'group', name: node.name, values };
      return values;
    };
    const result = (code, name, values) => lines.push({ code, level: 0, type: 'result', name, values });

    groupValues[2] = emit(EXPENSE_PLAN[0], 0);
    const net = sum([gross, groupValues[2]]);
    result('RL', '= Receita líquida', net);
    groupValues[3] = emit(EXPENSE_PLAN[1], 0);
    const grossProfit = sum([net, groupValues[3]]);
    result('LB', '= Lucro bruto', grossProfit);
    groupValues[4] = emit(EXPENSE_PLAN[2], 0);
    const operating = sum([grossProfit, groupValues[4]]);
    result('RO', '= Resultado operacional', operating);
    groupValues[5] = emit(EXPENSE_PLAN[3], 0);
    const final = sum([operating, groupValues[5]]);
    result('RP', '= Resultado do período (geração de caixa)', final);
    return { lines, gross, final };
  }

  r.get('/api/finance/dre', async (req, res) => {
    const u = requirePerm(req, 'finance:read');
    const q = query(req);
    const scope = auth.proScope(u);
    const pro = scope || q.get('professionalId') || null;
    const mode = q.get('mode') === 'mensal' ? 'mensal' : 'periodo';
    const today = ymd(new Date());

    let columns;
    if (mode === 'mensal') {
      const year = /^\d{4}$/.test(q.get('year') || '') ? Number(q.get('year')) : new Date().getFullYear();
      if (year < 2000 || year > 2100) throw new HttpError(422, 'Ano inválido.');
      const names = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
      columns = names.map((n, i) => ({ label: `${n}/${String(year).slice(2)}`, from: `${year}-${pad(i + 1)}-01`, to: ymd(new Date(year, i + 1, 0)) }));
    } else {
      const from = isDate(q.get('from')) ? q.get('from') : today.slice(0, 8) + '01';
      const to = isDate(q.get('to')) ? q.get('to') : today;
      if (from > to) throw new HttpError(422, 'A data inicial deve ser anterior à final.');
      if (daysBetween(from, to) > 3660) throw new HttpError(422, 'Período longo demais (máximo de 10 anos).');
      const len = daysBetween(from, to);
      const prevTo = addDays(from, -1);
      columns = [{ label: 'Período', from, to }, { label: 'Período anterior', from: addDays(prevTo, -(len - 1)), to: prevTo }];
    }

    const [charges, expenses, appts, quotes, procs] = await Promise.all([
      store.list('charges', (c) => !pro || c.professionalId === pro),
      store.list('expenses', (e) => e.status === 'pago' && (!pro || e.professionalId === pro)),
      store.list('surgeries'), store.list('quotes'), store.list('procedures'),
    ]);
    const data = {
      charges, expenses,
      maps: { appts: new Map(appts.map((x) => [x.id, x])), quotes: new Map(quotes.map((x) => [x.id, x])), procs: new Map(procs.map((x) => [x.id, x])) },
    };
    const computed = columns.map((c) => computeColumn(data, c.from, c.to));
    if (mode === 'mensal') {
      // Coluna "Total do ano" = soma dos meses
      const total = { revenue: {}, accounts: {}, payments: 0, expensesCount: 0 };
      for (const c of computed) {
        for (const [k, v] of Object.entries(c.revenue)) total.revenue[k] = (total.revenue[k] || 0) + v;
        for (const [k, v] of Object.entries(c.accounts)) total.accounts[k] = (total.accounts[k] || 0) + v;
        total.payments += c.payments; total.expensesCount += c.expensesCount;
      }
      computed.push(total);
      columns.push({ label: 'Total', from: columns[0].from, to: columns[11].to });
    }
    const { lines, gross } = buildLines(computed);
    const ref = mode === 'mensal' ? columns.length - 1 : 0; // coluna de referência da análise vertical
    for (const l of lines) {
      l.av = gross[ref] ? Math.round((l.values[ref] / gross[ref]) * 1000) / 10 : null;
      if (mode === 'periodo') {
        const [cur, prev] = l.values;
        l.ah = prev ? Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10 : null;
      }
    }
    const proDoc = pro ? await store.get('professionals', pro) : null;
    sendJson(res, 200, {
      basis: 'caixa', mode, columns, lines,
      professional: proDoc ? { id: proDoc.id, name: proDoc.name } : null,
      counts: computed.map((c) => ({ payments: c.payments, expenses: c.expensesCount })),
      notes: [
        'Regime de caixa: considera apenas valores efetivamente recebidos e pagos, na data do pagamento.',
        'Cobranças em aberto e despesas ainda não pagas não entram. Pagamentos estornados são excluídos.',
        'A receita de orçamentos é dividida entre as especialidades pelo valor de cada item.',
        pro ? 'Filtrado por médico: inclui só as despesas ligadas a ele (despesas gerais da clínica ficam de fora).' : null,
      ].filter(Boolean),
    });
  });
}

module.exports = { registerDre, EXPENSE_PLAN, accountForCategory };

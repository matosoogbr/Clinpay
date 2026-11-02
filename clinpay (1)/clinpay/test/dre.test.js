'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');
const { splitCents } = require('../src/domain/revenue');
const { accountForCategory } = require('../src/routes/dre');
const F = require('../src/domain/finance');

let app; let base;
const jars = {};
async function call(who, method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: jars[who] || '' }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie'); if (set) jars[who] = set.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = ymd(new Date());
const yesterday = ymd(new Date(Date.now() - 86400000));
const ids = {};
const line = (dre, code) => dre.lines.find((l) => l.code === code);
const lineByName = (dre, name) => dre.lines.find((l) => l.name === name);

before(async () => {
  app = createServer();
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.address().port}`;
  await call('root', 'POST', '/api/setup', { name: 'Dono', email: 'root@clinpay.com', password: 'SenhaForte2026' });
  await call('root', 'POST', '/api/platform/clinics', { name: 'Clínica DRE', owner: { name: 'Dra. Dona', email: 'dona@dre.com', password: 'DonaSenha2026' } });
  await call('adm', 'POST', '/api/login', { email: 'dona@dre.com', password: 'DonaSenha2026' });
  ids.pro = (await call('adm', 'GET', '/api/professionals')).body[0].id;
  ids.pro2 = (await call('adm', 'POST', '/api/users', { name: 'Dr. Outro', email: 'outro@dre.com', role: 'medico', password: 'OutroSenha2026', newProfessional: {} })).body.professionalId;
  await call('adm', 'POST', '/api/users', { name: 'Fran Func', email: 'fran@dre.com', role: 'funcionario', password: 'FranSenha2026', professionalId: ids.pro });
  await call('func', 'POST', '/api/login', { email: 'fran@dre.com', password: 'FranSenha2026' });
  ids.p = (await call('adm', 'POST', '/api/patients', { name: 'Paciente', birthDate: '1990-01-01', sex: 'F', noKnownAllergies: true })).body.id;
  const procs = (await call('adm', 'GET', '/api/procedures')).body;
  ids.canal = procs.find((p) => p.name === 'Tratamento de canal — molar');
  ids.implante = procs.find((p) => p.name === 'Implante dentário unitário');
  ids.coroa = procs.find((p) => p.name === 'Coroa sobre implante');

  const pay = (chargeId, cents, paidAt = today) => call('adm', 'POST', `/api/finance/charges/${chargeId}/payments`, { amountCents: cents, method: 'pix', paidAt });
  // Consulta de canal (Endodontia) R$ 900,00 paga hoje
  const c1 = await call('adm', 'POST', '/api/surgeries', { type: 'consulta', patientId: ids.p, procedureId: ids.canal.id, procedureName: ids.canal.name, surgeonId: ids.pro, date: today, startTime: '22:00', durationMin: 60, priority: 'eletiva', coverage: 'particular', priceCents: 90000 });
  await pay(c1.body.charge.id, 90000);
  // Orçamento: implante R$ 3.000 + coroa R$ 1.000; paga R$ 1.000,01 (rateio 75% / 25%)
  const valid = ymd(new Date(Date.now() + 10 * 86400000));
  const q = await call('adm', 'POST', '/api/crm/quotes', { patientId: ids.p, professionalId: ids.pro, validUntil: valid, method: 'pix', items: [
    { name: ids.implante.name, procedureId: ids.implante.id, qty: 1, unitCents: 300000 }, { name: ids.coroa.name, procedureId: ids.coroa.id, qty: 1, unitCents: 100000 }] });
  const ap = await call('adm', 'POST', `/api/crm/quotes/${q.body.id}/status`, { status: 'aprovado' });
  await pay(ap.body.chargeId, 100001);
  // Cobrança avulsa R$ 50,00 hoje e R$ 20,00 ontem
  const av = await call('adm', 'POST', '/api/finance/charges', { patientId: ids.p, professionalId: ids.pro, description: 'Relatório', amountCents: 10000, dueDate: today, method: 'pix' });
  await pay(av.body.id, 5000);
  await pay(av.body.id, 2000, yesterday);
  // Pagamento estornado: não entra
  const c2 = await call('adm', 'POST', '/api/surgeries', { type: 'consulta', patientId: ids.p, procedureId: ids.canal.id, procedureName: ids.canal.name, surgeonId: ids.pro, date: today, startTime: '23:00', durationMin: 30, priority: 'eletiva', coverage: 'particular', priceCents: 40000 });
  const paid = await pay(c2.body.charge.id, 40000);
  await call('adm', 'POST', `/api/finance/charges/${c2.body.charge.id}/payments/${paid.body.payments[0].id}/reverse`, { reason: 'Lançado errado' });
  // Receita do outro médico (só para o teste de filtro)
  const o = await call('adm', 'POST', '/api/finance/charges', { patientId: ids.p, professionalId: ids.pro2, description: 'Outro médico', amountCents: 7000, dueDate: today, method: 'pix' });
  await pay(o.body.id, 7000);
  // Despesas
  const exp = (category, amountCents, extra = {}) => call('adm', 'POST', '/api/finance/expenses', { description: category, category, amountCents, dueDate: today, paidAt: today, method: 'pix', ...extra });
  await exp('impostos', 6000);
  await exp('taxas_bancarias', 1500);
  await exp('laboratorio', 30000, { professionalId: ids.pro });
  await exp('aluguel', 50000);
  await exp('equipamentos', 20000);
  await call('adm', 'POST', '/api/finance/expenses', { description: 'Anúncio a pagar', category: 'marketing', amountCents: 9999, dueDate: today }); // em aberto: não entra
  const cx = await exp('software', 3000);
  await call('adm', 'POST', `/api/finance/expenses/${cx.body.id}/cancel`, { reason: 'Lançado em duplicidade' }); // cancelada: não entra
});
after(() => app.close());

test('rateio de centavos é exato', () => {
  assert.deepEqual(splitCents(100001, [300000, 100000]), [75001, 25000]);
  assert.deepEqual(splitCents(100, [1, 1, 1]), [34, 33, 33]);
  for (const [v, w] of [[99999, [3, 7, 11]], [1, [1, 1]], [123457, [5, 5, 5, 5, 5, 5, 5]]]) {
    assert.equal(splitCents(v, w).reduce((s, x) => s + x, 0), v);
  }
});

test('toda categoria de despesa tem conta no plano de contas', () => {
  for (const cat of Object.keys(F.EXPENSE_CATEGORIES)) assert.ok(accountForCategory(cat), cat);
  assert.equal(accountForCategory('laboratorio'), '3.1');
  assert.equal(accountForCategory('equipamentos'), '5.1');
});

test('DRE do período: valores, subtotais e resultado', async () => {
  const d = (await call('adm', 'GET', `/api/finance/dre?from=${today}&to=${today}`)).body;
  assert.equal(d.basis, 'caixa');
  const v = (code) => line(d, code).values[0];
  // Receita: 900 + 1.000,01 + 50 + 70 (outro médico) = 2.020,01
  assert.equal(v('1'), 202001);
  assert.equal(lineByName(d, 'Endodontia').values[0], 90000);
  assert.equal(lineByName(d, 'Implantodontia').values[0], 75001);
  assert.equal(lineByName(d, 'Prótese').values[0], 25000);
  assert.equal(line(d, '1.99').values[0], 12000);
  assert.equal(v('2'), -7500);
  assert.equal(v('2.1'), -6000);
  assert.equal(v('RL'), 194501);
  assert.equal(v('3'), -30000);
  assert.equal(v('LB'), 164501);
  assert.equal(v('4'), -50000); // anúncio em aberto e software cancelado ficam de fora
  assert.equal(v('4.2.1'), -50000);
  assert.equal(v('RO'), 114501);
  assert.equal(v('5'), -20000);
  assert.equal(v('RP'), 94501);
  // Análise vertical e horizontal
  assert.equal(lineByName(d, 'Endodontia').av, 44.6);
  assert.equal(line(d, '1').av, 100);
  assert.equal(line(d, '1').values[1], 2000); // ontem
  assert.equal(line(d, '1').ah, 10000.1);
  // Ordem: receitas, deduções, receita líquida, custos, lucro bruto, despesas, resultado operacional, investimentos, resultado
  const order = d.lines.filter((l) => l.level === 0).map((l) => l.code);
  assert.deepEqual(order, ['1', '2', 'RL', '3', 'LB', '4', 'RO', '5', 'RP']);
});

test('DRE bate com os indicadores', async () => {
  const d = (await call('adm', 'GET', `/api/finance/dre?from=${today}&to=${today}`)).body;
  const a = (await call('adm', 'GET', `/api/analytics?from=${today}&to=${today}`)).body;
  assert.equal(a.kpis.receivedCents, line(d, '1').values[0]);
  const endo = a.revenueByCategory.find((x) => x.label === 'Endodontia');
  assert.equal(endo.cents, 90000);
});

test('visão mensal: coluna do mês e total do ano', async () => {
  const year = today.slice(0, 4);
  const d = (await call('adm', 'GET', `/api/finance/dre?mode=mensal&year=${year}`)).body;
  assert.equal(d.columns.length, 13);
  assert.equal(d.columns[12].label, 'Total');
  const m = Number(today.slice(5, 7)) - 1;
  const total = line(d, '1').values[12];
  assert.equal(total, line(d, '1').values.slice(0, 12).reduce((s, x) => s + x, 0));
  assert.ok(line(d, '1').values[m] >= 202001);
  assert.equal(line(d, 'RP').values[12], line(d, 'RP').values.slice(0, 12).reduce((s, x) => s + x, 0));
});

test('médico e funcionário veem só o próprio resultado', async () => {
  const d = (await call('func', 'GET', `/api/finance/dre?from=${today}&to=${today}&professionalId=${ids.pro2}`)).body;
  assert.equal(d.professional.id, ids.pro);
  assert.equal(line(d, '1').values[0], 195001); // sem os R$ 70 do outro médico
  assert.equal(line(d, '3').values[0], -30000); // laboratório ligado ao médico
  assert.equal(line(d, '4').values[0], 0); // aluguel é da clínica: fica de fora
  assert.ok(d.notes.some((n) => n.includes('Filtrado por médico')));
});

test('validações de período', async () => {
  assert.equal((await call('adm', 'GET', '/api/finance/dre?from=2026-12-01&to=2026-01-01')).status, 422);
  assert.equal((await call('adm', 'GET', '/api/finance/dre?mode=mensal&year=1500')).status, 422);
});

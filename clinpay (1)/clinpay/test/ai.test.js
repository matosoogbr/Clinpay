'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');
const { callClaude } = require('../src/ai');

let app; let base;
const jars = {};
const sentToAi = [];
async function call(who, method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: jars[who] || '' }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie'); if (set) jars[who] = set.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}
const login = (who, email, password) => call(who, 'POST', '/api/login', { email, password });
const pad = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const ids = {};

before(async () => {
  app = createServer(undefined, { ai: { apiKey: 'chave-teste', call: async (req) => { sentToAi.push(req); return 'Resposta simulada da IA.'; } } });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.address().port}`;
  await call('root', 'POST', '/api/setup', { name: 'Dono', email: 'root@clinpay.com', password: 'SenhaForte2026' });
  await call('root', 'POST', '/api/platform/clinics', { name: 'Sorriso Feliz', owner: { name: 'Dra. Dona', email: 'dona@sorriso.com', password: 'DonaSenha2026' } });
  await login('adm', 'dona@sorriso.com', 'DonaSenha2026');
  ids.pro = (await call('adm', 'GET', '/api/professionals')).body[0].id;
  await call('adm', 'POST', '/api/users', { name: 'Fran Func', email: 'fran@sorriso.com', role: 'funcionario', password: 'FranSenha2026', professionalId: ids.pro });
  await login('func', 'fran@sorriso.com', 'FranSenha2026');
  ids.p = (await call('adm', 'POST', '/api/patients', { name: 'Joana Secreta Silva', birthDate: '1990-01-01', sex: 'F', cpf: '529.982.247-25', allergies: 'Penicilina', phone: '31999990000' })).body.id;
  await call('adm', 'POST', `/api/patients/${ids.p}/notes`, { text: 'Dor no dente 46 ao mastigar.' });
});
after(() => app.close());

test('cliente da API: envia no formato oficial e trata erros', async () => {
  let sent;
  const text = await callClaude({ apiKey: 'k', model: 'claude-sonnet-5-5', system: 'S', messages: [{ role: 'user', content: 'oi' }] },
    async (url, opt) => { sent = { url, opt }; return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'olá' }] }) }; });
  assert.equal(text, 'olá');
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent.opt.headers['x-api-key'], 'k');
  assert.equal(sent.opt.headers['anthropic-version'], '2023-06-01');
  assert.equal(JSON.parse(sent.opt.body).system, 'S');
  await assert.rejects(callClaude({ apiKey: 'k', model: 'm', system: 's', messages: [] }, async () => ({ ok: false, status: 401, json: async () => ({}) })), /chave da IA é inválida/);
});

test('IA começa desativada e só o médico responsável ativa', async () => {
  const r = await call('func', 'POST', '/api/ai/chat', { messages: [{ role: 'user', content: 'Oi' }] });
  assert.equal(r.status, 409);
  assert.equal((await call('func', 'PUT', '/api/settings/ai', { enabled: true })).status, 403);
  const noTerms = await call('adm', 'PUT', '/api/settings/ai', { enabled: true, allowPatientData: true });
  assert.equal(noTerms.status, 422);
  const ok = await call('adm', 'PUT', '/api/settings/ai', { enabled: true, dailyLimit: 3 });
  assert.equal(ok.body.enabled, true);
  assert.equal(ok.body.allowPatientData, false);
});

test('conversa geral e de indicadores; dados de paciente bloqueados por padrão', async () => {
  const g = await call('func', 'POST', '/api/ai/chat', { messages: [{ role: 'user', content: 'Escreva um lembrete de consulta.' }] });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.equal(g.body.reply, 'Resposta simulada da IA.');
  assert.match(sentToAi.at(-1).system, /NÃO faz diagnóstico/);
  const k = await call('adm', 'POST', '/api/ai/chat', { context: 'indicadores', messages: [{ role: 'user', content: 'Como estão as vendas?' }] });
  assert.equal(k.status, 200);
  assert.match(sentToAi.at(-1).system, /Recebido: R\$/);
  const p = await call('adm', 'POST', '/api/ai/chat', { context: 'paciente', patientId: ids.p, messages: [{ role: 'user', content: 'Resuma.' }] });
  assert.equal(p.status, 403);
  // Mensagens fora de ordem ou longas demais
  assert.equal((await call('adm', 'POST', '/api/ai/chat', { messages: [{ role: 'assistant', content: 'x' }] })).status, 422);
  assert.equal((await call('adm', 'POST', '/api/ai/chat', { messages: [{ role: 'user', content: 'x'.repeat(4001) }] })).status, 422);
});

test('limite diário por clínica', async () => {
  // Já foram 2 perguntas; a 3ª ainda passa e a 4ª é bloqueada
  assert.equal((await call('adm', 'POST', '/api/ai/chat', { messages: [{ role: 'user', content: 'Terceira' }] })).status, 200);
  const r = await call('adm', 'POST', '/api/ai/chat', { messages: [{ role: 'user', content: 'Quarta' }] });
  assert.equal(r.status, 429);
  assert.match(r.body.error, /limite diário de 3/);
});

test('prontuário para a IA: só com termo aceito, só para quem acessa prontuário, e sem identificação', async () => {
  await call('adm', 'PUT', '/api/settings/ai', { enabled: true, dailyLimit: 50, allowPatientData: true, acceptPatientDataTerms: true });
  assert.equal((await call('func', 'POST', '/api/ai/chat', { context: 'paciente', patientId: ids.p, messages: [{ role: 'user', content: 'Resuma.' }] })).status, 403);
  const r = await call('adm', 'POST', '/api/ai/chat', { context: 'paciente', patientId: ids.p, messages: [{ role: 'user', content: 'Resuma o histórico.' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const sys = sentToAi.at(-1).system;
  assert.match(sys, /Penicilina/);
  assert.match(sys, /dente 46/);
  for (const secret of ['Joana', 'Secreta', '52998224725', '529.982', '31999990000']) assert.ok(!sys.includes(secret), `vazou ${secret}`);
  const audit = (await call('adm', 'GET', '/api/audit')).body;
  assert.ok(audit.some((a) => a.action === 'ai' && a.entityId === ids.p));
  // Paciente do portal não usa a IA
  await call('adm', 'POST', `/api/patients/${ids.p}/portal`, { email: 'joana@x.com', password: 'JoanaSenha2026' });
  await login('pac', 'joana@x.com', 'JoanaSenha2026');
  assert.equal((await call('pac', 'POST', '/api/ai/chat', { messages: [{ role: 'user', content: 'oi' }] })).status, 403);
});

test('despesas, lucro e receita por procedimento', async () => {
  const procs = (await call('adm', 'GET', '/api/procedures')).body;
  const canal = procs.find((p) => p.name === 'Tratamento de canal — molar');
  const c = await call('adm', 'POST', '/api/surgeries', { type: 'consulta', patientId: ids.p, procedureId: canal.id, procedureName: canal.name, surgeonId: ids.pro, date: today(), startTime: '23:00', durationMin: 60, priority: 'eletiva', coverage: 'particular', priceCents: 90000 });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  await call('adm', 'POST', `/api/finance/charges/${c.body.charge.id}/payments`, { amountCents: 90000, method: 'pix', paidAt: today() });
  assert.equal((await call('adm', 'POST', '/api/finance/expenses', { description: 'Lab', category: 'xyz', amountCents: 100, dueDate: today() })).status, 422);
  const e1 = await call('adm', 'POST', '/api/finance/expenses', { description: 'Laboratório — coroa', category: 'laboratorio', amountCents: 25000, dueDate: today(), paidAt: today(), method: 'pix' });
  assert.equal(e1.body.status, 'pago');
  const e2 = await call('adm', 'POST', '/api/finance/expenses', { description: 'Aluguel', category: 'aluguel', amountCents: 30000, dueDate: today() });
  assert.equal(e2.body.status, 'aberto');
  // Funcionário: despesa fica ligada ao médico dele, e ele não vê as despesas gerais
  const ef = await call('func', 'POST', '/api/finance/expenses', { description: 'Material', category: 'materiais', amountCents: 5000, dueDate: today(), professionalId: 'outro' });
  assert.equal(ef.body.professionalId, ids.pro);
  assert.ok((await call('func', 'GET', '/api/finance/expenses')).body.every((x) => x.professionalId === ids.pro));
  assert.equal((await call('func', 'POST', `/api/finance/expenses/${e2.body.id}/pay`, { paidAt: today(), method: 'pix' })).status, 404);
  await call('adm', 'POST', `/api/finance/expenses/${e2.body.id}/pay`, { paidAt: today(), method: 'transferencia' });
  const a = (await call('adm', 'GET', `/api/analytics?from=${today()}&to=${today()}`)).body;
  assert.equal(a.kpis.receivedCents, 90000);
  assert.equal(a.kpis.expensesPaidCents, 55000);
  assert.equal(a.kpis.profitCents, 35000);
  assert.equal(a.revenueByProcedure[0].label, 'Tratamento de canal — molar');
  assert.equal(a.revenueByCategory[0].label, 'Endodontia');
  assert.equal(a.revenueByOrigin[0].label, 'Consultas');
  assert.ok(a.expensesByCategory.some((x) => x.key === 'aluguel'));
  const sum = (await call('adm', 'GET', `/api/finance/summary?from=${today()}&to=${today()}`)).body;
  assert.equal(sum.profitCents, 35000);
});

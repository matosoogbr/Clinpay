'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');
const { sendWhatsApp, toE164 } = require('../src/whatsapp');

let app; let base;
const jars = {};
const waSent = [];
async function call(who, method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: jars[who] || '' }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie'); if (set) jars[who] = set.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}
const login = (who, email, password) => call(who, 'POST', '/api/login', { email, password });
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => ymd(new Date());
const nextMonday = () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7) + 7); return ymd(d); };
const PNG = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString('base64');
const ids = {};

before(async () => {
  app = createServer(undefined, { notifier: { sendWa: async (cfg, msg) => { waSent.push(msg); } } });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.address().port}`;
  await call('root', 'POST', '/api/setup', { name: 'Dono', email: 'root@clinpay.com', password: 'SenhaForte2026' });
  await call('root', 'POST', '/api/platform/clinics', { name: 'Clínica Sorriso', owner: { name: 'Dra. Dona', email: 'dona@sorriso.com', password: 'DonaSenha2026' } });
  await login('adm', 'dona@sorriso.com', 'DonaSenha2026');
  ids.pro = (await call('adm', 'GET', '/api/professionals')).body[0].id;
  await call('adm', 'POST', '/api/users', { name: 'Dr. Leo', email: 'leo@sorriso.com', role: 'medico', password: 'LeoSenha2026', newProfessional: {} });
  await call('adm', 'POST', '/api/users', { name: 'Fran Func', email: 'fran@sorriso.com', role: 'funcionario', password: 'FranSenha2026', professionalId: ids.pro });
  await login('med', 'leo@sorriso.com', 'LeoSenha2026');
  await login('func', 'fran@sorriso.com', 'FranSenha2026');
  ids.p1 = (await call('adm', 'POST', '/api/patients', { name: 'Paula Paciente', birthDate: '1990-02-02', sex: 'F', noKnownAllergies: true, phone: '(31) 99999-1234', whatsappReminders: true })).body.id;
  ids.p2 = (await call('adm', 'POST', '/api/patients', { name: 'Outro Paciente', birthDate: '1980-02-02', sex: 'M', noKnownAllergies: true })).body.id;
});
after(() => app.close());

test('catálogo odontológico já vem na clínica nova, sem duplicar ao importar de novo', async () => {
  const procs = (await call('adm', 'GET', '/api/procedures')).body;
  assert.ok(procs.length > 140, `vieram ${procs.length}`);
  assert.ok(procs.some((p) => p.name === 'Tratamento de canal — molar' && p.category === 'Endodontia'));
  assert.ok(procs.some((p) => p.name === 'Implante dentário unitário' && p.kind === 'cirurgia'));
  const b = await call('adm', 'POST', '/api/procedures/import-default', {});
  assert.equal(b.body.added, 0);
  const bad = await call('adm', 'POST', '/api/procedures/import', { rows: [{ name: 'Ok' }, { name: '' }] });
  assert.equal(bad.status, 422);
  const ok = await call('adm', 'POST', '/api/procedures/import', { rows: [{ name: 'Procedimento TUSS X', code: '10101012', priceCents: 15000 }] });
  assert.equal(ok.body.added, 1);
  assert.equal((await call('func', 'POST', '/api/procedures/import-default', {})).status, 403);
});

test('prontuário: só profissionais de saúde; registros não são editáveis', async () => {
  assert.equal((await call('func', 'GET', `/api/patients/${ids.p1}/notes`)).status, 403);
  assert.equal((await call('func', 'POST', `/api/patients/${ids.p1}/notes`, { text: 'tentativa' })).status, 403);
  const n = await call('med', 'POST', `/api/patients/${ids.p1}/notes`, { text: 'Paciente relata dor ao mastigar.' });
  assert.equal(n.status, 201);
  assert.equal((await call('med', 'PUT', `/api/patients/${ids.p1}/notes`, { text: 'x' })).status, 405);
  const add = await call('med', 'POST', `/api/patients/${ids.p1}/notes`, { text: 'Correção: dor no lado direito.', addendumOf: n.body.id });
  assert.equal(add.body.kind, 'adendo');
  const list = (await call('adm', 'GET', `/api/patients/${ids.p1}/notes`)).body;
  assert.equal(list.length, 2);
});

test('arquivos: aceita imagem real, recusa arquivo disfarçado', async () => {
  const ok = await call('med', 'POST', `/api/patients/${ids.p1}/files`, { kind: 'radiografia', name: 'panoramica.png', dataUrl: PNG });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.dataUrl, undefined);
  const fake = await call('med', 'POST', `/api/patients/${ids.p1}/files`, { kind: 'foto', name: 'x.png', dataUrl: 'data:image/png;base64,' + Buffer.from('MZ executável').toString('base64') });
  assert.equal(fake.status, 422);
  const exe = await call('med', 'POST', `/api/patients/${ids.p1}/files`, { kind: 'foto', name: 'x.exe', dataUrl: 'data:application/x-msdownload;base64,AAAA' });
  assert.equal(exe.status, 422);
});

test('odontograma com histórico', async () => {
  assert.equal((await call('med', 'PUT', `/api/patients/${ids.p1}/odontogram/99`, { status: 'carie' })).status, 404);
  await call('med', 'PUT', `/api/patients/${ids.p1}/odontogram/36`, { status: 'carie' });
  const o = (await call('med', 'PUT', `/api/patients/${ids.p1}/odontogram/36`, { status: 'restaurado', notes: 'Resina' })).body;
  assert.equal(o.teeth['36'].status, 'restaurado');
  assert.equal(o.history[0].from, 'carie');
  assert.equal(o.history.length, 2);
});

test('exames: paciente só vê os próprios, depois de liberados, sem observação interna', async () => {
  const e = await call('med', 'POST', `/api/patients/${ids.p1}/exams`, { title: 'Hemograma', category: 'laboratorial', examDate: today(), internalNotes: 'NÃO MOSTRAR' });
  ids.exam = e.body.id;
  assert.equal((await call('med', 'POST', `/api/exams/${ids.exam}/release`, { released: true })).status, 422); // sem resultado
  await call('med', 'PUT', `/api/exams/${ids.exam}`, { resultText: 'Hemoglobina 13,5 g/dL (normal).' });
  const f = await call('med', 'POST', `/api/patients/${ids.p1}/files`, { kind: 'exame', name: 'hemograma.png', dataUrl: PNG, examId: ids.exam });
  ids.examFile = f.body.id;
  // Exame de outro paciente, liberado
  const e2 = await call('med', 'POST', `/api/patients/${ids.p2}/exams`, { title: 'Glicemia', category: 'laboratorial', examDate: today(), resultText: '90' });
  const f2 = await call('med', 'POST', `/api/patients/${ids.p2}/files`, { kind: 'exame', name: 'g.png', dataUrl: PNG, examId: e2.body.id });
  await call('med', 'POST', `/api/exams/${e2.body.id}/release`, { released: true });
  // Funcionário não libera exame
  assert.equal((await call('func', 'POST', `/api/exams/${ids.exam}/release`, { released: true })).status, 403);

  // Acesso ao portal criado pela recepção/funcionário
  const weak = await call('func', 'POST', `/api/patients/${ids.p1}/portal`, { email: 'paula@email.com', password: '123' });
  assert.equal(weak.status, 422);
  assert.equal((await call('func', 'POST', `/api/patients/${ids.p1}/portal`, { email: 'paula@email.com', password: 'PaulaSenha2026' })).status, 200);
  assert.ok((await call('adm', 'GET', '/api/users')).body.every((u) => u.role !== 'paciente'));
  await login('pac', 'paula@email.com', 'PaulaSenha2026');
  const me = (await call('pac', 'GET', '/api/me')).body;
  assert.deepEqual(me.permissions, ['portal:access']);

  assert.deepEqual((await call('pac', 'GET', '/api/portal/exams')).body, []); // ainda não liberado
  assert.equal((await call('pac', 'GET', `/api/portal/files/${ids.examFile}`)).status, 404);
  await call('med', 'POST', `/api/exams/${ids.exam}/release`, { released: true });
  const exams = (await call('pac', 'GET', '/api/portal/exams')).body;
  assert.equal(exams.length, 1);
  assert.equal(exams[0].title, 'Hemograma');
  assert.equal(exams[0].internalNotes, undefined);
  assert.equal((await call('pac', 'GET', `/api/portal/files/${ids.examFile}`)).status, 200);
  // Nunca vê dados de outro paciente nem áreas da clínica
  assert.equal((await call('pac', 'GET', `/api/portal/files/${f2.body.id}`)).status, 404);
  for (const url of ['/api/patients', `/api/patients/${ids.p2}`, '/api/surgeries', '/api/finance/charges', `/api/patients/${ids.p1}/notes`, '/api/crm/leads', '/api/analytics', `/api/files/${ids.examFile}`]) {
    assert.equal((await call('pac', 'GET', url)).status, 403, url);
  }
});

test('agenda inteligente: expediente e sugestão de horários livres', async () => {
  const bad = await call('adm', 'PUT', `/api/professionals/${ids.pro}`, { workHours: { 1: [['12:00', '08:00']] } });
  assert.equal(bad.status, 422);
  const ok = await call('adm', 'PUT', `/api/professionals/${ids.pro}`, { workHours: { 1: [['08:00', '09:00']] } });
  assert.equal(ok.status, 200);
  const mon = nextMonday();
  const s1 = (await call('func', 'GET', `/api/schedule/suggest?professionalId=${ids.pro}&durationMin=30&from=${mon}&days=1`)).body;
  assert.deepEqual(s1.slots.map((x) => x.startTime), ['08:00', '08:15', '08:30']);
  const c = await call('func', 'POST', '/api/surgeries', { type: 'consulta', patientId: ids.p1, procedureName: 'Avaliação', surgeonId: ids.pro, date: mon, startTime: '08:00', durationMin: 30, priority: 'eletiva', coverage: 'particular', priceCents: 20000 });
  assert.equal(c.status, 201);
  ids.appt = c.body.id;
  ids.token = c.body.confirmToken;
  assert.ok(ids.token && ids.token.length >= 30);
  const s2 = (await call('func', 'GET', `/api/schedule/suggest?professionalId=${ids.pro}&durationMin=30&from=${mon}&days=1`)).body;
  assert.deepEqual(s2.slots.map((x) => x.startTime), ['08:30']);
});

test('link de confirmação: mostra o mínimo e permite confirmar e cancelar', async () => {
  assert.equal((await call('anon', 'GET', '/api/public/appointment?t=invalido-123456789012345')).status, 404);
  const v = (await call('anon', 'GET', `/api/public/appointment?t=${encodeURIComponent(ids.token)}`)).body;
  assert.equal(v.patientFirstName, 'Paula');
  assert.equal(v.procedureName, undefined); // nada de dado clínico sem login
  assert.equal(v.canAnswer, true);
  const conf = await call('anon', 'POST', '/api/public/appointment', { t: ids.token, action: 'confirmar' });
  assert.equal(conf.body.status, 'confirmada');
  const canc = await call('anon', 'POST', '/api/public/appointment', { t: ids.token, action: 'cancelar' });
  assert.equal(canc.body.status, 'cancelada');
  assert.equal(canc.body.canAnswer, false);
  const ch = (await call('func', 'GET', `/api/finance/charges?appointmentId=${ids.appt}`)).body;
  assert.equal(ch[0].status, 'cancelado');
  assert.equal((await call('anon', 'POST', '/api/public/appointment', { t: ids.token, action: 'confirmar' })).status, 409);
});

test('WhatsApp: telefone, envio pela API oficial e lembrete com link', async () => {
  assert.equal(toE164('(31) 99999-1234'), '5531999991234');
  assert.equal(toE164('123'), null);
  let sent;
  await sendWhatsApp({ phoneNumberId: '123456', token: 'tok', templateName: 'lembrete_consulta' }, { to: '5531999991234', params: ['Ana', 'segunda', '08:00', 'Clínica', 'link'] },
    async (url, opt) => { sent = { url, opt }; return { ok: true }; });
  assert.match(sent.url, /graph\.facebook\.com\/v21\.0\/123456\/messages/);
  assert.equal(JSON.parse(sent.opt.body).template.components[0].parameters.length, 5);
  await assert.rejects(sendWhatsApp({ phoneNumberId: '1', token: 't', templateName: 'x' }, { to: '5531999991234', params: [] },
    async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'token inválido' } }) })), /token inválido/);

  assert.equal((await call('adm', 'PUT', '/api/settings/whatsapp', { enabled: true, templateName: 'x' })).status, 422);
  const st = await call('adm', 'PUT', '/api/settings/whatsapp', { enabled: true, phoneNumberId: '1234567', token: 'segredo', templateName: 'lembrete_consulta' });
  assert.equal(st.status, 200);
  assert.equal(st.body.token, undefined);
  assert.equal(st.body.ready, true);
  // Sem celular, não autoriza WhatsApp
  assert.equal((await call('adm', 'PUT', `/api/patients/${ids.p2}`, { whatsappReminders: true })).status, 422);

  waSent.length = 0;
  const mon = nextMonday();
  const c = await call('func', 'POST', '/api/surgeries', { type: 'consulta', patientId: ids.p1, procedureName: 'Retorno', surgeonId: ids.pro, date: mon, startTime: '08:30', durationMin: 30, priority: 'eletiva', coverage: 'particular' });
  assert.equal(c.status, 201);
  await app.notifier.flush();
  assert.equal(waSent.length, 1);
  assert.equal(waSent[0].to, '5531999991234');
  assert.equal(waSent[0].params[0], 'Paula');
  assert.match(waSent[0].params[4], /confirmar\.html\?t=/);
  // Lembrete 1 dia antes
  const start = new Date(`${mon}T08:30:00`).getTime();
  await app.notifier.tick(new Date(start - 23 * 3600000));
  await app.notifier.flush(() => new Date(start - 23 * 3600000));
  assert.equal(waSent.length, 2);
});

test('CRM: funil, orçamento e aprovação gerando cobrança', async () => {
  assert.equal((await call('func', 'POST', '/api/crm/leads', { name: 'Interessado', source: 'instagram' })).status, 422);
  const l = await call('func', 'POST', '/api/crm/leads', { name: 'Interessado', source: 'instagram', phone: '31988887777', interest: 'Implante' });
  assert.equal(l.status, 201);
  assert.equal(l.body.professionalId, ids.pro); // funcionário: atribuído ao seu médico
  assert.equal((await call('func', 'POST', `/api/crm/leads/${l.body.id}/stage`, { stage: 'perdido' })).status, 422);
  await call('func', 'POST', `/api/crm/leads/${l.body.id}/stage`, { stage: 'avaliacao' });
  const valid = ymd(new Date(Date.now() + 15 * 86400000));
  const tooMuch = await call('func', 'POST', '/api/crm/quotes', { patientId: ids.p1, professionalId: ids.pro, leadId: l.body.id, validUntil: valid, method: 'cartao_credito', installments: 10, discountCents: 999999, items: [{ name: 'Implante', qty: 1, unitCents: 300000 }] });
  assert.equal(tooMuch.status, 422);
  const q = await call('func', 'POST', '/api/crm/quotes', { patientId: ids.p1, professionalId: ids.pro, leadId: l.body.id, validUntil: valid, method: 'cartao_credito', installments: 10, discountCents: 20000, items: [{ name: 'Implante', qty: 1, unitCents: 300000 }, { name: 'Coroa', qty: 2, unitCents: 100000 }] });
  assert.equal(q.status, 201);
  assert.equal(q.body.totalCents, 480000);
  assert.equal(q.body.number, 1);
  // Médico de outro profissional não vê
  assert.ok((await call('med', 'GET', '/api/crm/quotes')).body.every((x) => x.id !== q.body.id));
  await call('func', 'POST', `/api/crm/quotes/${q.body.id}/status`, { status: 'enviado' });
  assert.equal((await call('func', 'GET', '/api/crm/leads')).body.find((x) => x.id === l.body.id).stage, 'orcamento');
  const ap = await call('func', 'POST', `/api/crm/quotes/${q.body.id}/status`, { status: 'aprovado' });
  assert.equal(ap.body.status, 'aprovado');
  const charge = (await call('func', 'GET', `/api/finance/charges/${ap.body.chargeId}`)).body;
  assert.equal(charge.amountCents, 480000);
  assert.equal(charge.installments, 10);
  assert.equal((await call('func', 'GET', '/api/crm/leads')).body.find((x) => x.id === l.body.id).stage, 'ganho');
  assert.equal((await call('func', 'PUT', `/api/crm/quotes/${q.body.id}`, { ...q.body })).status, 409);
});

test('dashboard: indicadores e metas', async () => {
  // Uma consulta concluída e paga hoje, e uma falta
  const c = await call('func', 'POST', '/api/surgeries', { type: 'consulta', patientId: ids.p2, procedureName: 'Consulta', surgeonId: ids.pro, date: today(), startTime: '23:00', durationMin: 30, priority: 'eletiva', coverage: 'particular', priceCents: 30000 });
  for (const st of ['confirmada', 'em_andamento', 'concluida']) await call('func', 'POST', `/api/surgeries/${c.body.id}/status`, { status: st });
  await call('func', 'POST', `/api/finance/charges/${c.body.charge.id}/payments`, { amountCents: 30000, method: 'pix', paidAt: today() });
  const f = await call('func', 'POST', '/api/surgeries', { type: 'consulta', patientId: ids.p2, procedureName: 'Consulta', surgeonId: ids.pro, date: today(), startTime: '23:30', durationMin: 20, priority: 'eletiva', coverage: 'particular' });
  await call('func', 'POST', `/api/surgeries/${f.body.id}/status`, { status: 'faltou' });

  assert.equal((await call('med', 'PUT', '/api/analytics/goals', { clinicMonthlyCents: 1 })).status, 403);
  await call('adm', 'PUT', '/api/analytics/goals', { clinicMonthlyCents: 1000000, byProfessional: { [ids.pro]: 300000 } });
  const a = (await call('func', 'GET', `/api/analytics?from=${today()}&to=${today()}`)).body;
  assert.equal(a.scoped, true);
  assert.equal(a.kpis.receivedCents, 30000);
  assert.equal(a.kpis.completed, 1);
  assert.equal(a.kpis.avgTicketCents, 30000);
  assert.equal(a.kpis.noShowRate, 50);
  assert.equal(a.goal.monthCents, 300000);
  assert.deepEqual(a.byProfessional, []);
  const adm = (await call('adm', 'GET', `/api/analytics?from=${today()}&to=${today()}`)).body;
  assert.equal(adm.goal.monthCents, 1000000);
  assert.ok(adm.byMethod.some((m) => m.key === 'pix'));
  assert.equal((await call('adm', 'GET', '/api/analytics?from=2026-12-01&to=2026-01-01')).status, 422);
});

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');

let app; let base;
const jars = { adm: '', med: '', func: '', med2: '' };

async function call(who, method, url, body) {
  const res = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', Cookie: jars[who] }, body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie'); if (set) jars[who] = set.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}
const login = (who, email, password) => call(who, 'POST', '/api/login', { email, password });
const pad = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const ids = {};

const consulta = (extra = {}) => ({
  type: 'consulta', patientId: ids.patient, procedureName: 'Consulta de rotina', surgeonId: ids.pro1,
  date: '2030-05-10', startTime: '09:00', durationMin: 30, priority: 'eletiva', coverage: 'particular', ...extra,
});

before(async () => {
  app = createServer();
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.address().port}`;
  await call('adm', 'POST', '/api/setup', { name: 'Dono ClinPay', email: 'root@clinpay.com', password: 'SenhaForte2026' });
  await call('adm', 'POST', '/api/platform/clinics', { name: 'Clínica Pay', owner: { name: 'Administrador', email: 'adm@clinpay.com', password: 'SenhaForte2026' } });
  await login('adm', 'adm@clinpay.com', 'SenhaForte2026');
});
after(() => app.close());

test('nome padrão do sistema é ClinPay', async () => {
  const r = await call('adm', 'GET', '/api/setup');
  assert.equal(r.body.clinicName, 'ClinPay');
});

test('cadastro de médico cria usuário e profissional; funcionário exige médico', async () => {
  const med = await call('adm', 'POST', '/api/users', {
    name: 'Dra. Carla Mendes', email: 'carla@clinpay.com', role: 'medico', password: 'Medica2026xx',
    newProfessional: { specialty: 'Dermatologia', council: 'CRM-MG 1234' },
  });
  assert.equal(med.status, 201, JSON.stringify(med.body));
  ids.pro1 = med.body.professionalId;
  const pros = (await call('adm', 'GET', '/api/professionals')).body;
  assert.equal(pros.find((p) => p.id === ids.pro1).role, 'medico');

  const semMedico = await call('adm', 'POST', '/api/users', { name: 'Ana Secretária', email: 'ana@clinpay.com', role: 'funcionario', password: 'Secret2026xx' });
  assert.equal(semMedico.status, 422);
  assert.ok(semMedico.body.fields.professionalId);
  const func = await call('adm', 'POST', '/api/users', { name: 'Ana Secretária', email: 'ana@clinpay.com', role: 'funcionario', password: 'Secret2026xx', professionalId: ids.pro1 });
  assert.equal(func.status, 201);

  const med2 = await call('adm', 'POST', '/api/users', { name: 'Dr. Paulo Lima', email: 'paulo@clinpay.com', role: 'medico', password: 'Medico2026xx', newProfessional: {} });
  ids.pro2 = med2.body.professionalId;

  await login('med', 'carla@clinpay.com', 'Medica2026xx');
  await login('func', 'ana@clinpay.com', 'Secret2026xx');
  await login('med2', 'paulo@clinpay.com', 'Medico2026xx');
});

test('médico e funcionário não acessam administração', async () => {
  for (const who of ['med', 'func']) {
    assert.equal((await call(who, 'GET', '/api/users')).status, 403);
    assert.equal((await call(who, 'GET', '/api/audit')).status, 403);
    assert.equal((await call(who, 'GET', '/api/settings/email')).status, 403);
    assert.equal((await call(who, 'POST', '/api/rooms', { name: 'X' })).status, 403);
  }
  // Funcionário não faz checklist cirúrgico
  const me = (await call('func', 'GET', '/api/me')).body;
  assert.ok(!me.permissions.includes('surgeries:clinical'));
  assert.ok(me.permissions.includes('finance:write'));
});

test('consulta não exige sala, lado, anestesia, termos nem checklist', async () => {
  ids.patient = (await call('func', 'POST', '/api/patients', { name: 'Maria Souza', birthDate: '1980-01-01', sex: 'F', noKnownAllergies: true })).body.id;
  const c = await call('func', 'POST', '/api/surgeries', consulta({ priceCents: 25000, chargeMethod: 'pix' }));
  assert.equal(c.status, 201, JSON.stringify(c.body));
  ids.consulta = c.body.id;
  assert.deepEqual(c.body.requiredDocs, []);
  assert.equal(c.body.roomName, 'Sem sala definida');
  assert.equal(c.body.charge.amountCents, 25000);
  // Fluxo: confirmar, iniciar e concluir sem termos
  for (const st of ['confirmada', 'em_andamento', 'concluida']) {
    const r = await call('func', 'POST', `/api/surgeries/${ids.consulta}/status`, { status: st });
    assert.equal(r.status, 200, `${st}: ${JSON.stringify(r.body)}`);
  }
  assert.equal((await call('med', 'PUT', `/api/surgeries/${ids.consulta}/checklist/entrada`, { items: {} })).status, 409);
});

test('cirurgia continua exigindo sala, lado e anestesia', async () => {
  const r = await call('adm', 'POST', '/api/surgeries', consulta({ type: 'cirurgia', startTime: '14:00' }));
  assert.equal(r.status, 422);
  assert.ok(r.body.fields.roomId && r.body.fields.laterality && r.body.fields.anesthesiaType);
});

test('consultas sem sala não conflitam por sala, mas conflitam pelo médico', async () => {
  const other = await call('adm', 'POST', '/api/patients', { name: 'João Lima', birthDate: '1975-01-01', sex: 'M', noKnownAllergies: true });
  ids.patient2 = other.body.id;
  const a = await call('adm', 'POST', '/api/surgeries', consulta({ patientId: ids.patient2, surgeonId: ids.pro2, startTime: '10:00' }));
  assert.equal(a.status, 201);
  const sameDoctor = await call('adm', 'POST', '/api/surgeries', consulta({ startTime: '10:00', surgeonId: ids.pro2 }));
  assert.equal(sameDoctor.status, 409);
  assert.ok(sameDoctor.body.conflicts.some((c) => c.type === 'profissional'));
  // Outro médico, mesmo horário, ambos sem sala: permitido
  const otherDoctor = await call('adm', 'POST', '/api/surgeries', consulta({ startTime: '10:00' }));
  assert.equal(otherDoctor.status, 201, JSON.stringify(otherDoctor.body));
});

test('paciente faltou', async () => {
  const c = await call('adm', 'POST', '/api/surgeries', consulta({ startTime: '15:00' }));
  const r = await call('med', 'POST', `/api/surgeries/${c.body.id}/status`, { status: 'faltou' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'faltou');
  assert.equal((await call('med', 'POST', `/api/surgeries/${c.body.id}/status`, { status: 'confirmada' })).status, 409);
});

test('médico e funcionário só agendam e alteram para o próprio médico', async () => {
  const forOther = await call('func', 'POST', '/api/surgeries', consulta({ surgeonId: ids.pro2, startTime: '16:00' }));
  assert.equal(forOther.status, 403);
  const own = await call('med2', 'POST', '/api/surgeries', consulta({ surgeonId: ids.pro2, startTime: '17:00' }));
  assert.equal(own.status, 201);
  ids.consultaPro2 = own.body.id;
  assert.equal((await call('func', 'POST', `/api/surgeries/${ids.consultaPro2}/status`, { status: 'cancelada', reason: 'teste' })).status, 403);
  // Agenda geral continua visível (para ver horários livres), sem valores de outro médico
  const list = (await call('func', 'GET', '/api/surgeries?from=2030-05-10&to=2030-05-10')).body;
  assert.ok(list.some((s) => s.id === ids.consultaPro2));
  assert.equal(list.find((s) => s.id === ids.consultaPro2).charge, null);
});

test('financeiro: pagamento, saldo e limite', async () => {
  const charges = (await call('func', 'GET', `/api/finance/charges?appointmentId=${ids.consulta}`)).body;
  assert.equal(charges.length, 1);
  ids.charge = charges[0].id;
  const over = await call('func', 'POST', `/api/finance/charges/${ids.charge}/payments`, { amountCents: 30000, method: 'pix', paidAt: today() });
  assert.equal(over.status, 422);
  const future = await call('func', 'POST', `/api/finance/charges/${ids.charge}/payments`, { amountCents: 100, method: 'pix', paidAt: '2999-01-01' });
  assert.equal(future.status, 422);
  const p1 = await call('func', 'POST', `/api/finance/charges/${ids.charge}/payments`, { amountCents: 10000, method: 'dinheiro', paidAt: today() });
  assert.equal(p1.status, 200);
  assert.equal(p1.body.status, 'parcial');
  assert.equal(p1.body.balanceCents, 15000);
  const p2 = await call('med', 'POST', `/api/finance/charges/${ids.charge}/payments`, { amountCents: 15000, method: 'cartao_credito', installments: 3, paidAt: today() });
  assert.equal(p2.body.status, 'pago');
  // Cobrança que vence em 2030, mas foi paga hoje, aparece nas "pagas" do período de hoje
  const paidToday = (await call('func', 'GET', `/api/finance/charges?from=${today()}&to=${today()}&status=pago`)).body;
  assert.ok(paidToday.some((c) => c.id === ids.charge));
  // Com pagamento, não dá para cancelar nem mudar o valor pelo agendamento
  assert.equal((await call('func', 'POST', `/api/finance/charges/${ids.charge}/cancel`, { reason: 'teste' })).status, 409);
});

test('financeiro: cada médico vê só o seu; administrador vê tudo', async () => {
  // Cobrança avulsa do Dr. Paulo
  const avulsa = await call('med2', 'POST', '/api/finance/charges', {
    patientId: ids.patient2, professionalId: ids.pro2, description: 'Relatório médico', amountCents: 8000, dueDate: today(), method: 'pix',
  });
  assert.equal(avulsa.status, 201);
  assert.equal((await call('func', 'GET', `/api/finance/charges/${avulsa.body.id}`)).status, 403);
  assert.equal((await call('func', 'POST', `/api/finance/charges/${avulsa.body.id}/payments`, { amountCents: 100, method: 'pix', paidAt: today() })).status, 403);
  assert.equal((await call('func', 'POST', '/api/finance/charges', {
    patientId: ids.patient2, professionalId: ids.pro2, description: 'x', amountCents: 100, dueDate: today(), method: 'pix',
  })).status, 403);
  const funcList = (await call('func', 'GET', '/api/finance/charges')).body;
  assert.ok(funcList.every((c) => c.professionalId === ids.pro1));
  // Pedir o financeiro de outro médico pela URL não funciona
  const trick = (await call('func', 'GET', `/api/finance/charges?professionalId=${ids.pro2}`)).body;
  assert.ok(trick.every((c) => c.professionalId === ids.pro1));

  const sumMed = (await call('med', 'GET', `/api/finance/summary?from=${today()}&to=${today()}`)).body;
  assert.equal(sumMed.receivedCents, 25000);
  assert.deepEqual(sumMed.byMethod.map((m) => m.method).sort(), ['cartao_credito', 'dinheiro']);
  assert.deepEqual(sumMed.byProfessional, []);
  const sumAdm = (await call('adm', 'GET', `/api/finance/summary?from=${today()}&to=${today()}`)).body;
  assert.equal(sumAdm.receivedCents, 25000);
  assert.equal(sumAdm.toReceiveCents, 8000);
  assert.ok(sumAdm.byProfessional.length >= 2);
});

test('estorno só pelo administrador e com motivo', async () => {
  const c = (await call('adm', 'GET', `/api/finance/charges/${ids.charge}`)).body;
  const pid = c.payments[0].id;
  assert.equal((await call('med', 'POST', `/api/finance/charges/${ids.charge}/payments/${pid}/reverse`, { reason: 'erro de digitação' })).status, 403);
  assert.equal((await call('adm', 'POST', `/api/finance/charges/${ids.charge}/payments/${pid}/reverse`, {})).status, 422);
  const r = await call('adm', 'POST', `/api/finance/charges/${ids.charge}/payments/${pid}/reverse`, { reason: 'erro de digitação' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'parcial');
  assert.equal(r.body.balanceCents, 10000);
  assert.equal(r.body.payments.length, 2); // estorno fica registrado, não apaga
});

test('valor do agendamento sincroniza com a cobrança; cancelar atendimento cancela cobrança sem pagamento', async () => {
  const c = await call('func', 'POST', '/api/surgeries', consulta({ startTime: '11:00', priceCents: 20000 }));
  const sx = c.body;
  const upd = await call('func', 'PUT', `/api/surgeries/${sx.id}`, { ...consulta({ startTime: '11:00' }), priceCents: 22000, chargeMethod: 'cartao_debito' });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.charge.amountCents, 22000);
  assert.equal(upd.body.charge.method, 'cartao_debito');
  await call('func', 'POST', `/api/surgeries/${sx.id}/status`, { status: 'cancelada', reason: 'Paciente desmarcou' });
  const ch = (await call('func', 'GET', `/api/finance/charges?appointmentId=${sx.id}`)).body;
  assert.equal(ch[0].status, 'cancelado');

  // Com pagamento registrado, não deixa mudar o valor pelo agendamento
  const c2 = await call('func', 'POST', '/api/surgeries', consulta({ startTime: '12:00', priceCents: 20000 }));
  const ch2 = (await call('func', 'GET', `/api/finance/charges?appointmentId=${c2.body.id}`)).body[0];
  await call('func', 'POST', `/api/finance/charges/${ch2.id}/payments`, { amountCents: 5000, method: 'pix', paidAt: today() });
  const blocked = await call('func', 'PUT', `/api/surgeries/${c2.body.id}`, { ...consulta({ startTime: '12:00' }), priceCents: 30000 });
  assert.equal(blocked.status, 409);
  const still = (await call('func', 'GET', `/api/surgeries/${c2.body.id}`)).body;
  assert.equal(still.priceCents, 20000); // nada foi salvo pela metade
});

test('enviar e-mail ao paciente exige e-mail e envio configurado', async () => {
  const noEmail = await call('med', 'POST', `/api/patients/${ids.patient}/email`, { subject: 'Resultado', message: 'Seu exame chegou.' });
  assert.equal(noEmail.status, 422);
  const p = (await call('adm', 'GET', `/api/patients/${ids.patient}`)).body;
  await call('adm', 'PUT', `/api/patients/${ids.patient}`, { ...p, email: 'maria@x.com' });
  const notReady = await call('med', 'POST', `/api/patients/${ids.patient}/email`, { subject: 'Resultado', message: 'Seu exame chegou.' });
  assert.equal(notReady.status, 409);
});

test('lembretes padrão: 3 dias e 1 dia antes', async () => {
  const st = (await call('adm', 'GET', '/api/settings/email')).body;
  assert.deepEqual(st.reminderHours, [72, 24]);
});

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createServer } = require('../server');

let app; let base; let smtp;
const jars = { root: '', a: '', b: '' };
const received = [];

async function call(who, method, url, body) {
  const res = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', Cookie: jars[who] }, body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie'); if (set) jars[who] = set.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}
const ids = {};
const pad = (n) => String(n).padStart(2, '0');
const future = () => { const d = new Date(Date.now() + 10 * 86400000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

before(async () => {
  smtp = net.createServer((sock) => {
    sock.write('220 ok\r\n'); let buf = ''; let inData = false; let to = '';
    sock.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) { if (l === '.') { inData = false; received.push(to); sock.write('250 ok\r\n'); } continue; }
        const u = l.toUpperCase();
        if (u.startsWith('RCPT')) to = l.match(/<(.*)>/)[1];
        if (u.startsWith('EHLO')) sock.write('250 ok\r\n'); else if (u === 'DATA') { inData = true; sock.write('354 go\r\n'); } else if (u === 'QUIT') { sock.end(); } else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
  app = createServer();
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.address().port}`;
  await call('root', 'POST', '/api/setup', { name: 'Dono ClinPay', email: 'root@clinpay.com', password: 'SenhaForte2026' });
});
after(() => { app.close(); smtp.close(); });

test('administrador ClinPay sem clínica escolhida não acessa dados de clínica', async () => {
  const r = await call('root', 'GET', '/api/patients');
  assert.equal(r.status, 409);
  assert.equal(r.body.noClinic, true);
  const me = (await call('root', 'GET', '/api/me')).body;
  assert.equal(me.platform, true);
  assert.equal(me.clinic, null);
});

test('cadastro de clínicas: validações', async () => {
  const badCnpj = await call('root', 'POST', '/api/platform/clinics', { name: 'Clínica X', cnpj: '11.111.111/1111-11', owner: { name: 'Dr. X', email: 'x@x.com', password: 'Senha2026xyz' } });
  assert.equal(badCnpj.status, 422);
  assert.ok(badCnpj.body.fields.cnpj);
  const weak = await call('root', 'POST', '/api/platform/clinics', { name: 'Clínica X', owner: { name: 'Dr. X', email: 'x@x.com', password: '123' } });
  assert.equal(weak.status, 422);
  const a = await call('root', 'POST', '/api/platform/clinics', {
    name: 'Clínica Alfa', cnpj: '11.222.333/0001-81', color: '#1e8e5a',
    owner: { name: 'Dra. Ana Alfa', email: 'ana@alfa.com', password: 'AlfaSenha2026', council: 'CRM-MG 1' },
  });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  ids.clinicA = a.body.id;
  assert.equal(a.body.owner.role, 'admin');
  const b = await call('root', 'POST', '/api/platform/clinics', { name: 'Clínica Beta', owner: { name: 'Dr. Bruno Beta', email: 'bruno@beta.com', password: 'BetaSenha2026' } });
  ids.clinicB = b.body.id;
  const dupEmail = await call('root', 'POST', '/api/platform/clinics', { name: 'Clínica Gama', owner: { name: 'Dr. G', email: 'ana@alfa.com', password: 'GamaSenha2026' } });
  assert.equal(dupEmail.status, 422);
  assert.ok(dupEmail.body.fields['owner.email']);
  const dupName = await call('root', 'POST', '/api/platform/clinics', { name: 'clinica alfa', owner: { name: 'Dr. G', email: 'g@g.com', password: 'GamaSenha2026' } });
  assert.equal(dupName.status, 422);
});

test('médico responsável entra direto na própria clínica', async () => {
  assert.equal((await call('a', 'POST', '/api/login', { email: 'ana@alfa.com', password: 'AlfaSenha2026' })).status, 200);
  assert.equal((await call('b', 'POST', '/api/login', { email: 'bruno@beta.com', password: 'BetaSenha2026' })).status, 200);
  const me = (await call('a', 'GET', '/api/me')).body;
  assert.equal(me.clinic.name, 'Clínica Alfa');
  assert.equal(me.platform, false);
  assert.ok(me.permissions.includes('users:manage'));
  assert.ok(!me.permissions.includes('platform:manage'));
  const meta = (await call('a', 'GET', '/api/meta')).body;
  assert.equal(meta.clinicName, 'Clínica Alfa');
  assert.ok(!Object.keys(meta.roles).includes('superadmin'));
});

test('clínica não acessa o painel ClinPay', async () => {
  for (const url of ['/api/platform/clinics', '/api/platform/admins', '/api/platform/audit']) {
    assert.equal((await call('a', 'GET', url)).status, 403);
  }
  assert.equal((await call('a', 'POST', '/api/platform/enter', { clinicId: ids.clinicB })).status, 403);
  // Também não consegue criar um usuário administrador ClinPay pelo cadastro da clínica
  const r = await call('a', 'POST', '/api/users', { name: 'Hacker', email: 'h@h.com', role: 'superadmin', password: 'Hacker2026xx' });
  assert.equal(r.status, 422);
});

test('dados de uma clínica são invisíveis para a outra', async () => {
  const pros = (await call('a', 'GET', '/api/professionals')).body;
  ids.proA = pros[0].id;
  ids.patientA = (await call('a', 'POST', '/api/patients', { name: 'Paciente da Alfa', birthDate: '1980-01-01', sex: 'F', cpf: '529.982.247-25', noKnownAllergies: true, email: 'pac@alfa.com', emailReminders: true })).body.id;
  const sx = await call('a', 'POST', '/api/surgeries', {
    type: 'consulta', patientId: ids.patientA, procedureName: 'Consulta', surgeonId: ids.proA,
    date: future(), startTime: '09:00', durationMin: 30, priority: 'eletiva', coverage: 'particular', priceCents: 30000,
  });
  assert.equal(sx.status, 201, JSON.stringify(sx.body));
  ids.surgeryA = sx.body.id;
  ids.chargeA = sx.body.charge.id;
  ids.userA = (await call('a', 'GET', '/api/users')).body[0].id;

  // Listas da Beta vêm vazias
  assert.deepEqual((await call('b', 'GET', '/api/patients')).body, []);
  assert.deepEqual((await call('b', 'GET', '/api/surgeries')).body, []);
  assert.deepEqual((await call('b', 'GET', '/api/finance/charges')).body, []);
  assert.ok((await call('b', 'GET', '/api/users')).body.every((u) => u.email !== 'ana@alfa.com'));
  assert.ok((await call('b', 'GET', '/api/professionals')).body.every((p) => p.id !== ids.proA));
  assert.ok((await call('b', 'GET', '/api/audit')).body.every((x) => x.summary === null || !String(x.summary).includes('Alfa')));
  // Acesso direto pelo id também é bloqueado (como se não existisse)
  assert.equal((await call('b', 'GET', `/api/patients/${ids.patientA}`)).status, 404);
  assert.equal((await call('b', 'PUT', `/api/patients/${ids.patientA}`, { name: 'Alterado' })).status, 404);
  assert.equal((await call('b', 'GET', `/api/surgeries/${ids.surgeryA}`)).status, 404);
  assert.equal((await call('b', 'POST', `/api/surgeries/${ids.surgeryA}/status`, { status: 'cancelada', reason: 'x' })).status, 404);
  assert.equal((await call('b', 'GET', `/api/finance/charges/${ids.chargeA}`)).status, 404);
  assert.equal((await call('b', 'POST', `/api/finance/charges/${ids.chargeA}/payments`, { amountCents: 100, method: 'pix', paidAt: '2020-01-01' })).status, 404);
  assert.equal((await call('b', 'PUT', `/api/users/${ids.userA}`, { active: false })).status, 404);
  // A Beta não consegue agendar usando paciente ou médico da Alfa
  const cross = await call('b', 'POST', '/api/surgeries', {
    type: 'consulta', patientId: ids.patientA, procedureName: 'X', surgeonId: ids.proA,
    date: future(), startTime: '10:00', durationMin: 30, priority: 'eletiva', coverage: 'particular',
  });
  assert.equal(cross.status, 422);
  // Mesmo CPF pode existir em clínicas diferentes (cada clínica tem seu cadastro)
  const sameCpf = await call('b', 'POST', '/api/patients', { name: 'Outra pessoa', birthDate: '1990-01-01', sex: 'M', cpf: '529.982.247-25', noKnownAllergies: true });
  assert.equal(sameCpf.status, 201);
  // Agenda da Beta não vê conflito com horários da Alfa
  const pB = (await call('b', 'GET', '/api/professionals')).body[0].id;
  const okB = await call('b', 'POST', '/api/surgeries', {
    type: 'consulta', patientId: sameCpf.body.id, procedureName: 'Consulta', surgeonId: pB,
    date: future(), startTime: '09:00', durationMin: 30, priority: 'eletiva', coverage: 'particular',
  });
  assert.equal(okB.status, 201);
});

test('configuração de e-mail é de cada clínica', async () => {
  const st = await call('a', 'PUT', '/api/settings/email', {
    enabled: true, host: '127.0.0.1', port: smtp.address().port, security: 'none', fromName: 'Clínica Alfa', fromAddr: 'alfa@x.com', reminderHours: '72,24',
  });
  assert.equal(st.status, 200);
  const stB = (await call('b', 'GET', '/api/settings/email')).body;
  assert.equal(stB.ready, false);
  assert.equal(stB.fromName, 'Clínica Beta');
  // Lembretes rodam por clínica: só a Alfa, configurada, envia
  received.length = 0;
  const start = new Date(`${future()}T09:00:00`).getTime();
  await app.notifier.tick(new Date(start - 23 * 3600000));
  await app.notifier.flush(() => new Date(start - 23 * 3600000));
  assert.deepEqual(received, ['pac@alfa.com']);
  assert.deepEqual((await call('b', 'GET', '/api/emails?surgeryId=x')).body, []);
});

test('administrador ClinPay entra na clínica e a entrada fica na auditoria da clínica', async () => {
  const list = (await call('root', 'GET', '/api/platform/clinics')).body;
  const alfa = list.find((c) => c.id === ids.clinicA);
  assert.equal(alfa.stats.patients, 1);
  assert.equal(alfa.stats.upcoming, 1);
  assert.equal((await call('root', 'POST', '/api/platform/enter', { clinicId: ids.clinicA })).status, 200);
  const pats = (await call('root', 'GET', '/api/patients')).body;
  assert.deepEqual(pats.map((p) => p.id), [ids.patientA]);
  assert.equal((await call('root', 'GET', '/api/me')).body.clinic.name, 'Clínica Alfa');
  const auditA = (await call('a', 'GET', '/api/audit')).body;
  assert.ok(auditA.some((x) => x.action === 'support_access' && x.userName.includes('(ClinPay)')));
  // Rotas da plataforma continuam fora da clínica, mesmo com uma clínica aberta
  assert.equal((await call('root', 'GET', '/api/platform/clinics')).status, 200);
  await call('root', 'POST', '/api/platform/leave');
  assert.equal((await call('root', 'GET', '/api/patients')).status, 409);
});

test('suspender clínica derruba o acesso; reativar libera', async () => {
  assert.equal((await call('root', 'PUT', `/api/platform/clinics/${ids.clinicB}`, { status: 'suspensa' })).status, 200);
  assert.equal((await call('b', 'GET', '/api/patients')).status, 401);
  const login = await call('b', 'POST', '/api/login', { email: 'bruno@beta.com', password: 'BetaSenha2026' });
  assert.equal(login.status, 403);
  assert.match(login.body.error, /suspenso/);
  await call('root', 'PUT', `/api/platform/clinics/${ids.clinicB}`, { status: 'ativa' });
  assert.equal((await call('b', 'POST', '/api/login', { email: 'bruno@beta.com', password: 'BetaSenha2026' })).status, 200);
});

test('administradores ClinPay', async () => {
  const r = await call('root', 'POST', '/api/platform/admins', { name: 'Sócio ClinPay', email: 'socio@clinpay.com', password: 'SocioSenha2026' });
  assert.equal(r.status, 201);
  assert.equal(r.body.role, 'superadmin');
  const me = (await call('root', 'GET', '/api/me')).body.user;
  assert.equal((await call('root', 'PUT', `/api/platform/admins/${me.id}`, { active: false })).status, 409);
  assert.equal((await call('root', 'PUT', `/api/platform/admins/${r.body.id}`, { active: false })).status, 200);
  const admins = (await call('root', 'GET', '/api/platform/admins')).body;
  assert.equal(admins.length, 2);
  // O administrador da clínica não enxerga nem altera administradores ClinPay
  assert.equal((await call('a', 'PUT', `/api/users/${me.id}`, { active: false })).status, 404);
  const pa = (await call('root', 'GET', '/api/platform/audit')).body;
  assert.ok(pa.some((x) => x.entity === 'clinics' && x.action === 'create'));
});

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createServer } = require('../server');
const { sendMail } = require('../src/mail/smtp');

// ---------- Servidor SMTP falso que guarda as mensagens recebidas ----------
function fakeSmtp({ offerStartTls = false } = {}) {
  const received = [];
  const commands = [];
  const srv = net.createServer((sock) => {
    sock.write('220 fake ESMTP\r\n');
    let buf = ''; let inData = false; let data = ''; let cur = {};
    sock.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; cur.data = data; received.push(cur); cur = {}; data = ''; sock.write('250 OK\r\n'); } else data += line + '\r\n';
          continue;
        }
        commands.push(line);
        const up = line.toUpperCase();
        if (up.startsWith('EHLO')) sock.write(`250-fake\r\n${offerStartTls ? '250-STARTTLS\r\n' : ''}250-AUTH LOGIN PLAIN\r\n250 8BITMIME\r\n`);
        else if (up.startsWith('AUTH PLAIN')) { cur.auth = Buffer.from(line.slice(11), 'base64').toString(); sock.write('235 ok\r\n'); }
        else if (up.startsWith('MAIL FROM')) { cur.from = line; sock.write('250 ok\r\n'); }
        else if (up.startsWith('RCPT TO')) { cur.to = line.match(/<(.*)>/)[1]; sock.write('250 ok\r\n'); }
        else if (up === 'DATA') { inData = true; sock.write('354 go\r\n'); }
        else if (up === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('500 unknown\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port, received, commands })));
}

// Decodifica o corpo base64 de texto de uma mensagem recebida
function decodeText(raw) {
  const m = raw.match(/Content-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/);
  return Buffer.from(m[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
}
function decodeSubject(raw) {
  const m = raw.match(/^Subject: (.*)$/m)[1];
  const enc = m.match(/^=\?UTF-8\?B\?(.*)\?=$/);
  return enc ? Buffer.from(enc[1], 'base64').toString('utf8') : m;
}

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

let app; let base; let cookie = ''; let smtp;
async function call(method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}
const ids = {};

before(async () => {
  smtp = await fakeSmtp();
  app = createServer();
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.address().port}`;
  await call('POST', '/api/setup', { name: 'Dono ClinPay', email: 'root@clinpay.com', password: 'SenhaForte2026' });
  await call('POST', '/api/platform/clinics', { name: 'Clínica E-mail', owner: { name: 'Administrador', email: 'adm@clinica.com', password: 'SenhaForte2026' } });
  await call('POST', '/api/login', { email: 'adm@clinica.com', password: 'SenhaForte2026' });
});
after(() => { app.close(); smtp.srv.close(); });

test('cliente SMTP envia com acentos e autenticação', async () => {
  await sendMail(
    { host: '127.0.0.1', port: smtp.port, security: 'none', user: 'u@x.com', pass: 's3nha', fromName: 'Clínica Teste', fromAddr: 'clinica@x.com' },
    { to: 'paciente@x.com', subject: 'Lembrete — atendimento', text: 'Olá, João. Ação às 07:00.', html: '<p>Olá</p>' });
  const m = smtp.received.at(-1);
  assert.equal(m.to, 'paciente@x.com');
  assert.equal(m.auth, '\0u@x.com\0s3nha');
  assert.equal(decodeSubject(m.data), 'Lembrete — atendimento');
  assert.match(decodeText(m.data), /Olá, João\. Ação às 07:00\./);
});

test('recusa quebra de linha no destinatário (injeção de cabeçalho)', async () => {
  await assert.rejects(sendMail({ host: '127.0.0.1', port: smtp.port, security: 'none', fromAddr: 'a@x.com' },
    { to: 'a@x.com\r\nBcc: b@x.com', subject: 'x', text: 'x' }));
});

test('STARTTLS exigido e não oferecido: cancela sem enviar a senha', async () => {
  const before = smtp.commands.length;
  await assert.rejects(
    sendMail({ host: '127.0.0.1', port: smtp.port, security: 'starttls', user: 'u', pass: 'segredo', fromAddr: 'a@x.com' },
      { to: 'b@x.com', subject: 'x', text: 'x' }),
    /não oferece STARTTLS/);
  assert.ok(!smtp.commands.slice(before).some((c) => c.toUpperCase().startsWith('AUTH')));
});

test('configuração de e-mail: validação e senha nunca devolvida', async () => {
  const bad = await call('PUT', '/api/settings/email', { enabled: true, port: 587, security: 'starttls', fromName: 'Clínica Teste' });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.fields.host);
  const ok = await call('PUT', '/api/settings/email', {
    enabled: true, host: '127.0.0.1', port: smtp.port, security: 'none', user: 'u@x.com', pass: 'segredo',
    fromName: 'Clínica Teste', fromAddr: 'clinica@x.com', clinicAddress: 'Rua A, 10', clinicPhone: '(31) 3333-0000',
    reminderHours: '48, 24', notifyTeam: true,
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.pass, undefined);
  assert.equal(ok.body.hasPassword, true);
  assert.deepEqual(ok.body.reminderHours, [48, 24]);
  const get = await call('GET', '/api/settings/email');
  assert.equal(get.body.pass, undefined);
  // Salvar sem senha mantém a senha anterior
  const keep = await call('PUT', '/api/settings/email', { ...get.body, reminderHours: '48,24' });
  assert.equal(keep.body.hasPassword, true);
  const test = await call('POST', '/api/settings/email/test', { to: 'adm@clinica.com' });
  assert.equal(test.status, 200);
  assert.equal(smtp.received.at(-1).to, 'adm@clinica.com');
});

test('consentimento: lembrete exige e-mail', async () => {
  const r = await call('POST', '/api/patients', { name: 'Sem Email', birthDate: '1980-01-01', sex: 'M', noKnownAllergies: true, emailReminders: true });
  assert.equal(r.status, 422);
  assert.ok(r.body.fields.email);
});

test('agendamento avisa paciente e equipe que autorizaram', async () => {
  ids.room = (await call('POST', '/api/rooms', { name: 'Sala 1' })).body.id;
  ids.surgeon = (await call('POST', '/api/professionals', { name: 'Dra. Ana', role: 'cirurgiao', email: 'ana@x.com', emailReminders: true })).body.id;
  ids.anest = (await call('POST', '/api/professionals', { name: 'Dr. Beto', role: 'anestesista', email: 'beto@x.com' })).body.id; // não autorizou
  ids.patient = (await call('POST', '/api/patients', { name: 'Maria Souza', birthDate: '1970-01-01', sex: 'F', noKnownAllergies: true, email: 'maria@x.com', emailReminders: true })).body.id;
  ids.patient2 = (await call('POST', '/api/patients', { name: 'José Lima', birthDate: '1970-01-01', sex: 'M', noKnownAllergies: true, email: 'jose@x.com' })).body.id;

  const start = new Date(Date.now() + 72 * 3600000); start.setMinutes(0, 0, 0);
  ids.start = start;
  const before = smtp.received.length;
  const r = await call('POST', '/api/surgeries', { type: 'cirurgia',
    patientId: ids.patient, procedureName: 'Colecistectomia', laterality: 'nao_se_aplica', surgeonId: ids.surgeon,
    anesthetistId: ids.anest, roomId: ids.room, date: localDate(start), startTime: `${pad(start.getHours())}:00`,
    durationMin: 90, anesthesiaType: 'geral', priority: 'eletiva', coverage: 'particular', preOpNotes: 'Jejum de 8 horas.',
  });
  assert.equal(r.status, 201);
  ids.surgery = r.body.id;
  await app.notifier.flush();
  const got = smtp.received.slice(before);
  assert.deepEqual(got.map((m) => m.to).sort(), ['ana@x.com', 'maria@x.com']);
  const toPatient = got.find((m) => m.to === 'maria@x.com');
  const txt = decodeText(toPatient.data);
  assert.match(txt, /Olá, Maria\./);
  assert.match(txt, /Jejum de 8 horas\./);
  assert.ok(!txt.includes('Colecistectomia'), 'procedimento não deve ir ao paciente por padrão');
  assert.ok(!decodeSubject(toPatient.data).includes('Colecistectomia'));
  const toTeam = decodeText(got.find((m) => m.to === 'ana@x.com').data);
  assert.match(toTeam, /Colecistectomia/);
  assert.match(toTeam, /Termos pendentes/);

  // Paciente sem autorização não recebe nada
  const before2 = smtp.received.length;
  const start2 = new Date(start.getTime() + 24 * 3600000);
  await call('POST', '/api/surgeries', { type: 'cirurgia',
    patientId: ids.patient2, procedureName: 'Hernioplastia', laterality: 'direito', surgeonId: ids.anest,
    roomId: ids.room, date: localDate(start2), startTime: `${pad(start2.getHours())}:00`, durationMin: 60,
    anesthesiaType: 'local', priority: 'eletiva', coverage: 'particular',
  });
  await app.notifier.flush();
  assert.equal(smtp.received.length, before2);
});

test('lembretes 48 h e 24 h, sem duplicar', async () => {
  const s = ids.start.getTime();
  const count = () => smtp.received.filter((m) => m.to === 'maria@x.com').length;
  const c0 = count();
  assert.equal(await app.notifier.tick(new Date(s - 50 * 3600000)), 0); // ainda cedo
  await app.notifier.tick(new Date(s - 47 * 3600000));
  await app.notifier.flush(() => new Date(s - 47 * 3600000));
  assert.equal(count(), c0 + 1);
  assert.match(decodeSubject(smtp.received.filter((m) => m.to === 'maria@x.com').at(-1).data), /^Lembrete/);
  assert.equal(await app.notifier.tick(new Date(s - 40 * 3600000)), 0); // não repete
  await app.notifier.tick(new Date(s - 23 * 3600000));
  await app.notifier.flush(() => new Date(s - 23 * 3600000));
  assert.equal(count(), c0 + 2);
  const last = decodeText(smtp.received.filter((m) => m.to === 'maria@x.com').at(-1).data);
  assert.match(last, /é amanhã/);
  assert.equal(await app.notifier.tick(new Date(s - 1 * 3600000)), 0);
  assert.equal(await app.notifier.tick(new Date(s + 3600000)), 0); // já passou
});

test('alteração de horário e cancelamento avisam', async () => {
  const cur = (await call('GET', `/api/surgeries/${ids.surgery}`)).body;
  const c0 = smtp.received.length;
  const newStart = new Date(ids.start.getTime() + 2 * 3600000);
  const upd = await call('PUT', `/api/surgeries/${ids.surgery}`, { ...cur, startTime: `${pad(newStart.getHours())}:00`, date: localDate(newStart) });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  await app.notifier.flush();
  const changed = smtp.received.slice(c0);
  assert.equal(changed.length, 2);
  assert.match(decodeSubject(changed.find((m) => m.to === 'maria@x.com').data), /Alteração/);
  // Novo horário gera novos lembretes
  await app.notifier.tick(new Date(newStart.getTime() - 23 * 3600000));
  await app.notifier.flush(() => new Date(newStart.getTime() - 23 * 3600000));
  assert.ok(smtp.received.length > c0 + 2);

  const c1 = smtp.received.length;
  await call('POST', `/api/surgeries/${ids.surgery}/status`, { status: 'cancelada', reason: 'Paciente pediu' });
  await app.notifier.flush();
  const canc = smtp.received.slice(c1);
  assert.equal(canc.length, 2);
  const txt = decodeText(canc.find((m) => m.to === 'maria@x.com').data);
  assert.match(txt, /cancelado/);
  assert.ok(!txt.includes('Paciente pediu'), 'motivo interno não vai ao paciente');
  assert.equal(await app.notifier.tick(new Date(newStart.getTime() - 2 * 3600000)), 0); // cancelada: sem lembrete
});

test('falha de envio fica registrada e é tentada de novo', async () => {
  const closed = net.createServer(); await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const deadPort = closed.address().port; closed.close();
  const st = (await call('GET', '/api/settings/email')).body;
  await call('PUT', '/api/settings/email', { ...st, port: deadPort, reminderHours: '48,24' });
  await call('POST', '/api/settings/email/test', { to: 'x@x.com' }).then((r) => assert.equal(r.status, 502));
  const start = new Date(Date.now() + 130 * 3600000); start.setMinutes(0, 0, 0);
  const created = await call('POST', '/api/surgeries', { type: 'cirurgia',
    patientId: ids.patient, procedureName: 'Outro', laterality: 'nao_se_aplica', surgeonId: ids.surgeon,
    roomId: ids.room, date: localDate(start), startTime: `${pad(start.getHours())}:00`, durationMin: 60,
    anesthesiaType: 'local', priority: 'eletiva', coverage: 'particular',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  await app.notifier.flush();
  const list = (await call('GET', '/api/emails?status=pendente')).body;
  assert.ok(list.length >= 1);
  assert.equal(list[0].attempts, 1);
  assert.ok(list[0].lastError);
  assert.equal(list[0].text, undefined); // corpo não é exposto na listagem
  // Volta a porta certa e reenviar funciona
  await call('PUT', '/api/settings/email', { ...st, port: smtp.port, reminderHours: '48,24' });
  await app.notifier.flush(() => new Date(Date.now() + 10 * 60000));
  const after = (await call('GET', '/api/emails?status=pendente')).body;
  assert.equal(after.length, 0);
});

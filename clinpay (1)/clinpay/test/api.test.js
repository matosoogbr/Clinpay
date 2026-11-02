'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { createServer } = require('../server');
const { isValidCpf } = require('../src/validation');

let server; let base; let cookie = '';

async function call(method, url, body, opts = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(opts.noCookie ? {} : { Cookie: cookie }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set && !opts.noCookie) cookie = set.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}

// PNG real (200x60, linhas aleatórias) para simular a assinatura
function fakePng() {
  const w = 200; const h = 60;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
  });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h);
  for (let i = 0; i < raw.length; i++) raw[i] = i % (w + 1) === 0 ? 0 : (Math.random() * 255) | 0;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return 'data:image/png;base64,' + png.toString('base64');
}

const ids = {};

before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('validação de CPF', () => {
  assert.equal(isValidCpf('529.982.247-25'), true);
  assert.equal(isValidCpf('111.111.111-11'), false);
  assert.equal(isValidCpf('529.982.247-24'), false);
});

test('bloqueia acesso sem login', async () => {
  const r = await call('GET', '/api/patients', null, { noCookie: true });
  assert.equal(r.status, 401);
});

test('primeiro acesso cria administrador (uma única vez)', async () => {
  assert.equal((await call('GET', '/api/setup')).body.needsSetup, true);
  const weak = await call('POST', '/api/setup', { name: 'Admin', email: 'adm@clinica.com', password: '123' });
  assert.equal(weak.status, 422);
  const ok = await call('POST', '/api/setup', { name: 'Dono ClinPay', email: 'root@clinpay.com', password: 'SenhaForte2026' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.user.role, 'superadmin');
  // O administrador ClinPay cadastra a clínica e o médico responsável
  const clinic = await call('POST', '/api/platform/clinics', { name: 'Clínica Teste', owner: { name: 'Administrador', email: 'adm@clinica.com', password: 'SenhaForte2026' } });
  assert.equal(clinic.status, 201, JSON.stringify(clinic.body));
  const again = await call('POST', '/api/setup', { name: 'Outro', email: 'x@x.com', password: 'SenhaForte2026' }, { noCookie: true });
  assert.equal(again.status, 409);
});

test('login errado e certo', async () => {
  const bad = await call('POST', '/api/login', { email: 'adm@clinica.com', password: 'errada000' }, { noCookie: true });
  assert.equal(bad.status, 401);
  const ok = await call('POST', '/api/login', { email: 'adm@clinica.com', password: 'SenhaForte2026' });
  assert.equal(ok.status, 200);
});

test('rejeita envio que não é JSON (proteção CSRF)', async () => {
  const res = await fetch(base + '/api/patients', { method: 'POST', headers: { 'Content-Type': 'text/plain', Cookie: cookie }, body: '{}' });
  assert.equal(res.status, 415);
});

test('cadastros básicos', async () => {
  ids.room1 = (await call('POST', '/api/rooms', { name: 'Sala 1' })).body.id;
  ids.room2 = (await call('POST', '/api/rooms', { name: 'Sala 2' })).body.id;
  assert.equal((await call('POST', '/api/rooms', { name: 'sala 1' })).status, 409);
  ids.surgeon = (await call('POST', '/api/professionals', { name: 'Dra. Ana Cirurgiã', role: 'cirurgiao', council: 'CRM-MG 12345', color: '#1e6bd6' })).body.id;
  ids.surgeon2 = (await call('POST', '/api/professionals', { name: 'Dr. Bruno Cirurgião', role: 'cirurgiao' })).body.id;
  ids.anest = (await call('POST', '/api/professionals', { name: 'Dr. Carlos Anestesista', role: 'anestesista' })).body.id;
  const proc = await call('POST', '/api/procedures', { name: 'Artroscopia de joelho', defaultDurationMin: 90, requiresLaterality: true });
  ids.proc = proc.body.id;
});

test('paciente: CPF, alergias obrigatórias e duplicidade', async () => {
  const base = { name: 'Maria da Silva', birthDate: '1970-05-10', sex: 'F', cpf: '529.982.247-25' };
  const noAllergy = await call('POST', '/api/patients', base);
  assert.equal(noAllergy.status, 422);
  assert.ok(noAllergy.body.fields.allergies);
  const badCpf = await call('POST', '/api/patients', { ...base, cpf: '123.456.789-00', allergies: 'Dipirona' });
  assert.equal(badCpf.status, 422);
  const future = await call('POST', '/api/patients', { ...base, birthDate: '2999-01-01', allergies: 'Dipirona' });
  assert.equal(future.status, 422);
  const ok = await call('POST', '/api/patients', { ...base, allergies: 'Dipirona' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.cpf, '52998224725');
  ids.patient = ok.body.id;
  const dup = await call('POST', '/api/patients', { ...base, noKnownAllergies: true });
  assert.equal(dup.status, 409);
  ids.patient2 = (await call('POST', '/api/patients', { name: 'João Souza', birthDate: '1985-01-01', sex: 'M', noKnownAllergies: true })).body.id;
});

const surgery = () => ({
  type: 'cirurgia', patientId: ids.patient, procedureId: ids.proc, procedureName: 'Artroscopia de joelho', laterality: 'direito',
  surgeonId: ids.surgeon, anesthetistId: ids.anest, teamIds: [], roomId: ids.room1,
  date: '2030-03-10', startTime: '08:00', durationMin: 90, anesthesiaType: 'raquidiana',
  priority: 'eletiva', coverage: 'particular',
});

test('cirurgia: validações de segurança', async () => {
  const noLat = await call('POST', '/api/surgeries', { ...surgery(), laterality: 'nao_se_aplica' });
  assert.equal(noLat.status, 422);
  assert.ok(noLat.body.fields.laterality);
  const noAnest = await call('POST', '/api/surgeries', { ...surgery(), anesthetistId: null });
  assert.equal(noAnest.status, 422);
  assert.ok(noAnest.body.fields.anesthetistId);
  const sameAsSurgeon = await call('POST', '/api/surgeries', { ...surgery(), anesthetistId: ids.surgeon });
  assert.equal(sameAsSurgeon.status, 422);
  const convenioSemNome = await call('POST', '/api/surgeries', { ...surgery(), coverage: 'convenio' });
  assert.equal(convenioSemNome.status, 422);
});

test('cirurgia: agenda e detecta conflitos de sala, equipe e paciente', async () => {
  const ok = await call('POST', '/api/surgeries', surgery());
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  ids.surgery = ok.body.id;
  assert.deepEqual(ok.body.missingDocs, ['termo_cirurgico', 'termo_anestesico']);

  // Mesma sala, começando antes de terminar o tempo de limpeza (termina 09:30 + 30 min)
  const room = await call('POST', '/api/surgeries', { ...surgery(), patientId: ids.patient2, surgeonId: ids.surgeon2, anesthetistId: null, anesthesiaType: 'local', startTime: '09:45' });
  assert.equal(room.status, 409);
  assert.ok(room.body.conflicts.some((c) => c.type === 'sala'));

  // Depois da limpeza, na mesma sala: permitido
  const after = await call('POST', '/api/surgeries', { ...surgery(), patientId: ids.patient2, surgeonId: ids.surgeon2, anesthetistId: null, anesthesiaType: 'local', startTime: '10:00' });
  assert.equal(after.status, 201);

  // Mesmo anestesista em outra sala, horário sobreposto
  const pro = await call('POST', '/api/surgeries', { ...surgery(), patientId: ids.patient2, surgeonId: ids.surgeon2, roomId: ids.room2, startTime: '09:00' });
  assert.equal(pro.status, 409);
  assert.ok(pro.body.conflicts.some((c) => c.type === 'profissional'));

  // Mesmo paciente em outra sala
  const pat = await call('POST', '/api/surgeries', { ...surgery(), surgeonId: ids.surgeon2, anesthetistId: null, anesthesiaType: 'local', roomId: ids.room2, startTime: '08:30' });
  assert.equal(pat.status, 409);
  assert.ok(pat.body.conflicts.some((c) => c.type === 'paciente'));

  // Cirurgia que atravessa a meia-noite conflita com a do dia seguinte
  const night = await call('POST', '/api/surgeries', { ...surgery(), patientId: ids.patient2, surgeonId: ids.surgeon2, anesthetistId: null, anesthesiaType: 'local', date: '2030-03-09', startTime: '23:00', durationMin: 600 });
  assert.equal(night.status, 409);

  // Emergência pode manter conflito somente com justificativa
  const emergNoReason = await call('POST', '/api/surgeries', { ...surgery(), patientId: ids.patient2, surgeonId: ids.surgeon2, anesthetistId: null, anesthesiaType: 'local', priority: 'emergencia', startTime: '09:00', overrideConflicts: true });
  assert.equal(emergNoReason.status, 422);
  const emerg = await call('POST', '/api/surgeries', { ...surgery(), patientId: ids.patient2, surgeonId: ids.surgeon2, anesthetistId: null, anesthesiaType: 'local', priority: 'emergencia', startTime: '09:00', overrideConflicts: true, overrideReason: 'Abdome agudo, única sala disponível' });
  assert.equal(emerg.status, 201);
  assert.equal(emerg.body.conflictOverrides.length, 1);
});

test('cirurgia: não inicia sem termos assinados e checklist', async () => {
  const skip = await call('POST', `/api/surgeries/${ids.surgery}/status`, { status: 'em_andamento' });
  assert.equal(skip.status, 409); // precisa confirmar antes
  assert.equal((await call('POST', `/api/surgeries/${ids.surgery}/status`, { status: 'confirmada' })).status, 200);
  const blocked = await call('POST', `/api/surgeries/${ids.surgery}/status`, { status: 'em_andamento' });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /Assinatura pendente/);
  assert.match(blocked.body.error, /Entrada/);
});

test('assinatura eletrônica: validações, imutabilidade e verificação', async () => {
  const doc = {
    docType: 'termo_cirurgico', title: 'Termo de consentimento cirúrgico',
    content: 'Declaro que fui informada sobre o procedimento, riscos e alternativas.',
    patientId: ids.patient, surgeryId: ids.surgery, signerName: 'Maria da Silva',
    signerRole: 'paciente', signerCpf: '52998224725', agree: true,
  };
  assert.equal((await call('POST', '/api/signatures', { ...doc, image: 'data:image/png;base64,AAAA' })).status, 422);
  assert.equal((await call('POST', '/api/signatures', { ...doc, image: fakePng(), agree: false })).status, 422);
  assert.equal((await call('POST', '/api/signatures', { ...doc, image: fakePng(), signerCpf: null })).status, 422);
  const wrongPatient = await call('POST', '/api/signatures', { ...doc, image: fakePng(), patientId: ids.patient2 });
  assert.equal(wrongPatient.status, 422);
  const ok = await call('POST', '/api/signatures', { ...doc, image: fakePng() });
  assert.equal(ok.status, 201);
  assert.match(ok.body.hash, /^[a-f0-9]{64}$/);
  ids.sig = ok.body.id;
  const ok2 = await call('POST', '/api/signatures', { ...doc, docType: 'termo_anestesico', title: 'Termo anestésico', image: fakePng() });
  assert.equal(ok2.status, 201);
  const view = await call('GET', `/api/signatures/${ids.sig}`);
  assert.equal(view.body.valid, true);
  assert.equal((await call('PUT', `/api/signatures/${ids.sig}`, {})).status, 405);
  assert.equal((await call('DELETE', `/api/signatures/${ids.sig}`)).status, 405);
});

test('checklist em ordem e conclusão da cirurgia', async () => {
  const url = (ph) => `/api/surgeries/${ids.surgery}/checklist/${ph}`;
  assert.equal((await call('PUT', url('pausa'), { items: {}, complete: true })).status, 409);
  const partial = await call('PUT', url('entrada'), { items: { identidade: true }, complete: true });
  assert.equal(partial.status, 422);
  const all = (ph, keys) => Object.fromEntries(keys.map((k) => [k, true]));
  const meta = (await call('GET', '/api/meta')).body;
  const done = await call('PUT', url('entrada'), { items: all('entrada', Object.keys(meta.checklist.entrada.items)), complete: true });
  assert.equal(done.status, 200);
  assert.equal((await call('PUT', url('entrada'), { items: {}, complete: false })).status, 409); // travado
  assert.equal((await call('POST', `/api/surgeries/${ids.surgery}/status`, { status: 'em_andamento' })).status, 200);
  assert.equal((await call('POST', `/api/surgeries/${ids.surgery}/status`, { status: 'concluida' })).status, 409);
  assert.equal((await call('PUT', url('pausa'), { items: all('pausa', Object.keys(meta.checklist.pausa.items)), complete: true })).status, 200);
  assert.equal((await call('PUT', url('saida'), { items: all('saida', Object.keys(meta.checklist.saida.items)), complete: true })).status, 200);
  const fin = await call('POST', `/api/surgeries/${ids.surgery}/status`, { status: 'concluida' });
  assert.equal(fin.status, 200);
  assert.equal(fin.body.status, 'concluida');
  assert.equal((await call('PUT', `/api/surgeries/${ids.surgery}`, surgery())).status, 409);
});

test('cancelamento exige motivo; perfis restritos', async () => {
  const list = (await call('GET', '/api/surgeries?from=2030-03-10&to=2030-03-10')).body;
  const other = list.find((s) => s.status === 'agendada');
  assert.equal((await call('POST', `/api/surgeries/${other.id}/status`, { status: 'cancelada' })).status, 422);
  assert.equal((await call('POST', `/api/surgeries/${other.id}/status`, { status: 'cancelada', reason: 'Paciente desistiu' })).status, 200);

  const admCookie = cookie;
  await call('POST', '/api/users', { name: 'Recepção', email: 'rec@clinica.com', role: 'recepcao', password: 'Recepcao2026x' });
  await call('POST', '/api/login', { email: 'rec@clinica.com', password: 'Recepcao2026x' });
  assert.equal((await call('GET', '/api/audit')).status, 403);
  assert.equal((await call('POST', '/api/rooms', { name: 'Sala X' })).status, 403);
  assert.equal((await call('GET', '/api/patients')).status, 200);
  cookie = admCookie;
  const audit = await call('GET', '/api/audit');
  assert.equal(audit.status, 200);
  assert.ok(audit.body.some((a) => a.action === 'signature'));
  assert.ok(audit.body.some((a) => a.action === 'login_failed'));
});

test('não permite remover o último administrador', async () => {
  const me = (await call('GET', '/api/me')).body.user;
  assert.equal((await call('PUT', `/api/users/${me.id}`, { role: 'recepcao' })).status, 409);
});

test('arquivos estáticos e proteção de caminho', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-security-policy'));
  const trav = await fetch(base + '/..%2fserver.js');
  assert.notEqual(trav.status, 200);
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server');
const { PersistentStore, FileBackend, PgBackend } = require('../src/store/persistentStore');

async function boot(store) {
  const app = createServer(store);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  let cookie = '';
  const call = async (method, url, body, c) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: c ?? cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie'); if (set && c === undefined) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { app, call, getCookie: () => cookie, base };
}

test('dados e login continuam depois de reiniciar o servidor (arquivo)', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clinpay-')), 'dados.jsonl');
  let st = new PersistentStore(new FileBackend(file)); await st.init();
  let s = await boot(st);
  await s.call('POST', '/api/setup', { name: 'Dono', email: 'root@clinpay.com', password: 'SenhaForte2026' });
  await s.call('POST', '/api/platform/clinics', { name: 'Clínica Persistente', owner: { name: 'Dra. A', email: 'a@a.com', password: 'Senha2026abc' } });
  await s.call('POST', '/api/login', { email: 'a@a.com', password: 'Senha2026abc' });
  const p = await s.call('POST', '/api/patients', { name: 'Paciente Salvo', birthDate: '1990-01-01', sex: 'F', noKnownAllergies: true });
  assert.equal(p.status, 201);
  await s.call('PUT', `/api/patients/${p.body.id}`, { phone: '31999998888' });
  const cookie = s.getCookie();
  await new Promise((r) => s.app.close(r));
  await st.queue;

  // "Desliga e liga": novo armazenamento lendo o mesmo arquivo
  st = new PersistentStore(new FileBackend(file)); const n = await st.init();
  assert.ok(n > 150, `carregou ${n} registros`);
  s = await boot(st);
  assert.equal((await s.call('GET', '/api/setup', null, cookie)).body.needsSetup, false); // não pede para criar administrador de novo
  const me = await s.call('GET', '/api/me', null, cookie);
  assert.equal(me.status, 200, 'continua logado depois do reinício');
  assert.equal(me.body.clinic.name, 'Clínica Persistente');
  const pats = (await s.call('GET', '/api/patients', null, cookie)).body;
  assert.equal(pats.length, 1);
  assert.equal(pats[0].phone, '31999998888');
  // Sair encerra a sessão também no arquivo
  await s.call('POST', '/api/logout', null, cookie);
  await new Promise((r) => s.app.close(r));
  await st.queue;
  st = new PersistentStore(new FileBackend(file)); await st.init();
  s = await boot(st);
  assert.equal((await s.call('GET', '/api/me', null, cookie)).status, 401);
  await new Promise((r) => s.app.close(r));
});

test('arquivo: tolera última linha cortada (queda de energia), recusa arquivo danificado no meio', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clinpay-'));
  const f1 = path.join(dir, 'a.jsonl');
  fs.writeFileSync(f1, `${JSON.stringify({ op: 'put', c: 'x', id: '1', d: { id: '1', v: 1 } })}\n{"op":"put","c":"x","id":"2","d":{"id`);
  const s1 = new PersistentStore(new FileBackend(f1));
  assert.equal(await s1.init(), 1);
  const f2 = path.join(dir, 'b.jsonl');
  fs.writeFileSync(f2, `lixo\n${JSON.stringify({ op: 'put', c: 'x', id: '1', d: { id: '1' } })}\n${JSON.stringify({ op: 'put', c: 'x', id: '2', d: { id: '2' } })}\n`);
  await assert.rejects(new PersistentStore(new FileBackend(f2)).init(), /danificado/);
});

test('se o banco falhar, nada muda na memória', async () => {
  let fail = false;
  const backend = { init: async () => {}, loadAll: async () => [], put: async () => { if (fail) throw new Error('banco fora do ar'); }, del: async () => { if (fail) throw new Error('banco fora do ar'); } };
  const st = new PersistentStore(backend); await st.init();
  const doc = await st.insert('patients', { name: 'A' });
  fail = true;
  await assert.rejects(st.insert('patients', { name: 'B' }), /fora do ar/);
  await assert.rejects(st.update('patients', doc.id, { name: 'Alterado' }), /fora do ar/);
  await assert.rejects(st.remove('patients', doc.id), /fora do ar/);
  const all = await st.list('patients');
  assert.equal(all.length, 1);
  assert.equal(all[0].name, 'A');
  fail = false;
  assert.equal((await st.update('patients', doc.id, { name: 'C' })).name, 'C'); // a fila segue funcionando
});

test('PostgreSQL: cria a tabela, grava, atualiza, apaga e recarrega', async () => {
  const table = new Map(); const sql = [];
  class FakePool {
    constructor(opts) { this.opts = opts; }
    async query(text, params = []) {
      sql.push(text.trim().split(/\s+/).slice(0, 3).join(' '));
      if (/^CREATE TABLE/.test(text.trim())) return { rows: [] };
      if (/^SELECT/.test(text.trim())) return { rows: [...table.values()].map((r) => ({ collection: r.collection, data: JSON.parse(r.data) })) };
      if (/^INSERT/.test(text.trim())) { table.set(`${params[0]}|${params[1]}`, { collection: params[0], data: params[2] }); return { rows: [] }; }
      if (/^DELETE/.test(text.trim())) { table.delete(`${params[0]}|${params[1]}`); return { rows: [] }; }
      throw new Error('SQL inesperado');
    }
    async end() {}
  }
  const b = new PgBackend('postgresql://u:p@ep-teste.neon.tech/neondb?sslmode=require', { Pool: FakePool });
  assert.deepEqual(b.pool.opts.ssl, { rejectUnauthorized: true }); // conexão segura com o Neon
  const st = new PersistentStore(b); await st.init();
  assert.equal(sql[0], 'CREATE TABLE IF');
  const a = await st.insert('patients', { name: 'Ana' });
  const c = await st.insert('patients', { name: 'Caio' });
  await st.update('patients', a.id, { name: 'Ana Maria' });
  await st.remove('patients', c.id);
  const st2 = new PersistentStore(new PgBackend('postgresql://x', { Pool: FakePool }));
  st2.backend.pool = b.pool; // mesmo "banco"
  await st2.init();
  const list = await st2.list('patients');
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Ana Maria');
  assert.equal(list[0].createdAt, a.createdAt);
});

test('despertador dos lembretes exige a chave secreta', async () => {
  const s = await boot(undefined);
  delete process.env.CRON_SECRET;
  assert.equal((await s.call('GET', '/api/cron?key=qualquer')).status, 404);
  process.env.CRON_SECRET = 'segredo-de-teste-123456';
  assert.equal((await s.call('GET', '/api/cron?key=errado-de-teste-1234567')).status, 404);
  const ok = await s.call('GET', '/api/cron?key=segredo-de-teste-123456');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal((await s.call('GET', '/api/health')).body.ok, true);
  delete process.env.CRON_SECRET;
  await new Promise((r) => s.app.close(r));
});

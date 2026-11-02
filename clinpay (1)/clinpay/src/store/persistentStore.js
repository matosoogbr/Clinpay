'use strict';

/**
 * Armazenamento que SALVA os dados (não se perdem ao reiniciar).
 *
 * Os dados ficam em memória para leitura rápida e toda gravação é escrita antes no
 * "backend" (PostgreSQL ou arquivo). Se a gravação falhar, a operação falha e a memória
 * não é alterada — assim memória e banco nunca ficam diferentes.
 * As gravações são feitas em fila, uma de cada vez, na ordem em que acontecem.
 *
 * Importante: este modelo foi feito para UM servidor por vez (como no plano gratuito do Render).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { MemoryStore } = require('./memoryStore');

const clone = (v) => (v == null ? v : structuredClone(v));

class PersistentStore extends MemoryStore {
  constructor(backend) {
    super();
    this.backend = backend;
    this.queue = Promise.resolve();
  }

  /** Carrega tudo do banco para a memória. Chame uma vez, antes de ligar o servidor. */
  async init() {
    await this.backend.init();
    const rows = await this.backend.loadAll();
    for (const { collection, doc } of rows) this._col(collection).set(doc.id, doc);
    return rows.length;
  }

  /** Executa gravações em fila (uma por vez, na ordem). */
  _write(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {}); // uma falha não trava as próximas gravações
    return run;
  }

  async insert(collection, doc) {
    const now = new Date().toISOString();
    const record = { ...clone(doc), id: crypto.randomUUID(), createdAt: now, updatedAt: now };
    await this._write(() => this.backend.put(collection, record));
    this._col(collection).set(record.id, record);
    return clone(record);
  }

  async update(collection, id, patch) {
    return this._write(async () => {
      const col = this._col(collection);
      const current = col.get(String(id));
      if (!current) return null;
      const { id: _i, createdAt: _c, ...rest } = clone(patch);
      const updated = { ...current, ...rest, updatedAt: new Date().toISOString() };
      await this.backend.put(collection, updated);
      col.set(current.id, updated);
      return clone(updated);
    });
  }

  async remove(collection, id) {
    return this._write(async () => {
      const col = this._col(collection);
      if (!col.has(String(id))) return false;
      await this.backend.del(collection, String(id));
      col.delete(String(id));
      return true;
    });
  }

  close() { return this.backend.close ? this.backend.close() : undefined; }
}

/**
 * Backend em ARQUIVO (para usar no próprio computador).
 * Diário de alterações em JSON Lines; ao iniciar, compacta o arquivo.
 */
class FileBackend {
  constructor(file) { this.file = path.resolve(file); }

  async init() { await fs.promises.mkdir(path.dirname(this.file), { recursive: true }); }

  async loadAll() {
    const data = new Map(); // "colecao\u0000id" -> { collection, doc }
    let text = '';
    try { text = await fs.promises.readFile(this.file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      let op;
      try { op = JSON.parse(line); } catch {
        // Última linha cortada (ex.: queda de energia durante a gravação): ignora só ela
        if (i >= lines.length - 2) return;
        throw new Error(`Arquivo de dados danificado na linha ${i + 1}. Restaure o backup.`);
      }
      const key = `${op.c}\u0000${op.id}`;
      if (op.op === 'put') data.set(key, { collection: op.c, doc: op.d }); else data.delete(key);
    });
    // Compacta: reescreve só o estado atual (arquivo temporário + troca, para não corromper)
    const tmp = `${this.file}.tmp`;
    await fs.promises.writeFile(tmp, [...data.values()].map((r) => JSON.stringify({ op: 'put', c: r.collection, id: r.doc.id, d: r.doc })).join('\n') + (data.size ? '\n' : ''));
    await fs.promises.rename(tmp, this.file);
    return [...data.values()];
  }

  async put(collection, doc) { await fs.promises.appendFile(this.file, JSON.stringify({ op: 'put', c: collection, id: doc.id, d: doc }) + '\n'); }
  async del(collection, id) { await fs.promises.appendFile(this.file, JSON.stringify({ op: 'del', c: collection, id }) + '\n'); }
}

/**
 * Backend PostgreSQL (Neon, Supabase, Render ou qualquer Postgres).
 * Uma tabela simples com os documentos em JSONB.
 */
class PgBackend {
  constructor(connectionString, { Pool } = {}) {
    // O pacote "pg" só é exigido quando o PostgreSQL é usado
    const PoolClass = Pool || require('pg').Pool;
    this.pool = new PoolClass({
      connectionString,
      max: 5,
      ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: true },
      connectionTimeoutMillis: 20000,
      idleTimeoutMillis: 30000,
    });
  }

  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS clinpay_docs (
      collection text NOT NULL,
      id text NOT NULL,
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (collection, id)
    )`);
  }

  async loadAll() {
    const { rows } = await this.pool.query('SELECT collection, data FROM clinpay_docs');
    return rows.map((r) => ({ collection: r.collection, doc: typeof r.data === 'string' ? JSON.parse(r.data) : r.data }));
  }

  async put(collection, doc) {
    await this.pool.query(
      `INSERT INTO clinpay_docs (collection, id, data, updated_at) VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (collection, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [collection, doc.id, JSON.stringify(doc)],
    );
  }

  async del(collection, id) {
    await this.pool.query('DELETE FROM clinpay_docs WHERE collection = $1 AND id = $2', [collection, id]);
  }

  close() { return this.pool.end(); }
}

/**
 * Escolhe onde salvar:
 * - DATABASE_URL definido  -> PostgreSQL (uso no ar)
 * - senão                  -> arquivo em ./dados/clinpay-dados.jsonl (ou DATA_FILE)
 */
async function createPersistentStore(env = process.env) {
  const backend = env.DATABASE_URL
    ? new PgBackend(env.DATABASE_URL)
    : new FileBackend(env.DATA_FILE || path.join(__dirname, '..', '..', 'dados', 'clinpay-dados.jsonl'));
  const store = new PersistentStore(backend);
  const n = await store.init();
  return { store, kind: env.DATABASE_URL ? 'PostgreSQL' : `arquivo ${backend.file}`, records: n };
}

module.exports = { PersistentStore, FileBackend, PgBackend, createPersistentStore };

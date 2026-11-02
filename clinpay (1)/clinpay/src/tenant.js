'use strict';

/**
 * Isolamento de dados entre clínicas (multi-clínica).
 *
 * Cada requisição roda dentro de um "contexto" que diz de qual clínica é o usuário.
 * O TenantStore envolve o armazenamento e, em TODA leitura e escrita:
 *   - filtra pelos registros da clínica do contexto;
 *   - carimba a clínica nos registros novos;
 *   - impede alterar ou apagar registros de outra clínica.
 * Sem clínica no contexto, o acesso às coleções da clínica é RECUSADO (falha fechada).
 * Assim, nenhuma rota consegue, nem por engano, ler dados de outra clínica.
 *
 * Coleções globais (da plataforma ClinPay): clinics e platform_audit.
 * Para elas, e para login/sessão, use store.base (sem filtro).
 */

const { AsyncLocalStorage } = require('node:async_hooks');

const GLOBAL_COLLECTIONS = new Set(['clinics', 'platform_audit']);

class NoClinicError extends Error {
  constructor() {
    super('Nenhuma clínica selecionada.');
    this.code = 'NO_CLINIC';
  }
}

class TenantStore {
  constructor(base) {
    this.base = base;
    this.als = new AsyncLocalStorage();
  }

  /** Executa fn com o contexto { clinicId, user }. */
  run(ctx, fn) { return this.als.run(ctx, fn); }

  current() { return this.als.getStore() || null; }

  clinicId() {
    const c = this.current();
    return c && c.clinicId ? c.clinicId : null;
  }

  _cid(collection) {
    if (GLOBAL_COLLECTIONS.has(collection)) return null;
    const cid = this.clinicId();
    if (!cid) throw new NoClinicError();
    return cid;
  }

  async list(collection, filterFn) {
    const cid = this._cid(collection);
    return this.base.list(collection, (d) => (cid === null || d.clinicId === cid) && (!filterFn || filterFn(d)));
  }

  async get(collection, id) {
    const cid = this._cid(collection);
    const doc = await this.base.get(collection, id);
    if (!doc || (cid !== null && doc.clinicId !== cid)) return null;
    return doc;
  }

  async findOne(collection, filterFn) {
    const cid = this._cid(collection);
    return this.base.findOne(collection, (d) => (cid === null || d.clinicId === cid) && filterFn(d));
  }

  async insert(collection, doc) {
    const cid = this._cid(collection);
    return this.base.insert(collection, cid === null ? doc : { ...doc, clinicId: cid });
  }

  async update(collection, id, patch) {
    const cid = this._cid(collection);
    const current = await this.get(collection, id);
    if (!current) return null;
    const { clinicId: _ignore, ...safe } = patch;
    if (cid === null && 'clinicId' in patch) safe.clinicId = patch.clinicId;
    return this.base.update(collection, current.id, safe);
  }

  async remove(collection, id) {
    const current = await this.get(collection, id);
    if (!current) return false;
    return this.base.remove(collection, current.id);
  }

  async count(collection) {
    return (await this.list(collection)).length;
  }
}

module.exports = { TenantStore, NoClinicError, GLOBAL_COLLECTIONS };

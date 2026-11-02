'use strict';

/**
 * Repositório em memória.
 *
 * ESTE É O ÚNICO ARQUIVO QUE PRECISA SER SUBSTITUÍDO NA INTEGRAÇÃO COM O BANCO.
 * Toda a aplicação conversa apenas com estes métodos (todos assíncronos):
 *
 *   list(collection, filterFn?)      -> Promise<Array>
 *   get(collection, id)              -> Promise<Object|null>
 *   findOne(collection, filterFn)    -> Promise<Object|null>
 *   insert(collection, doc)          -> Promise<Object>   (gera id, createdAt, updatedAt)
 *   update(collection, id, patch)    -> Promise<Object|null>
 *   remove(collection, id)           -> Promise<boolean>
 *   count(collection)                -> Promise<number>
 *
 * Coleções usadas: users, patients, professionals, rooms, procedures,
 * surgeries, signatures, audit.
 *
 * ATENÇÃO: em memória, todos os dados se perdem ao reiniciar o servidor.
 * Não use em produção antes da integração com o banco.
 */

const crypto = require('node:crypto');

const clone = (v) => (v == null ? v : structuredClone(v));

class MemoryStore {
  constructor() {
    this.data = new Map();
  }

  _col(name) {
    if (!this.data.has(name)) this.data.set(name, new Map());
    return this.data.get(name);
  }

  async list(collection, filterFn) {
    const all = [...this._col(collection).values()].map(clone);
    return filterFn ? all.filter(filterFn) : all;
  }

  async get(collection, id) {
    return clone(this._col(collection).get(String(id)) || null);
  }

  async findOne(collection, filterFn) {
    for (const doc of this._col(collection).values()) {
      if (filterFn(doc)) return clone(doc);
    }
    return null;
  }

  async insert(collection, doc) {
    const now = new Date().toISOString();
    const record = { ...clone(doc), id: crypto.randomUUID(), createdAt: now, updatedAt: now };
    this._col(collection).set(record.id, record);
    return clone(record);
  }

  async update(collection, id, patch) {
    const col = this._col(collection);
    const current = col.get(String(id));
    if (!current) return null;
    const { id: _ignore, createdAt: _c, ...rest } = clone(patch);
    const updated = { ...current, ...rest, updatedAt: new Date().toISOString() };
    col.set(current.id, updated);
    return clone(updated);
  }

  async remove(collection, id) {
    return this._col(collection).delete(String(id));
  }

  async count(collection) {
    return this._col(collection).size;
  }
}

module.exports = { MemoryStore };

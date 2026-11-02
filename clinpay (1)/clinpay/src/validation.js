'use strict';

const { HttpError } = require('./http/core');

const onlyDigits = (s) => String(s ?? '').replace(/\D/g, '');

function isValidCpf(value) {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const calc = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cpf[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(cpf[9]) && calc(10) === Number(cpf[10]);
}

function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const isValidTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s));
const isValidEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s));

/**
 * Valida um objeto contra um esquema simples.
 * Cada campo: { type, required, label, max, min, values, items, custom }
 * type: string | text | int | bool | date | time | email | cpf | enum | array | color
 * partial=true ignora campos ausentes (para atualizações).
 */
function validate(input, schema, { partial = false } = {}) {
  const out = {};
  const errors = {};
  for (const [key, rule] of Object.entries(schema)) {
    const label = rule.label || key;
    let v = input[key];
    const absent = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    if (absent) {
      if (partial && v === undefined) continue;
      if (rule.required) { errors[key] = `${label} é obrigatório.`; continue; }
      out[key] = rule.type === 'array' ? [] : rule.type === 'bool' ? false : null;
      continue;
    }
    switch (rule.type) {
      case 'string':
      case 'text': {
        if (typeof v !== 'string' && typeof v !== 'number') { errors[key] = `${label} inválido.`; break; }
        v = String(v).trim();
        const max = rule.max ?? (rule.type === 'text' ? 5000 : 200);
        if (v.length > max) { errors[key] = `${label} deve ter no máximo ${max} caracteres.`; break; }
        if (rule.min && v.length < rule.min) { errors[key] = `${label} deve ter pelo menos ${rule.min} caracteres.`; break; }
        out[key] = v;
        break;
      }
      case 'int': {
        const n = Number(v);
        if (!Number.isInteger(n)) { errors[key] = `${label} deve ser um número inteiro.`; break; }
        if (rule.min != null && n < rule.min) { errors[key] = `${label} deve ser no mínimo ${rule.min}.`; break; }
        if (rule.max != null && n > rule.max) { errors[key] = `${label} deve ser no máximo ${rule.max}.`; break; }
        out[key] = n;
        break;
      }
      case 'bool':
        if (typeof v !== 'boolean') { errors[key] = `${label} inválido.`; break; }
        out[key] = v;
        break;
      case 'date':
        if (!isValidDate(v)) { errors[key] = `${label}: data inválida.`; break; }
        out[key] = v;
        break;
      case 'time':
        if (!isValidTime(v)) { errors[key] = `${label}: horário inválido (use HH:MM).`; break; }
        out[key] = v;
        break;
      case 'email':
        v = String(v).trim().toLowerCase();
        if (!isValidEmail(v) || v.length > 200) { errors[key] = `${label}: e-mail inválido.`; break; }
        out[key] = v;
        break;
      case 'cpf':
        if (!isValidCpf(v)) { errors[key] = `${label}: CPF inválido.`; break; }
        out[key] = onlyDigits(v);
        break;
      case 'enum':
        if (!rule.values.includes(v)) { errors[key] = `${label}: opção inválida.`; break; }
        out[key] = v;
        break;
      case 'color':
        if (!/^#[0-9a-fA-F]{6}$/.test(String(v))) { errors[key] = `${label}: cor inválida.`; break; }
        out[key] = v;
        break;
      case 'array': {
        if (!Array.isArray(v)) { errors[key] = `${label} inválido.`; break; }
        if (rule.max && v.length > rule.max) { errors[key] = `${label}: itens demais.`; break; }
        const items = [];
        for (const it of v) {
          if (typeof it !== 'string' || it.length > 200) { errors[key] = `${label}: item inválido.`; break; }
          const t = it.trim();
          if (t) items.push(t);
        }
        if (!errors[key]) out[key] = [...new Set(items)];
        break;
      }
      default:
        throw new Error(`Tipo de validação desconhecido: ${rule.type}`);
    }
    if (!errors[key] && rule.custom) {
      const msg = rule.custom(out[key], input);
      if (msg) errors[key] = msg;
    }
  }
  if (Object.keys(errors).length) {
    throw new HttpError(422, 'Revise os campos destacados.', errors);
  }
  return out;
}

module.exports = { validate, isValidCpf, isValidDate, isValidTime, onlyDigits };

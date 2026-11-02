'use strict';

/**
 * Agenda inteligente.
 * - Expediente de cada médico (dias e horários de atendimento).
 * - Sugestão automática dos próximos horários livres, sem conflito de médico, sala e paciente.
 * - Link de confirmação: o paciente confirma ou cancela pelo celular, sem login,
 *   usando um código secreto enviado no e-mail/WhatsApp de lembrete.
 */

const crypto = require('node:crypto');
const { HttpError, sendJson } = require('../http/core');
const { validate, isValidTime } = require('../validation');
const S = require('../domain/surgeries');

// Expediente padrão: segunda a sexta, 08:00–12:00 e 13:00–18:00
const DEFAULT_HOURS = { 1: [['08:00', '12:00'], ['13:00', '18:00']], 2: [['08:00', '12:00'], ['13:00', '18:00']], 3: [['08:00', '12:00'], ['13:00', '18:00']], 4: [['08:00', '12:00'], ['13:00', '18:00']], 5: [['08:00', '12:00'], ['13:00', '18:00']] };

const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMin = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const newToken = () => crypto.randomBytes(24).toString('base64url');

/** Valida o expediente: { "0".."6": [["08:00","12:00"], ...] } (0 = domingo). Lança HttpError. */
function validateWorkHours(wh) {
  if (wh == null) return null;
  if (typeof wh !== 'object' || Array.isArray(wh)) throw new HttpError(422, 'Expediente inválido.', { workHours: 'Formato inválido.' });
  const out = {};
  for (const [day, ranges] of Object.entries(wh)) {
    if (!/^[0-6]$/.test(day) || !Array.isArray(ranges) || ranges.length > 4) throw new HttpError(422, 'Expediente inválido.', { workHours: 'Dia inválido.' });
    const clean = [];
    for (const r of ranges) {
      if (!Array.isArray(r) || r.length !== 2 || !isValidTime(r[0]) || !isValidTime(r[1]) || toMin(r[0]) >= toMin(r[1])) {
        throw new HttpError(422, 'Horário de expediente inválido: o início deve ser antes do fim.', { workHours: 'Horário inválido.' });
      }
      clean.push([r[0], r[1]]);
    }
    clean.sort((a, b) => toMin(a[0]) - toMin(b[0]));
    for (let i = 1; i < clean.length; i++) {
      if (toMin(clean[i][0]) < toMin(clean[i - 1][1])) throw new HttpError(422, 'Os períodos do expediente se sobrepõem.', { workHours: 'Períodos sobrepostos.' });
    }
    if (clean.length) out[day] = clean;
  }
  return out;
}

function registerSchedule(r, store, { requirePerm, query, readJsonBody, lookupFns, fin, notifier, audit }) {
  const base = store.base || store;

  r.get('/api/schedule/suggest', async (req, res) => {
    requirePerm(req, 'surgeries:read');
    const q = query(req);
    const p = validate(Object.fromEntries(q), {
      professionalId: { type: 'string', required: true, label: 'Médico' },
      durationMin: { type: 'int', required: true, label: 'Duração', min: 10, max: 600 },
      from: { type: 'date', label: 'A partir de' },
      days: { type: 'int', label: 'Dias', min: 1, max: 60 },
      limit: { type: 'int', label: 'Quantidade', min: 1, max: 50 },
      roomId: { type: 'string' }, patientId: { type: 'string' }, excludeId: { type: 'string' },
      type: { type: 'enum', values: Object.keys(S.TYPES) },
    });
    const pro = await store.get('professionals', p.professionalId);
    if (!pro) throw new HttpError(404, 'Médico não encontrado.');
    const hours = pro.workHours && Object.keys(pro.workHours).length ? pro.workHours : DEFAULT_HOURS;
    const lookup = await lookupFns();
    const others = await store.list('surgeries', (s) => s.id !== p.excludeId && S.OCCUPYING.includes(s.status));
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const start = p.from && p.from > today ? p.from : today;
    const [y, m, d] = start.split('-').map(Number);
    const step = 15;
    const out = [];
    for (let i = 0; i < (p.days || 21) && out.length < (p.limit || 12); i++) {
      const day = new Date(y, m - 1, d + i);
      const date = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
      for (const [a, b] of hours[String(day.getDay())] || []) {
        for (let t = toMin(a); t + p.durationMin <= toMin(b) && out.length < (p.limit || 12); t += step) {
          if (date === today && t < now.getHours() * 60 + now.getMinutes() + 30) continue; // pelo menos 30 min de antecedência
          const cand = {
            id: '__sugestao__', type: p.type || 'consulta', date, startTime: fromMin(t), durationMin: p.durationMin,
            surgeonId: pro.id, roomId: p.roomId || null, patientId: p.patientId || '__nenhum__', teamIds: [], anesthetistId: null,
          };
          if (!S.findConflicts(cand, others, lookup).length) out.push({ date, startTime: fromMin(t), weekday: day.getDay() });
        }
      }
    }
    sendJson(res, 200, { professionalId: pro.id, usesDefaultHours: hours === DEFAULT_HOURS, slots: out });
  });

  // ---------- Confirmação pelo paciente (sem login, por código secreto) ----------
  async function byToken(token) {
    if (typeof token !== 'string' || token.length < 20) return null;
    return base.findOne('surgeries', (s) => s.confirmToken === token);
  }

  async function publicView(s) {
    const [clinic, pro, patient] = await Promise.all([
      base.get('clinics', s.clinicId), base.get('professionals', s.surgeonId), base.get('patients', s.patientId),
    ]);
    // Mostra o mínimo: nada de diagnóstico, procedimento ou dados clínicos
    return {
      clinicName: clinic ? clinic.name : '', clinicPhone: clinic ? clinic.phone || null : null,
      patientFirstName: patient ? (patient.socialName || patient.name).split(' ')[0] : '',
      professionalName: pro ? pro.name : '', type: s.type || 'cirurgia',
      date: s.date, startTime: s.startTime, status: s.status,
      canAnswer: ['agendada', 'confirmada'].includes(s.status) && new Date(`${s.date}T${s.startTime}:00`) > new Date(),
    };
  }

  r.get('/api/public/appointment', async (req, res) => {
    const s = await byToken(query(req).get('t'));
    if (!s) throw new HttpError(404, 'Link inválido ou expirado.');
    sendJson(res, 200, await publicView(s));
  });

  r.post('/api/public/appointment', async (req, res) => {
    const body = await readJsonBody(req);
    const s = await byToken(body.t);
    if (!s) throw new HttpError(404, 'Link inválido ou expirado.');
    const action = body.action;
    if (!['confirmar', 'cancelar'].includes(action)) throw new HttpError(422, 'Ação inválida.');
    const view = await publicView(s);
    if (!view.canAnswer) throw new HttpError(409, 'Este agendamento não pode mais ser alterado por aqui. Entre em contato com a clínica.');
    await store.run({ clinicId: s.clinicId, user: null }, async () => {
      const now = new Date().toISOString();
      const next = action === 'confirmar' ? (s.status === 'agendada' ? 'confirmada' : null) : 'cancelada';
      if (!next) return; // já confirmada
      const reason = action === 'cancelar' ? 'Cancelado pelo paciente pelo link de confirmação' : 'Confirmado pelo paciente pelo link';
      const updated = await store.update('surgeries', s.id, {
        status: next, patientResponse: action, patientResponseAt: now,
        statusHistory: [...(s.statusHistory || []), { status: next, at: now, byId: null, byName: 'Paciente (link)', reason }],
      });
      const sys = { id: null, name: 'Paciente (link)', role: 'sistema' };
      if (next === 'cancelada') {
        await fin.onAppointmentCanceled(updated, sys);
        await notifier.surgeryEvent('cancelada', updated);
      }
      await audit(store, req, null, 'status', 'surgeries', s.id, reason);
    });
    sendJson(res, 200, await publicView(await base.get('surgeries', s.id)));
  });
}

module.exports = { registerSchedule, validateWorkHours, DEFAULT_HOURS, newToken };

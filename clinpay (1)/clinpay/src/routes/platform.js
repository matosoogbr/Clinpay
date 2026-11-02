'use strict';

/**
 * Painel da plataforma ClinPay (somente administradores ClinPay).
 * - Cadastra clínicas parceiras e o médico responsável de cada uma.
 * - Suspende ou reativa clínicas.
 * - Cadastra outros administradores ClinPay.
 * - Permite entrar em uma clínica (suporte). Toda entrada fica registrada
 *   na auditoria da própria clínica.
 */

const { HttpError, sendJson } = require('../http/core');
const { validate, onlyDigits } = require('../validation');
const auth = require('../auth');
const { audit } = require('../audit');
const F = require('../domain/finance');
const { CATALOG } = require('../domain/procedures-catalog');

function isValidCnpj(v) {
  const c = onlyDigits(v);
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const calc = (len) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = w.reduce((s, x, i) => s + x * Number(c[i]), 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(c[12]) && calc(13) === Number(c[13]);
}

const clinicSchema = {
  name: { type: 'string', required: true, label: 'Nome da clínica', min: 3, max: 120 },
  cnpj: { type: 'string', label: 'CNPJ', max: 20, custom: (v) => (v && !isValidCnpj(v) ? 'CNPJ inválido.' : null) },
  phone: { type: 'string', label: 'Telefone', max: 30 },
  email: { type: 'email', label: 'E-mail da clínica' },
  city: { type: 'string', label: 'Cidade', max: 100 },
  color: { type: 'color', label: 'Cor da clínica' },
  notes: { type: 'text', label: 'Observações internas', max: 2000 },
};

function registerPlatform(r, store, { requirePerm, readJsonBody }) {
  const base = store.base;
  const inClinic = (clinicId, fn) => store.run({ clinicId, user: null }, fn);
  const normalize = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

  async function stats(c) {
    const monthStart = new Date().toISOString().slice(0, 8) + '01';
    const [users, patients, appts, charges] = await Promise.all([
      base.list('users', (u) => u.clinicId === c.id),
      base.list('patients', (p) => p.clinicId === c.id),
      base.list('surgeries', (s) => s.clinicId === c.id),
      base.list('charges', (x) => x.clinicId === c.id),
    ]);
    let receivedMonthCents = 0;
    for (const ch of charges) for (const p of F.activePayments(ch)) if (p.paidAt >= monthStart) receivedMonthCents += p.amountCents;
    const today = new Date().toISOString().slice(0, 10);
    return {
      users: users.filter((u) => u.active).length,
      patients: patients.length,
      upcoming: appts.filter((s) => s.date >= today && ['agendada', 'confirmada'].includes(s.status)).length,
      receivedMonthCents,
      lastActivity: [...users].map((u) => u.updatedAt).sort().pop() || c.createdAt,
    };
  }

  r.get('/api/platform/clinics', async (req, res) => {
    requirePerm(req, 'platform:manage');
    const list = await base.list('clinics');
    list.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    sendJson(res, 200, await Promise.all(list.map(async (c) => ({ ...c, stats: await stats(c) }))));
  });

  r.post('/api/platform/clinics', async (req, res) => {
    const u = requirePerm(req, 'platform:manage');
    const body = await readJsonBody(req);
    const errors = {};
    let data = {}; let owner = {};
    // Valida clínica e médico juntos, para mostrar todos os erros de uma vez
    try { data = validate(body, clinicSchema); } catch (e) { if (!e.details) throw e; Object.assign(errors, e.details); }
    try {
      owner = validate(body.owner || {}, {
        name: { type: 'string', required: true, label: 'Nome do médico responsável', min: 3 },
        email: { type: 'email', required: true, label: 'E-mail de acesso do médico' },
        specialty: { type: 'string', label: 'Especialidade', max: 120 },
        council: { type: 'string', label: 'CRM', max: 40 },
      });
    } catch (e) {
      if (!e.details) throw e;
      for (const [k, v] of Object.entries(e.details)) errors[`owner.${k}`] = v;
    }
    const pwErr = auth.passwordProblem(body.owner && body.owner.password);
    if (pwErr) errors['owner.password'] = pwErr;
    if (owner.email && await base.findOne('users', (x) => x.email === owner.email)) errors['owner.email'] = 'Este e-mail já é usado por outro acesso.';
    if (data.name && await base.findOne('clinics', (c) => normalize(c.name) === normalize(data.name))) errors.name = 'Já existe uma clínica com este nome.';
    if (data.cnpj && await base.findOne('clinics', (c) => c.cnpj && onlyDigits(c.cnpj) === onlyDigits(data.cnpj))) errors.cnpj = 'CNPJ já cadastrado.';
    if (Object.keys(errors).length) throw new HttpError(422, 'Revise os campos destacados.', errors);

    const clinic = await base.insert('clinics', {
      ...data, cnpj: data.cnpj ? onlyDigits(data.cnpj) : null, color: data.color || '#1565D8', status: 'ativa',
      createdById: u.id, createdByName: u.name,
    });
    // Médico responsável: aparece na agenda e tem acesso total à própria clínica
    const ownerUser = await inClinic(clinic.id, async () => {
      const pro = await store.insert('professionals', {
        name: owner.name, role: 'medico', specialty: owner.specialty, council: owner.council, email: owner.email,
        emailReminders: false, phone: null, color: '#1565D8', consultPriceCents: null, active: true,
      });
      const user = await store.insert('users', {
        name: owner.name, email: owner.email, role: 'admin', professionalId: pro.id, active: true,
        passwordHash: auth.hashPassword(body.owner.password),
      });
      // Catálogo odontológico padrão já disponível para agendar (preços e códigos ficam com a clínica)
      for (const [category, name, defaultDurationMin, kind] of CATALOG) {
        await store.insert('procedures', { name, category, defaultDurationMin, kind, code: null, priceCents: null, requiresLaterality: false, active: true });
      }
      await audit(store, req, u, 'create', 'clinics', clinic.id, `Clínica criada pela ClinPay; responsável: ${owner.name}`);
      return user;
    });
    await audit(store, req, u, 'create', 'clinics', clinic.id, `${clinic.name} — responsável ${owner.name} (${owner.email})`);
    sendJson(res, 201, { ...clinic, owner: auth.publicUser(ownerUser) });
  });

  r.put('/api/platform/clinics/:id', async (req, res) => {
    const u = requirePerm(req, 'platform:manage');
    const current = await base.get('clinics', req.params.id);
    if (!current) throw new HttpError(404, 'Clínica não encontrada.');
    const body = await readJsonBody(req);
    const data = validate(body, { ...clinicSchema, status: { type: 'enum', label: 'Situação', values: ['ativa', 'suspensa'] } }, { partial: true });
    if (data.name && normalize(data.name) !== normalize(current.name) &&
      await base.findOne('clinics', (c) => c.id !== current.id && normalize(c.name) === normalize(data.name))) {
      throw new HttpError(422, 'Já existe uma clínica com este nome.', { name: 'Nome já usado.' });
    }
    if (data.cnpj) data.cnpj = onlyDigits(data.cnpj);
    const updated = await base.update('clinics', current.id, data);
    if (data.status === 'suspensa' && current.status !== 'suspensa') {
      const users = await base.list('users', (x) => x.clinicId === current.id);
      await auth.destroyClinicSessions(users.map((x) => x.id));
    }
    if (data.status && data.status !== current.status) {
      await inClinic(current.id, () => audit(store, req, u, 'status', 'clinics', current.id, `Clínica ${data.status === 'ativa' ? 'reativada' : 'suspensa'} pela ClinPay`));
    }
    await audit(store, req, u, 'update', 'clinics', current.id, `${updated.name}${data.status ? ` — ${data.status}` : ''}`);
    sendJson(res, 200, updated);
  });

  // Entrar em uma clínica para dar suporte
  r.post('/api/platform/enter', async (req, res) => {
    const u = requirePerm(req, 'platform:manage');
    const body = await readJsonBody(req);
    const clinic = await base.get('clinics', String(body.clinicId || ''));
    if (!clinic) throw new HttpError(404, 'Clínica não encontrada.');
    await auth.setActiveClinic(req.sessionToken, clinic.id);
    await inClinic(clinic.id, () => audit(store, req, u, 'support_access', 'clinics', clinic.id, 'Administrador ClinPay entrou na clínica'));
    sendJson(res, 200, { ok: true, clinic: { id: clinic.id, name: clinic.name } });
  });

  r.post('/api/platform/leave', async (req, res) => {
    requirePerm(req, 'platform:manage');
    await auth.setActiveClinic(req.sessionToken, null);
    sendJson(res, 200, { ok: true });
  });

  // Administradores da plataforma
  r.get('/api/platform/admins', async (req, res) => {
    requirePerm(req, 'platform:manage');
    const list = await base.list('users', (x) => x.role === auth.PLATFORM_ROLE);
    sendJson(res, 200, list.map(auth.publicUser).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')));
  });

  r.post('/api/platform/admins', async (req, res) => {
    const u = requirePerm(req, 'platform:manage');
    const body = await readJsonBody(req);
    const data = validate(body, {
      name: { type: 'string', required: true, label: 'Nome', min: 3 },
      email: { type: 'email', required: true, label: 'E-mail' },
    });
    const pwErr = auth.passwordProblem(body.password);
    if (pwErr) throw new HttpError(422, pwErr, { password: pwErr });
    if (await base.findOne('users', (x) => x.email === data.email)) throw new HttpError(409, 'Já existe um acesso com este e-mail.', { email: 'E-mail já cadastrado.' });
    const admin = await base.insert('users', {
      ...data, role: auth.PLATFORM_ROLE, clinicId: null, professionalId: null, active: true, passwordHash: auth.hashPassword(body.password),
    });
    await audit(store, req, u, 'create', 'users', admin.id, `Administrador ClinPay: ${admin.name}`);
    sendJson(res, 201, auth.publicUser(admin));
  });

  r.put('/api/platform/admins/:id', async (req, res) => {
    const u = requirePerm(req, 'platform:manage');
    const current = await base.get('users', req.params.id);
    if (!current || current.role !== auth.PLATFORM_ROLE) throw new HttpError(404, 'Administrador não encontrado.');
    const body = await readJsonBody(req);
    const data = validate(body, {
      name: { type: 'string', label: 'Nome', min: 3 },
      active: { type: 'bool', label: 'Ativo' },
    }, { partial: true });
    if (data.active === false) {
      if (current.id === u.id) throw new HttpError(409, 'Você não pode desativar o próprio acesso.');
      const actives = await base.list('users', (x) => x.role === auth.PLATFORM_ROLE && x.active);
      if (actives.length <= 1) throw new HttpError(409, 'É preciso manter pelo menos um administrador ClinPay ativo.');
    }
    const patch = { ...data };
    if (body.password) {
      const pwErr = auth.passwordProblem(body.password);
      if (pwErr) throw new HttpError(422, pwErr, { password: pwErr });
      patch.passwordHash = auth.hashPassword(body.password);
    }
    const updated = await base.update('users', current.id, patch);
    if (patch.passwordHash || data.active === false) await auth.destroyUserSessions(current.id);
    await audit(store, req, u, 'update', 'users', current.id, `Administrador ClinPay: ${updated.name}`);
    sendJson(res, 200, auth.publicUser(updated));
  });

  r.get('/api/platform/audit', async (req, res) => {
    requirePerm(req, 'platform:manage');
    const list = await base.list('platform_audit');
    list.sort((a, b) => b.at.localeCompare(a.at));
    sendJson(res, 200, list.slice(0, 1000));
  });
}

module.exports = { registerPlatform, isValidCnpj };

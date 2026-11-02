'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const { HttpError, Router, sendJson, readJsonBody, clientIp } = require('../http/core');
const { validate } = require('../validation');
const auth = require('../auth');
const { audit } = require('../audit');
const S = require('../domain/surgeries');
const N = require('../notifications');
const F = require('../domain/finance');
const { registerFinance } = require('./finance');
const { registerPlatform } = require('./platform');
const { registerRecords, EXAM_CATEGORIES, FILE_KINDS, TOOTH_STATUS, TEETH } = require('./records');
const { registerSchedule, validateWorkHours, newToken } = require('./schedule');
const { registerCrm, STAGES, SOURCES, QUOTE_STATUS } = require('./crm');
const { registerAnalytics } = require('./analytics');
const { registerAi } = require('./ai');
const { registerDre } = require('./dre');
const { CATALOG } = require('../domain/procedures-catalog');

function buildApi(store, notifier = N.createNotifier(store), opts = {}) {
  const r = new Router();

  // ---------------- Helpers ----------------
  const requireUser = (req) => {
    if (!req.user) throw new HttpError(401, 'Sessão expirada. Entre novamente.');
    return req.user;
  };
  const requirePerm = (req, perm) => {
    const u = requireUser(req);
    if (!auth.can(u, perm)) throw new HttpError(403, 'Seu perfil não tem permissão para esta ação.');
    return u;
  };
  const mustGet = async (col, id, label) => {
    const doc = await store.get(col, id);
    if (!doc) throw new HttpError(404, `${label} não encontrado(a).`);
    return doc;
  };
  const query = (req) => new URL(req.url, 'http://x').searchParams;
  const fin = registerFinance(r, store, { requirePerm, mustGet, query });
  registerDre(r, store, { requirePerm, query });
  // Armazenamento sem filtro de clínica: só para login, sessão e unicidade de e-mail
  const base = store.base || store;
  const inClinic = (clinicId, fn) => (store.run ? store.run({ clinicId }, fn) : fn());
  registerPlatform(r, store, { requirePerm, readJsonBody });
  registerRecords(r, store, { requirePerm, mustGet, query, readJsonBody });
  registerCrm(r, store, { requirePerm, mustGet, query, readJsonBody });
  const analytics = registerAnalytics(r, store, { requirePerm, query, readJsonBody });
  registerAi(r, store, { requirePerm, readJsonBody, analytics, ai: opts.ai || {} });
  registerSchedule(r, store, { requirePerm, query, readJsonBody, lookupFns: () => lookupFns(), fin, notifier, audit });

  // ---------------- Primeiro acesso ----------------
  r.get('/api/setup', async (req, res) => {
    sendJson(res, 200, { needsSetup: (await base.count('users')) === 0, clinicName: config.clinicName });
  });

  r.post('/api/setup', async (req, res) => {
    if ((await base.count('users')) > 0) throw new HttpError(409, 'O sistema já foi configurado.');
    const body = await readJsonBody(req);
    const data = validate(body, {
      name: { type: 'string', required: true, label: 'Nome', min: 3 },
      email: { type: 'email', required: true, label: 'E-mail' },
    });
    const pwErr = auth.passwordProblem(body.password);
    if (pwErr) throw new HttpError(422, pwErr, { password: pwErr });
    // O primeiro usuário é o administrador da plataforma ClinPay (não pertence a nenhuma clínica)
    const user = await base.insert('users', {
      ...data, role: auth.PLATFORM_ROLE, clinicId: null, active: true, passwordHash: auth.hashPassword(body.password), professionalId: null,
    });
    await audit(store, req, user, 'create', 'users', user.id, 'Administrador ClinPay inicial criado');
    const token = await auth.createSession(user.id);
    res.setHeader('Set-Cookie', auth.sessionCookie(token, config.sessionTtlMin * 60));
    sendJson(res, 201, { user: auth.publicUser(user) });
  });

  // ---------------- Autenticação ----------------
  r.post('/api/login', async (req, res) => {
    const body = await readJsonBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const key = auth.checkLoginAllowed(req, email);
    const user = await base.findOne('users', (u) => u.email === email);
    const ok = user && user.active && auth.verifyPassword(String(body.password || ''), user.passwordHash);
    if (!ok) {
      auth.registerLoginFailure(key);
      // Tentativa no e-mail de um usuário de clínica: registra na auditoria da clínica; senão, na da plataforma
      await inClinic((user && user.clinicId) || null,
        () => audit(store, req, null, 'login_failed', 'users', user ? user.id : null, `Tentativa para ${email.slice(0, 100)}`));
      throw new HttpError(401, 'E-mail ou senha incorretos.');
    }
    auth.clearLoginFailures(key);
    if (user.role !== auth.PLATFORM_ROLE) {
      const clinic = user.clinicId ? await base.get('clinics', user.clinicId) : null;
      if (!clinic || clinic.status !== 'ativa') {
        throw new HttpError(403, 'O acesso desta clínica está suspenso. Entre em contato com o suporte ClinPay.');
      }
    }
    const token = await auth.createSession(user.id);
    res.setHeader('Set-Cookie', auth.sessionCookie(token, config.sessionTtlMin * 60));
    await inClinic(user.clinicId || null, () => audit(store, req, user, 'login', 'users', user.id));
    sendJson(res, 200, { user: auth.publicUser(user) });
  });

  r.post('/api/logout', async (req, res) => {
    if (req.sessionToken) await auth.destroySession(req.sessionToken);
    res.setHeader('Set-Cookie', auth.sessionCookie('', 0));
    sendJson(res, 200, { ok: true });
  });

  r.get('/api/me', async (req, res) => {
    const u = requireUser(req);
    const perms = Object.keys(auth.PERMISSIONS).filter((p) => auth.can(u, p));
    const clinicId = store.clinicId ? store.clinicId() : null;
    const clinic = clinicId ? await base.get('clinics', clinicId) : null;
    sendJson(res, 200, {
      user: auth.publicUser(u), permissions: perms,
      platform: u.role === auth.PLATFORM_ROLE,
      clinic: clinic ? { id: clinic.id, name: clinic.name, color: clinic.color || null } : null,
    });
  });

  r.put('/api/me/password', async (req, res) => {
    const u = requireUser(req);
    const body = await readJsonBody(req);
    if (!auth.verifyPassword(String(body.currentPassword || ''), u.passwordHash)) {
      throw new HttpError(422, 'Senha atual incorreta.', { currentPassword: 'Senha atual incorreta.' });
    }
    const pwErr = auth.passwordProblem(body.newPassword);
    if (pwErr) throw new HttpError(422, pwErr, { newPassword: pwErr });
    await base.update('users', u.id, { passwordHash: auth.hashPassword(body.newPassword) });
    await auth.destroyUserSessions(u.id);
    const token = await auth.createSession(u.id);
    res.setHeader('Set-Cookie', auth.sessionCookie(token, config.sessionTtlMin * 60));
    await audit(store, req, u, 'update', 'users', u.id, 'Senha alterada pelo próprio usuário');
    sendJson(res, 200, { ok: true });
  });

  // ---------------- Metadados para a interface ----------------
  r.get('/api/meta', async (req, res) => {
    requireUser(req);
    const clinicId = store.clinicId ? store.clinicId() : null;
    const clinic = clinicId ? await base.get('clinics', clinicId) : null;
    sendJson(res, 200, {
      clinicName: clinic ? clinic.name : config.clinicName,
      roomTurnoverMin: config.roomTurnoverMin,
      roles: auth.ROLES,
      status: S.STATUS,
      transitions: S.TRANSITIONS,
      anesthesia: S.ANESTHESIA,
      needsAnesthetist: S.NEEDS_ANESTHETIST,
      laterality: S.LATERALITY,
      priority: S.PRIORITY,
      docTypes: S.DOC_TYPES,
      checklist: S.CHECKLIST,
      professionalRoles: PRO_ROLES,
      signerRoles: SIGNER_ROLES,
      types: S.TYPES,
      paymentMethods: F.METHODS,
      chargeStatus: F.CHARGE_STATUS,
      scopedRoles: auth.SCOPED_ROLES,
      examCategories: EXAM_CATEGORIES, fileKinds: FILE_KINDS, toothStatus: TOOTH_STATUS, teeth: TEETH,
      leadStages: STAGES, leadSources: SOURCES, quoteStatus: QUOTE_STATUS, expenseCategories: F.EXPENSE_CATEGORIES,
      procedureCategories: [...new Set(CATALOG.map((c) => c[0]))],
    });
  });

  // ---------------- Usuários ----------------
  const userSchema = {
    name: { type: 'string', required: true, label: 'Nome', min: 3 },
    email: { type: 'email', required: true, label: 'E-mail' },
    role: { type: 'enum', required: true, label: 'Perfil', values: Object.keys(auth.ROLES) },
    professionalId: { type: 'string', label: 'Profissional vinculado' },
    active: { type: 'bool', label: 'Ativo' },
  };

  r.get('/api/users', async (req, res) => {
    requirePerm(req, 'users:manage');
    const users = await store.list('users', (x) => x.role !== auth.PATIENT_ROLE);
    sendJson(res, 200, users.map(auth.publicUser).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')));
  });

  r.post('/api/users', async (req, res) => {
    const me = requirePerm(req, 'users:manage');
    const body = await readJsonBody(req);
    const data = validate(body, userSchema);
    const pwErr = auth.passwordProblem(body.password);
    if (pwErr) throw new HttpError(422, pwErr, { password: pwErr });
    if (await base.findOne('users', (u) => u.email === data.email)) {
      throw new HttpError(409, 'Já existe um usuário com este e-mail.', { email: 'E-mail já cadastrado.' });
    }
    if (body.newProfessional && data.role === 'medico' && !data.professionalId) {
      // Cadastro do médico: cria também o profissional para a agenda
      const np = validate(body.newProfessional, {
        specialty: { type: 'string', label: 'Especialidade', max: 120 },
        council: { type: 'string', label: 'CRM', max: 40 },
      });
      if (await store.findOne('professionals', (p) => normalize(p.name) === normalize(data.name))) {
        throw new HttpError(409, 'Já existe um profissional com este nome. Vincule o usuário a ele.', { professionalId: 'Selecione o profissional existente.' });
      }
      const pro = await store.insert('professionals', {
        name: data.name, role: 'medico', specialty: np.specialty, council: np.council, email: data.email,
        emailReminders: false, phone: null, color: '#1565D8', consultPriceCents: null, active: true,
      });
      data.professionalId = pro.id;
      await audit(store, req, me, 'create', 'professionals', pro.id, `${pro.name} (cadastro do médico)`);
    }
    if (data.professionalId) await mustGet('professionals', data.professionalId, 'Profissional');
    if (auth.SCOPED_ROLES.includes(data.role) && !data.professionalId) {
      throw new HttpError(422, 'Médico e funcionário do médico precisam estar vinculados a um médico.', { professionalId: 'Selecione o médico.' });
    }
    const user = await store.insert('users', { ...data, active: body.active !== false, passwordHash: auth.hashPassword(body.password) });
    await audit(store, req, me, 'create', 'users', user.id, `${user.name} (${auth.ROLES[user.role]})`);
    sendJson(res, 201, auth.publicUser(user));
  });

  r.put('/api/users/:id', async (req, res) => {
    const me = requirePerm(req, 'users:manage');
    const current = await mustGet('users', req.params.id, 'Usuário');
    if (current.role === auth.PATIENT_ROLE) throw new HttpError(404, 'Usuário não encontrado.');
    const body = await readJsonBody(req);
    const data = validate(body, userSchema, { partial: true });
    if (data.email && data.email !== current.email && await base.findOne('users', (u) => u.email === data.email)) {
      throw new HttpError(409, 'Já existe um usuário com este e-mail.', { email: 'E-mail já cadastrado.' });
    }
    if (data.professionalId) await mustGet('professionals', data.professionalId, 'Profissional');
    const mergedUser = { ...current, ...data };
    if (auth.SCOPED_ROLES.includes(mergedUser.role) && !mergedUser.professionalId) {
      throw new HttpError(422, 'Médico e funcionário do médico precisam estar vinculados a um médico.', { professionalId: 'Selecione o médico.' });
    }
    const losingAdmin = current.role === 'admin' && current.active &&
      ((data.role && data.role !== 'admin') || data.active === false);
    if (losingAdmin) {
      const admins = await store.list('users', (u) => u.role === 'admin' && u.active);
      if (admins.length <= 1) throw new HttpError(409, 'É preciso manter pelo menos um administrador ativo.');
    }
    if (current.id === me.id && data.active === false) throw new HttpError(409, 'Você não pode desativar o próprio usuário.');
    const patch = { ...data };
    if (body.password) {
      const pwErr = auth.passwordProblem(body.password);
      if (pwErr) throw new HttpError(422, pwErr, { password: pwErr });
      patch.passwordHash = auth.hashPassword(body.password);
    }
    const updated = await store.update('users', current.id, patch);
    if (patch.passwordHash || data.active === false || (data.role && data.role !== current.role) ||
      (data.professionalId !== undefined && data.professionalId !== current.professionalId)) await auth.destroyUserSessions(current.id);
    await audit(store, req, me, 'update', 'users', current.id, body.password ? 'Dados e senha alterados' : 'Dados alterados');
    sendJson(res, 200, auth.publicUser(updated));
  });

  // ---------------- Pacientes ----------------
  const patientSchema = {
    name: { type: 'string', required: true, label: 'Nome completo', min: 3 },
    socialName: { type: 'string', label: 'Nome social' },
    birthDate: { type: 'date', required: true, label: 'Data de nascimento',
      custom: (v) => (v > todayStr() ? 'Data de nascimento no futuro.' : null) },
    sex: { type: 'enum', required: true, label: 'Sexo', values: ['F', 'M', 'I'] },
    cpf: { type: 'cpf', label: 'CPF' },
    rg: { type: 'string', label: 'RG', max: 30 },
    cns: { type: 'string', label: 'Cartão SUS', max: 20 },
    motherName: { type: 'string', label: 'Nome da mãe' },
    phone: { type: 'string', label: 'Telefone', max: 30 },
    email: { type: 'email', label: 'E-mail' },
    emailReminders: { type: 'bool', label: 'Aceita lembretes por e-mail' },
    whatsappReminders: { type: 'bool', label: 'Aceita lembretes por WhatsApp' },
    address: { type: 'string', label: 'Endereço', max: 300 },
    city: { type: 'string', label: 'Cidade', max: 100 },
    bloodType: { type: 'enum', label: 'Tipo sanguíneo', values: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] },
    weightKg: { type: 'int', label: 'Peso (kg)', min: 1, max: 400 },
    heightCm: { type: 'int', label: 'Altura (cm)', min: 20, max: 250 },
    allergies: { type: 'text', label: 'Alergias', max: 2000 },
    noKnownAllergies: { type: 'bool', label: 'Nega alergias' },
    comorbidities: { type: 'text', label: 'Comorbidades', max: 2000 },
    medications: { type: 'text', label: 'Medicamentos em uso', max: 2000 },
    coverage: { type: 'enum', label: 'Atendimento', values: ['particular', 'convenio'] },
    insurer: { type: 'string', label: 'Convênio', max: 120 },
    insuranceCard: { type: 'string', label: 'Carteirinha', max: 60 },
    emergencyName: { type: 'string', label: 'Contato de emergência' },
    emergencyPhone: { type: 'string', label: 'Telefone de emergência', max: 30 },
    notes: { type: 'text', label: 'Observações', max: 3000 },
    active: { type: 'bool', label: 'Ativo' },
  };

  function checkEmailConsent(d) {
    if (d.emailReminders && !d.email) {
      throw new HttpError(422, 'Informe o e-mail para enviar os lembretes.', { email: 'E-mail obrigatório para receber lembretes.' });
    }
    if (d.whatsappReminders && !N.toE164(d.phone)) {
      throw new HttpError(422, 'Informe um celular com DDD para enviar lembretes pelo WhatsApp.', { phone: 'Celular com DDD obrigatório para WhatsApp.' });
    }
  }

  function checkAllergyInfo(p) {
    // Segurança: alergia precisa estar informada OU negada explicitamente
    if (!p.allergies && !p.noKnownAllergies) {
      throw new HttpError(422, 'Informe as alergias do paciente ou marque "Nega alergias".', {
        allergies: 'Informe as alergias ou marque "Nega alergias".',
      });
    }
    if (p.allergies && p.noKnownAllergies) {
      throw new HttpError(422, 'Alergias informadas e "Nega alergias" marcado ao mesmo tempo.', {
        allergies: 'Desmarque "Nega alergias" ou apague o campo de alergias.',
      });
    }
  }

  r.get('/api/patients', async (req, res) => {
    requirePerm(req, 'patients:read');
    const q = normalize(query(req).get('q') || '');
    const digits = q.replace(/\D/g, '');
    let list = await store.list('patients');
    if (q) {
      list = list.filter((p) =>
        normalize(p.name).includes(q) || normalize(p.socialName || '').includes(q) ||
        (digits.length >= 3 && (p.cpf || '').includes(digits)));
    }
    list.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    sendJson(res, 200, list.slice(0, 500));
  });

  r.get('/api/patients/:id', async (req, res) => {
    const u = requirePerm(req, 'patients:read');
    const p = await mustGet('patients', req.params.id, 'Paciente');
    await audit(store, req, u, 'view', 'patients', p.id, p.name);
    sendJson(res, 200, p);
  });

  r.post('/api/patients', async (req, res) => {
    const u = requirePerm(req, 'patients:write');
    const data = validate(await readJsonBody(req), patientSchema);
    checkAllergyInfo(data);
    checkEmailConsent(data);
    if (data.cpf && await store.findOne('patients', (p) => p.cpf === data.cpf)) {
      throw new HttpError(409, 'Já existe um paciente com este CPF.', { cpf: 'CPF já cadastrado.' });
    }
    const p = await store.insert('patients', { ...data, active: true });
    await audit(store, req, u, 'create', 'patients', p.id, p.name);
    sendJson(res, 201, p);
  });

  r.put('/api/patients/:id', async (req, res) => {
    const u = requirePerm(req, 'patients:write');
    const current = await mustGet('patients', req.params.id, 'Paciente');
    const data = validate(await readJsonBody(req), patientSchema, { partial: true });
    const merged = { ...current, ...data };
    checkAllergyInfo(merged);
    checkEmailConsent(merged);
    if (data.cpf && data.cpf !== current.cpf && await store.findOne('patients', (p) => p.cpf === data.cpf)) {
      throw new HttpError(409, 'Já existe um paciente com este CPF.', { cpf: 'CPF já cadastrado.' });
    }
    const changed = Object.keys(data).filter((k) => JSON.stringify(data[k]) !== JSON.stringify(current[k]));
    const updated = await store.update('patients', current.id, data);
    await audit(store, req, u, 'update', 'patients', current.id, `Campos: ${changed.join(', ') || 'nenhum'}`);
    sendJson(res, 200, updated);
  });

  r.post('/api/patients/:id/email', async (req, res) => {
    const u = requirePerm(req, 'emails:send');
    const p = await mustGet('patients', req.params.id, 'Paciente');
    if (!p.email) throw new HttpError(422, 'Este paciente não tem e-mail cadastrado.');
    const data = validate(await readJsonBody(req), {
      subject: { type: 'string', required: true, label: 'Assunto', max: 150, min: 3 },
      message: { type: 'text', required: true, label: 'Mensagem', max: 5000, min: 5 },
    });
    if (/[\r\n]/.test(data.subject)) throw new HttpError(422, 'Assunto inválido.', { subject: 'Use uma única linha.' });
    const st = await N.getSettings(store);
    if (!N.isReady(st)) throw new HttpError(409, 'O envio de e-mails não está ativado. Peça ao administrador para configurar em "E-mails e lembretes".');
    const e = await notifier.sendMessage(p, data.subject, data.message, u);
    await audit(store, req, u, 'email', 'patients', p.id, `Mensagem "${data.subject}" para ${p.name}`);
    sendJson(res, 201, { id: e.id, status: e.status });
  });

  // ---------------- Profissionais, salas e procedimentos ----------------
  const PRO_ROLES = {
    medico: 'Médico(a)',
    cirurgiao: 'Cirurgião(ã)',
    anestesista: 'Anestesista',
    auxiliar: 'Médico(a) auxiliar',
    instrumentador: 'Instrumentador(a)',
    enfermagem: 'Enfermagem',
    outro: 'Outro',
  };
  const SIGNER_ROLES = {
    paciente: 'Paciente',
    responsavel: 'Responsável legal',
    medico: 'Médico(a)',
    enfermagem: 'Enfermagem',
    testemunha: 'Testemunha',
  };

  const catalogs = {
    professionals: {
      label: 'Profissional',
      schema: {
        name: { type: 'string', required: true, label: 'Nome', min: 3 },
        role: { type: 'enum', required: true, label: 'Função', values: Object.keys(PRO_ROLES) },
        specialty: { type: 'string', label: 'Especialidade', max: 120 },
        council: { type: 'string', label: 'Conselho (CRM/COREN)', max: 40 },
        phone: { type: 'string', label: 'Telefone', max: 30 },
        email: { type: 'email', label: 'E-mail' },
        emailReminders: { type: 'bool', label: 'Receber avisos por e-mail' },
        consultPriceCents: { type: 'int', label: 'Valor da consulta', min: 0, max: 100000000 },
        color: { type: 'color', label: 'Cor na agenda' },
        active: { type: 'bool', label: 'Ativo' },
      },
      summary: (d) => d.name,
    },
    rooms: {
      label: 'Sala',
      schema: {
        name: { type: 'string', required: true, label: 'Nome da sala', max: 80 },
        notes: { type: 'text', label: 'Observações', max: 1000 },
        active: { type: 'bool', label: 'Ativa' },
      },
      summary: (d) => d.name,
    },
    procedures: {
      label: 'Procedimento',
      schema: {
        name: { type: 'string', required: true, label: 'Nome', max: 200 },
        code: { type: 'string', label: 'Código TUSS', max: 20 },
        defaultDurationMin: { type: 'int', label: 'Duração padrão (min)', min: 10, max: 1440 },
        priceCents: { type: 'int', label: 'Preço', min: 0, max: 100000000 },
        category: { type: 'string', label: 'Especialidade', max: 80 },
        kind: { type: 'enum', label: 'Tipo', values: ['consulta', 'cirurgia'] },
        requiresLaterality: { type: 'bool', label: 'Exige lateralidade' },
        active: { type: 'bool', label: 'Ativo' },
      },
      summary: (d) => d.name,
    },
  };

  for (const [col, def] of Object.entries(catalogs)) {
    r.get(`/api/${col}`, async (req, res) => {
      requireUser(req);
      const list = await store.list(col);
      list.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
      sendJson(res, 200, list);
    });
    r.post(`/api/${col}`, async (req, res) => {
      const u = requirePerm(req, 'catalog:manage');
      const body = await readJsonBody(req);
      const data = validate(body, def.schema);
      if (col === 'professionals') data.workHours = validateWorkHours(body.workHours);
      if (data.emailReminders && !data.email) throw new HttpError(422, 'Informe o e-mail para enviar os avisos.', { email: 'E-mail obrigatório para receber avisos.' });
      const dup = await store.findOne(col, (d) => normalize(d.name) === normalize(data.name));
      if (dup) throw new HttpError(409, `Já existe um(a) ${def.label.toLowerCase()} com este nome.`, { name: 'Nome já cadastrado.' });
      const doc = await store.insert(col, { ...data, active: body.active !== false });
      await audit(store, req, u, 'create', col, doc.id, def.summary(doc));
      sendJson(res, 201, doc);
    });
    r.put(`/api/${col}/:id`, async (req, res) => {
      const u = requirePerm(req, 'catalog:manage');
      const current = await mustGet(col, req.params.id, def.label);
      const bodyU = await readJsonBody(req);
      const data = validate(bodyU, def.schema, { partial: true });
      if (col === 'professionals' && bodyU.workHours !== undefined) data.workHours = validateWorkHours(bodyU.workHours);
      const mergedCat = { ...current, ...data };
      if (mergedCat.emailReminders && !mergedCat.email) throw new HttpError(422, 'Informe o e-mail para enviar os avisos.', { email: 'E-mail obrigatório para receber avisos.' });
      if (data.name && normalize(data.name) !== normalize(current.name)) {
        const dup = await store.findOne(col, (d) => d.id !== current.id && normalize(d.name) === normalize(data.name));
        if (dup) throw new HttpError(409, 'Nome já cadastrado.', { name: 'Nome já cadastrado.' });
      }
      const doc = await store.update(col, current.id, data);
      await audit(store, req, u, 'update', col, doc.id, def.summary(doc));
      sendJson(res, 200, doc);
    });
  }

  // Importação de procedimentos: catálogo padrão ou planilha (ex.: tabela TUSS)
  async function importProcedures(rows) {
    const existing = await store.list('procedures');
    const names = new Set(existing.map((p) => normalize(p.name)));
    let added = 0; let skipped = 0;
    for (const row of rows) {
      const key = normalize(row.name);
      if (names.has(key)) { skipped++; continue; }
      names.add(key);
      await store.insert('procedures', { ...row, active: true });
      added++;
    }
    return { added, skipped };
  }

  r.post('/api/procedures/import-default', async (req, res) => {
    const u = requirePerm(req, 'catalog:manage');
    const body = await readJsonBody(req);
    const cats = Array.isArray(body.categories) && body.categories.length ? new Set(body.categories) : null;
    const rows = CATALOG.filter((c) => !cats || cats.has(c[0])).map(([category, name, defaultDurationMin, kind]) => ({
      name, category, defaultDurationMin, kind, code: null, priceCents: null, requiresLaterality: false,
    }));
    const out = await importProcedures(rows);
    await audit(store, req, u, 'create', 'procedures', null, `Catálogo padrão importado: ${out.added} novos`);
    sendJson(res, 200, out);
  });

  r.post('/api/procedures/import', async (req, res) => {
    const u = requirePerm(req, 'catalog:manage');
    const body = await readJsonBody(req);
    if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > 10000) throw new HttpError(422, 'Envie de 1 a 10.000 linhas.');
    const rows = []; const errors = [];
    body.rows.forEach((x, i) => {
      try {
        const d = validate(x || {}, {
          name: { type: 'string', required: true, label: 'Nome', max: 200 },
          code: { type: 'string', label: 'Código', max: 20 },
          priceCents: { type: 'int', label: 'Preço', min: 0, max: 100000000 },
          defaultDurationMin: { type: 'int', label: 'Duração', min: 10, max: 1440 },
          category: { type: 'string', label: 'Especialidade', max: 80 },
        });
        rows.push({ ...d, kind: 'consulta', requiresLaterality: false });
      } catch (e) { if (errors.length < 20) errors.push(`Linha ${i + 1}: ${Object.values(e.details || {}).join(' ') || e.message}`); }
    });
    if (errors.length) throw new HttpError(422, 'Algumas linhas da planilha têm problemas. Nada foi importado.', { rows: errors.join(' | ') });
    const out = await importProcedures(rows);
    await audit(store, req, u, 'create', 'procedures', null, `Planilha importada: ${out.added} novos, ${out.skipped} já existiam`);
    sendJson(res, 200, out);
  });

  // ---------------- Agenda (consultas e cirurgias) ----------------
  // Internamente a coleção continua se chamando "surgeries"; o campo "type" diz se é consulta ou cirurgia.
  const surgerySchema = {
    type: { type: 'enum', required: true, label: 'Tipo de atendimento', values: Object.keys(S.TYPES) },
    patientId: { type: 'string', required: true, label: 'Paciente' },
    procedureId: { type: 'string', label: 'Procedimento cadastrado' },
    procedureName: { type: 'string', required: true, label: 'Procedimento / motivo', max: 300 },
    laterality: { type: 'enum', label: 'Lateralidade', values: Object.keys(S.LATERALITY) },
    surgeonId: { type: 'string', required: true, label: 'Médico(a) responsável' },
    anesthetistId: { type: 'string', label: 'Anestesista' },
    teamIds: { type: 'array', label: 'Equipe', max: 15 },
    roomId: { type: 'string', label: 'Sala' },
    date: { type: 'date', required: true, label: 'Data' },
    startTime: { type: 'time', required: true, label: 'Horário de início' },
    durationMin: { type: 'int', required: true, label: 'Duração estimada', min: 10, max: 1440 },
    anesthesiaType: { type: 'enum', label: 'Tipo de anestesia', values: Object.keys(S.ANESTHESIA) },
    priority: { type: 'enum', required: true, label: 'Prioridade', values: Object.keys(S.PRIORITY) },
    coverage: { type: 'enum', required: true, label: 'Atendimento', values: ['particular', 'convenio'] },
    insurer: { type: 'string', label: 'Convênio', max: 120 },
    authorizationNumber: { type: 'string', label: 'Nº da autorização/guia', max: 60 },
    needsIcu: { type: 'bool', label: 'Reserva de UTI' },
    needsBloodReserve: { type: 'bool', label: 'Reserva de sangue' },
    materials: { type: 'text', label: 'Materiais / OPME', max: 3000 },
    preOpNotes: { type: 'text', label: 'Exames e orientações pré-operatórias', max: 3000 },
    notes: { type: 'text', label: 'Observações', max: 3000 },
    priceCents: { type: 'int', label: 'Valor', min: 0, max: 100000000 },
    chargeMethod: { type: 'enum', label: 'Forma de cobrança', values: Object.keys(F.METHODS) },
    installments: { type: 'int', label: 'Parcelas', min: 1, max: 24 },
  };

  /** Ajusta os campos conforme o tipo: cirurgia exige sala, lado e anestesia. */
  function normalizeByType(data) {
    const errors = {};
    if (data.type === 'cirurgia') {
      if (!data.roomId) errors.roomId = 'Sala é obrigatória para cirurgia.';
      if (!data.laterality) errors.laterality = 'Lateralidade é obrigatória para cirurgia.';
      if (!data.anesthesiaType) errors.anesthesiaType = 'Tipo de anestesia é obrigatório para cirurgia.';
    } else {
      data.laterality = data.laterality || 'nao_se_aplica';
      data.anesthesiaType = data.anesthesiaType || 'nenhuma';
      data.needsIcu = false; data.needsBloodReserve = false;
    }
    if (Object.keys(errors).length) throw new HttpError(422, 'Revise os campos destacados.', errors);
  }

  /** Médico e funcionário só agendam e alteram atendimentos do próprio médico. */
  function assertCanManage(u, s, { clinical = false } = {}) {
    const scope = auth.proScope(u);
    if (!scope) return;
    if (s.surgeonId === scope) return;
    if (clinical && u.role === 'medico' && [s.anesthetistId, ...(s.teamIds || [])].includes(scope)) return;
    throw new HttpError(403, 'Você só pode agendar e alterar atendimentos do seu médico.');
  }

  async function lookupFns() {
    const [rooms, pros] = await Promise.all([store.list('rooms'), store.list('professionals')]);
    const rm = new Map(rooms.map((x) => [x.id, x]));
    const pm = new Map(pros.map((x) => [x.id, x]));
    return {
      rooms: rm, pros: pm,
      room: (id) => (id ? (rm.get(id) || {}).name || '(sala removida)' : 'Sem sala definida'),
      professional: (id) => (pm.get(id) || {}).name || '(profissional)',
    };
  }

  async function validateSurgeryRefs(data, lookup) {
    const errors = {};
    const patient = await store.get('patients', data.patientId);
    if (!patient) errors.patientId = 'Paciente não encontrado.';
    else if (patient.active === false) errors.patientId = 'Paciente inativo.';
    if (data.roomId) {
      const room = lookup.rooms.get(data.roomId);
      if (!room) errors.roomId = 'Sala não encontrada.';
      else if (room.active === false) errors.roomId = 'Sala inativa.';
    }
    const checkPro = (id, field) => {
      const p = lookup.pros.get(id);
      if (!p) errors[field] = 'Profissional não encontrado.';
      else if (p.active === false) errors[field] = `${p.name} está inativo(a).`;
    };
    checkPro(data.surgeonId, 'surgeonId');
    if (data.anesthetistId) checkPro(data.anesthetistId, 'anesthetistId');
    for (const id of data.teamIds || []) { checkPro(id, 'teamIds'); if (errors.teamIds) break; }
    if (S.NEEDS_ANESTHETIST.includes(data.anesthesiaType) && !data.anesthetistId) {
      errors.anesthetistId = `Anestesia ${S.ANESTHESIA[data.anesthesiaType].toLowerCase()} exige anestesista.`;
    }
    if (data.anesthetistId && data.anesthetistId === data.surgeonId) {
      errors.anesthetistId = 'O anestesista não pode ser o mesmo profissional que o cirurgião.';
    }
    data.teamIds = (data.teamIds || []).filter((id) => id !== data.surgeonId && id !== data.anesthetistId);
    if (data.procedureId) {
      const proc = await store.get('procedures', data.procedureId);
      if (!proc) errors.procedureId = 'Procedimento não encontrado.';
      else if (proc.requiresLaterality && data.laterality === 'nao_se_aplica') {
        errors.laterality = 'Este procedimento exige indicar o lado.';
      }
    }
    if (data.coverage === 'convenio' && !data.insurer) errors.insurer = 'Informe o convênio.';
    if (Object.keys(errors).length) throw new HttpError(422, 'Revise os campos destacados.', errors);
    return patient;
  }

  async function checkConflicts(candidate, body, lookup, user, req) {
    const others = await store.list('surgeries', (s) => s.id !== candidate.id && S.OCCUPYING.includes(s.status));
    const conflicts = S.findConflicts(candidate, others, lookup);
    if (!conflicts.length) return null;
    const canOverride = candidate.priority === 'emergencia' && body.overrideConflicts === true;
    if (!canOverride) {
      const err = new HttpError(409, 'Há conflitos de horário. Ajuste a agenda.', null);
      err.conflicts = conflicts;
      err.overridable = candidate.priority === 'emergencia';
      throw err;
    }
    const reason = String(body.overrideReason || '').trim();
    if (reason.length < 10) {
      throw new HttpError(422, 'Para manter uma emergência com conflito, descreva a justificativa (mín. 10 caracteres).',
        { overrideReason: 'Justificativa obrigatória.' });
    }
    return { at: new Date().toISOString(), byId: user.id, byName: user.name, reason: reason.slice(0, 1000),
      conflicts: conflicts.map((c) => c.message) };
  }

  async function enrich(s, lookup, patientsMap, signatures, viewer, charges) {
    const p = patientsMap ? patientsMap.get(s.patientId) : await store.get('patients', s.patientId);
    const sigs = signatures || (await store.list('signatures', (x) => x.surgeryId === s.id));
    return {
      ...s,
      patientName: p ? (p.socialName || p.name) : '(paciente)',
      patientBirthDate: p ? p.birthDate : null,
      patientAllergies: p ? (p.noKnownAllergies ? null : p.allergies) : null,
      patientNoKnownAllergies: p ? !!p.noKnownAllergies : false,
      roomName: lookup.room(s.roomId),
      surgeonName: lookup.professional(s.surgeonId),
      surgeonColor: (lookup.pros.get(s.surgeonId) || {}).color || null,
      anesthetistName: s.anesthetistId ? lookup.professional(s.anesthetistId) : null,
      teamNames: (s.teamIds || []).map(lookup.professional),
      requiredDocs: S.requiredDocs(s),
      missingDocs: S.requiredDocsMissing(s, validSignatures(sigs, s)),
      checklistDone: S.PHASE_ORDER.filter((ph) => S.isPhaseComplete(s, ph)),
      type: s.type || 'cirurgia',
      charge: await chargeFor(s, viewer, charges),
    };
  }

  // Resumo da cobrança, visível só para quem tem acesso ao financeiro daquele médico
  async function chargeFor(s, viewer, charges) {
    if (!viewer || !auth.can(viewer, 'finance:read')) return null;
    const scope = auth.SCOPED_ROLES.includes(viewer.role) ? viewer.professionalId : null;
    if (scope && s.surgeonId !== scope) return null;
    const map = charges || await fin.chargeSummaryFor([s.id]);
    return map.get(s.id) || null;
  }

  r.get('/api/surgeries', async (req, res) => {
    requirePerm(req, 'surgeries:read');
    const q = query(req);
    const from = q.get('from'); const to = q.get('to');
    const filters = {
      roomId: q.get('roomId'), professionalId: q.get('professionalId'),
      status: q.get('status'), patientId: q.get('patientId'),
    };
    let list = await store.list('surgeries', (s) =>
      (!from || s.date >= from) && (!to || s.date <= to) &&
      (!filters.roomId || s.roomId === filters.roomId) &&
      (!filters.status || s.status === filters.status) &&
      (!filters.patientId || s.patientId === filters.patientId) &&
      (!filters.professionalId || [s.surgeonId, s.anesthetistId, ...(s.teamIds || [])].includes(filters.professionalId)));
    list.sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
    list = list.slice(0, 2000);
    const lookup = await lookupFns();
    const patients = new Map((await store.list('patients')).map((p) => [p.id, p]));
    const sigs = await store.list('signatures', (x) => !!x.surgeryId);
    const bySurgery = new Map();
    for (const s of sigs) { if (!bySurgery.has(s.surgeryId)) bySurgery.set(s.surgeryId, []); bySurgery.get(s.surgeryId).push(s); }
    const u = req.user;
    const charges = auth.can(u, 'finance:read') ? await fin.chargeSummaryFor(list.map((s) => s.id)) : new Map();
    sendJson(res, 200, await Promise.all(list.map((s) => enrich(s, lookup, patients, bySurgery.get(s.id) || [], u, charges))));
  });

  r.get('/api/surgeries/:id', async (req, res) => {
    requirePerm(req, 'surgeries:read');
    const s = await mustGet('surgeries', req.params.id, 'Atendimento');
    sendJson(res, 200, await enrich(s, await lookupFns(), null, null, req.user));
  });

  r.post('/api/surgeries/check', async (req, res) => {
    // Pré-verificação de conflitos enquanto o usuário preenche o formulário
    requirePerm(req, 'surgeries:read');
    const body = await readJsonBody(req);
    const data = validate(body, {
      id: { type: 'string' }, type: { type: 'enum', values: Object.keys(S.TYPES) }, patientId: { type: 'string' }, roomId: { type: 'string' },
      surgeonId: { type: 'string' }, anesthetistId: { type: 'string' }, teamIds: { type: 'array', max: 15 },
      date: { type: 'date', required: true }, startTime: { type: 'time', required: true },
      durationMin: { type: 'int', required: true, min: 10, max: 1440 },
    });
    const lookup = await lookupFns();
    const others = await store.list('surgeries', (s) => s.id !== data.id && S.OCCUPYING.includes(s.status));
    sendJson(res, 200, { conflicts: S.findConflicts({ ...data, id: data.id || '__novo__' }, others, lookup) });
  });

  r.post('/api/surgeries', async (req, res) => {
    const u = requirePerm(req, 'surgeries:write');
    const body = await readJsonBody(req);
    const data = validate(body, surgerySchema);
    normalizeByType(data);
    assertCanManage(u, data);
    if (data.priceCents && !auth.can(u, 'finance:write')) delete data.priceCents;
    const lookup = await lookupFns();
    await validateSurgeryRefs(data, lookup);
    const override = await checkConflicts({ ...data, id: '__novo__' }, body, lookup, u, req);
    const s = await store.insert('surgeries', {
      ...data,
      status: 'agendada',
      statusHistory: [{ status: 'agendada', at: new Date().toISOString(), byId: u.id, byName: u.name, reason: null }],
      checklist: S.emptyChecklist(),
      conflictOverrides: override ? [override] : [],
      createdById: u.id, createdByName: u.name,
      scheduleChangedAt: new Date().toISOString(),
      confirmToken: newToken(),
    });
    await fin.syncAppointmentCharge(s, u);
    await notifier.surgeryEvent('agendada', s);
    await audit(store, req, u, 'create', 'surgeries', s.id,
      `${data.procedureName} em ${data.date} ${data.startTime}${override ? ' (emergência com conflito justificado)' : ''}`);
    sendJson(res, 201, await enrich(s, lookup, null, null, u));
  });

  r.put('/api/surgeries/:id', async (req, res) => {
    const u = requirePerm(req, 'surgeries:write');
    const current = await mustGet('surgeries', req.params.id, 'Atendimento');
    assertCanManage(u, current);
    if (!['agendada', 'confirmada', 'adiada'].includes(current.status)) {
      throw new HttpError(409, `Atendimento com situação "${S.STATUS[current.status].toLowerCase()}" não pode ser editado.`);
    }
    const body = await readJsonBody(req);
    const data = validate(body, surgerySchema);
    normalizeByType(data);
    assertCanManage(u, data);
    if (!auth.can(u, 'finance:write')) data.priceCents = current.priceCents ?? null;
    if ((current.type || 'cirurgia') !== data.type && S.isPhaseComplete(current, 'entrada')) {
      throw new HttpError(409, 'Não é permitido mudar o tipo depois do checklist de Entrada.');
    }
    // Confere a cobrança antes de salvar, para não deixar agenda e financeiro diferentes
    await fin.syncAppointmentCharge({ ...current, ...data }, u, { dryRun: true });
    if (data.patientId !== current.patientId && S.isPhaseComplete(current, 'entrada')) {
      throw new HttpError(409, 'Não é permitido trocar o paciente após o checklist de Entrada.');
    }
    const lookup = await lookupFns();
    await validateSurgeryRefs(data, lookup);
    const candidate = { ...current, ...data };
    const override = await checkConflicts(candidate, body, lookup, u, req);
    const changed = Object.keys(data).filter((k) => JSON.stringify(data[k]) !== JSON.stringify(current[k]));
    const patch = { ...data };
    if (override) patch.conflictOverrides = [...(current.conflictOverrides || []), override];
    // Troca de paciente invalida termos já assinados para esta cirurgia
    if (data.patientId !== current.patientId) patch.patientChangedAt = new Date().toISOString();
    const scheduleChanged = ['date', 'startTime', 'roomId'].some((k) => data[k] !== current[k]);
    if (scheduleChanged) patch.scheduleChangedAt = new Date().toISOString();
    const updated = await store.update('surgeries', current.id, patch);
    await fin.syncAppointmentCharge(updated, u);
    // Adiada: o aviso sai quando for reagendada
    if (current.status !== 'adiada' && (scheduleChanged || data.patientId !== current.patientId)) {
      await notifier.surgeryEvent(data.patientId !== current.patientId ? 'agendada' : 'alterada', updated);
    }
    await audit(store, req, u, 'update', 'surgeries', current.id, `Campos: ${changed.join(', ') || 'nenhum'}`);
    sendJson(res, 200, await enrich(updated, lookup, null, null, u));
  });

  r.post('/api/surgeries/:id/status', async (req, res) => {
    const u = requirePerm(req, 'surgeries:read');
    const current = await mustGet('surgeries', req.params.id, 'Atendimento');
    const body = await readJsonBody(req);
    const next = String(body.status || '');
    if (!S.STATUS[next]) throw new HttpError(422, 'Status inválido.');
    const clinical = ['em_andamento', 'concluida'].includes(next);
    const isConsulta = current.type === 'consulta';
    // Consulta: quem agenda também pode registrar início e fim. Cirurgia: só equipe clínica.
    const allowed = clinical && !isConsulta ? auth.can(u, 'surgeries:clinical')
      : clinical ? auth.can(u, 'surgeries:clinical') || auth.can(u, 'surgeries:write') : auth.can(u, 'surgeries:write');
    if (!allowed) throw new HttpError(403, 'Seu perfil não tem permissão para esta mudança de status.');
    assertCanManage(u, current, { clinical });
    const reason = String(body.reason || '').trim().slice(0, 1000) || null;
    const signatures = await store.list('signatures', (x) => x.surgeryId === current.id);
    S.assertTransition(current, next, { signatures: validSignatures(signatures, current), reason });
    if (next === 'agendada' && current.status === 'adiada') {
      // Ao reagendar, a nova data já deve ter sido salva e não pode conflitar
      const lookup = await lookupFns();
      const others = await store.list('surgeries', (s) => s.id !== current.id && S.OCCUPYING.includes(s.status));
      const conflicts = S.findConflicts(current, others, lookup);
      if (conflicts.length) {
        const err = new HttpError(409, 'A data atual da cirurgia conflita com a agenda. Edite a data antes de reagendar.');
        err.conflicts = conflicts;
        throw err;
      }
    }
    const now = new Date().toISOString();
    const patch = {
      status: next,
      statusHistory: [...(current.statusHistory || []), { status: next, at: now, byId: u.id, byName: u.name, reason }],
    };
    if (next === 'em_andamento') patch.startedAt = now;
    if (next === 'concluida') patch.finishedAt = now;
    if (next === 'agendada' && current.status === 'adiada') patch.scheduleChangedAt = now;
    const updated = await store.update('surgeries', current.id, patch);
    if (next === 'cancelada') await fin.onAppointmentCanceled(updated, u);
    if (next === 'cancelada' || next === 'adiada') await notifier.surgeryEvent(next, updated);
    if (next === 'agendada' && current.status === 'adiada') await notifier.surgeryEvent('alterada', updated);
    await audit(store, req, u, 'status', 'surgeries', current.id, `${S.STATUS[current.status]} → ${S.STATUS[next]}${reason ? ` (${reason})` : ''}`);
    sendJson(res, 200, await enrich(updated, await lookupFns(), null, null, u));
  });

  r.put('/api/surgeries/:id/checklist/:phase', async (req, res) => {
    const u = requirePerm(req, 'surgeries:clinical');
    const current = await mustGet('surgeries', req.params.id, 'Cirurgia');
    if (current.type === 'consulta') throw new HttpError(409, 'Consultas não têm checklist cirúrgico.');
    assertCanManage(u, current, { clinical: true });
    const phase = req.params.phase;
    const def = S.CHECKLIST[phase];
    if (!def) throw new HttpError(404, 'Etapa do checklist inexistente.');
    if (['cancelada', 'adiada', 'concluida'].includes(current.status)) {
      throw new HttpError(409, `Checklist bloqueado: cirurgia ${S.STATUS[current.status].toLowerCase()}.`);
    }
    if (S.isPhaseComplete(current, phase)) throw new HttpError(409, 'Esta etapa já foi concluída e não pode ser alterada.');
    const idx = S.PHASE_ORDER.indexOf(phase);
    if (idx > 0 && !S.isPhaseComplete(current, S.PHASE_ORDER[idx - 1])) {
      throw new HttpError(409, `Conclua antes a etapa "${S.CHECKLIST[S.PHASE_ORDER[idx - 1]].label}".`);
    }
    if (phase !== 'entrada' && current.status !== 'em_andamento') {
      throw new HttpError(409, 'Inicie a cirurgia antes de preencher esta etapa.');
    }
    if (phase === 'entrada' && current.status !== 'confirmada') {
      throw new HttpError(409, 'Confirme a cirurgia antes de preencher o checklist de Entrada.');
    }
    const body = await readJsonBody(req);
    const items = {};
    for (const key of Object.keys(def.items)) items[key] = body.items && body.items[key] === true;
    const complete = body.complete === true;
    if (complete && !Object.values(items).every(Boolean)) {
      throw new HttpError(422, 'Todos os itens precisam ser conferidos para concluir a etapa.');
    }
    const checklist = structuredClone(current.checklist || S.emptyChecklist());
    checklist[phase] = {
      items,
      completedAt: complete ? new Date().toISOString() : null,
      completedBy: complete ? u.id : null,
      completedByName: complete ? u.name : null,
      notes: String(body.notes || '').slice(0, 2000) || null,
    };
    const updated = await store.update('surgeries', current.id, { checklist });
    if (complete) await audit(store, req, u, 'checklist', 'surgeries', current.id, `Etapa concluída: ${def.label}`);
    sendJson(res, 200, await enrich(updated, await lookupFns(), null, null, u));
  });

  // ---------------- Assinaturas eletrônicas ----------------
  // Assinaturas são imutáveis: não há rota de edição ou exclusão.
  const signatureSchema = {
    docType: { type: 'enum', required: true, label: 'Tipo de documento', values: Object.keys(S.DOC_TYPES) },
    title: { type: 'string', required: true, label: 'Título', max: 200 },
    content: { type: 'text', required: true, label: 'Texto do documento', min: 20, max: 30000 },
    patientId: { type: 'string', required: true, label: 'Paciente' },
    surgeryId: { type: 'string', label: 'Cirurgia' },
    signerName: { type: 'string', required: true, label: 'Nome de quem assina', min: 3 },
    signerRole: { type: 'enum', required: true, label: 'Quem assina', values: Object.keys(SIGNER_ROLES) },
    signerCpf: { type: 'cpf', label: 'CPF de quem assina' },
    signerRelation: { type: 'string', label: 'Parentesco', max: 60 },
  };

  function canonicalHash(sig) {
    const payload = JSON.stringify([
      sig.docType, sig.title, sig.content, sig.patientId, sig.surgeryId || null, sig.signerName,
      sig.signerRole, sig.signerCpf || null, sig.signerRelation || null, sig.imageSha256, sig.signedAt,
      sig.collectedById, sig.ip, sig.userAgent,
    ]);
    return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
  }

  // Termos assinados antes de uma troca de paciente não valem para a cirurgia
  function validSignatures(sigs, surgery) {
    return sigs.filter((s) => s.patientId === surgery.patientId &&
      (!surgery.patientChangedAt || s.signedAt > surgery.patientChangedAt));
  }

  r.post('/api/signatures', async (req, res) => {
    const u = requirePerm(req, 'signatures:create');
    const body = await readJsonBody(req);
    const data = validate(body, signatureSchema);
    if (body.agree !== true) throw new HttpError(422, 'É necessário confirmar que o signatário leu o documento.', { agree: 'Confirmação obrigatória.' });
    if (data.signerRole === 'responsavel' && !data.signerRelation) {
      throw new HttpError(422, 'Informe o parentesco do responsável.', { signerRelation: 'Obrigatório para responsável.' });
    }
    if (['paciente', 'responsavel'].includes(data.signerRole) && !data.signerCpf) {
      throw new HttpError(422, 'Informe o CPF de quem assina.', { signerCpf: 'CPF obrigatório para paciente ou responsável.' });
    }
    const patient = await mustGet('patients', data.patientId, 'Paciente');
    if (data.surgeryId) {
      const s = await mustGet('surgeries', data.surgeryId, 'Cirurgia');
      if (s.patientId !== patient.id) throw new HttpError(422, 'A cirurgia selecionada é de outro paciente.');
      if (['cancelada', 'concluida'].includes(s.status)) throw new HttpError(409, 'Não é possível anexar termos a uma cirurgia encerrada.');
    }
    const img = String(body.image || '');
    const prefix = 'data:image/png;base64,';
    if (!img.startsWith(prefix)) throw new HttpError(422, 'Assinatura não recebida.', { image: 'Faça a assinatura no quadro.' });
    const buf = Buffer.from(img.slice(prefix.length), 'base64');
    const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (buf.length < 200 || buf.length > 800 * 1024 || !buf.subarray(0, 8).equals(PNG_MAGIC)) {
      throw new HttpError(422, 'Imagem da assinatura inválida.', { image: 'Assine novamente.' });
    }
    const sig = {
      ...data,
      image: img,
      imageSha256: crypto.createHash('sha256').update(buf).digest('hex'),
      signedAt: new Date().toISOString(),
      collectedById: u.id,
      collectedByName: u.name,
      ip: clientIp(req),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
    };
    sig.hash = canonicalHash(sig);
    const saved = await store.insert('signatures', sig);
    await audit(store, req, u, 'signature', 'signatures', saved.id,
      `${S.DOC_TYPES[data.docType]} — ${data.signerName} (${SIGNER_ROLES[data.signerRole]})`);
    const { image, ...rest } = saved;
    sendJson(res, 201, rest);
  });

  r.get('/api/signatures', async (req, res) => {
    requirePerm(req, 'signatures:read');
    const q = query(req);
    const patientId = q.get('patientId'); const surgeryId = q.get('surgeryId');
    const list = await store.list('signatures', (s) =>
      (!patientId || s.patientId === patientId) && (!surgeryId || s.surgeryId === surgeryId));
    const patients = new Map((await store.list('patients')).map((p) => [p.id, p]));
    list.sort((a, b) => b.signedAt.localeCompare(a.signedAt));
    sendJson(res, 200, list.slice(0, 1000).map(({ image, content, ...s }) => ({
      ...s, patientName: (patients.get(s.patientId) || {}).name || '(paciente)',
    })));
  });

  r.get('/api/signatures/:id', async (req, res) => {
    const u = requirePerm(req, 'signatures:read');
    const s = await mustGet('signatures', req.params.id, 'Assinatura');
    const patient = await store.get('patients', s.patientId);
    await audit(store, req, u, 'view', 'signatures', s.id, s.title);
    sendJson(res, 200, { ...s, patientName: patient ? patient.name : null, valid: canonicalHash(s) === s.hash });
  });

  // ---------------- E-mails e lembretes ----------------
  const publicSettings = (st) => {
    const { pass, ...rest } = st;
    return { ...rest, hasPassword: !!pass, ready: N.isReady(st) };
  };

  r.get('/api/settings/email', async (req, res) => {
    requirePerm(req, 'settings:manage');
    sendJson(res, 200, publicSettings(await N.getSettings(store)));
  });

  r.put('/api/settings/email', async (req, res) => {
    const u = requirePerm(req, 'settings:manage');
    const body = await readJsonBody(req);
    const data = validate(body, {
      enabled: { type: 'bool', label: 'Envio ativado' },
      host: { type: 'string', label: 'Servidor SMTP', max: 200 },
      port: { type: 'int', required: true, label: 'Porta', min: 1, max: 65535 },
      security: { type: 'enum', required: true, label: 'Segurança', values: ['ssl', 'starttls', 'none'] },
      user: { type: 'string', label: 'Usuário', max: 200 },
      fromName: { type: 'string', required: true, label: 'Nome do remetente', max: 120 },
      fromAddr: { type: 'email', label: 'E-mail remetente' },
      clinicAddress: { type: 'string', label: 'Endereço da clínica', max: 300 },
      clinicPhone: { type: 'string', label: 'Telefone da clínica', max: 40 },
      notifyTeam: { type: 'bool', label: 'Avisar a equipe' },
      includeProcedureForPatient: { type: 'bool', label: 'Mostrar procedimento ao paciente' },
    });
    const errors = {};
    if (data.host && !/^[A-Za-z0-9.-]+$/.test(data.host)) errors.host = 'Servidor inválido (ex.: smtp.gmail.com).';
    if (/[\r\n]/.test(data.fromName)) errors.fromName = 'Nome inválido.';
    let hours = body.reminderHours;
    if (typeof hours === 'string') hours = hours.split(/[,;\s]+/).filter(Boolean);
    if (!Array.isArray(hours)) hours = [];
    hours = [...new Set(hours.map(Number))];
    if (hours.some((h) => !Number.isInteger(h) || h < 1 || h > 720) || hours.length > 5) {
      errors.reminderHours = 'Use até 5 valores inteiros entre 1 e 720 horas, separados por vírgula.';
    }
    if (data.enabled && (!data.host || !data.fromAddr)) {
      if (!data.host) errors.host = 'Obrigatório para ativar o envio.';
      if (!data.fromAddr) errors.fromAddr = 'Obrigatório para ativar o envio.';
    }
    if (Object.keys(errors).length) throw new HttpError(422, 'Revise os campos destacados.', errors);
    const current = await N.getSettings(store);
    const value = { ...current, ...data, reminderHours: hours.sort((a, b) => b - a) };
    if (typeof body.pass === 'string' && body.pass !== '') {
      if (body.pass.length > 500) throw new HttpError(422, 'Senha longa demais.', { pass: 'Senha longa demais.' });
      value.pass = body.pass;
    }
    if (body.clearPassword === true) value.pass = '';
    await N.saveSettings(store, value);
    await audit(store, req, u, 'update', 'settings', null, `Configuração de e-mail ${value.enabled ? 'ativada' : 'desativada'}`);
    sendJson(res, 200, publicSettings(value));
  });

  r.post('/api/settings/email/test', async (req, res) => {
    const u = requirePerm(req, 'settings:manage');
    const { to } = validate(await readJsonBody(req), { to: { type: 'email', required: true, label: 'E-mail de destino' } });
    try {
      await notifier.sendTest(to);
    } catch (e) {
      await audit(store, req, u, 'email_test', 'settings', null, `Falha no teste para ${to}`);
      throw new HttpError(502, `O envio falhou: ${e.message}`);
    }
    await audit(store, req, u, 'email_test', 'settings', null, `Teste enviado para ${to}`);
    sendJson(res, 200, { ok: true });
  });

  const publicWa = (w) => { const { token, ...rest } = w; return { ...rest, hasToken: !!token, ready: N.isWaReady(w) }; };
  r.get('/api/settings/whatsapp', async (req, res) => {
    requirePerm(req, 'settings:manage');
    sendJson(res, 200, publicWa(await N.getWaSettings(store)));
  });
  r.put('/api/settings/whatsapp', async (req, res) => {
    const u = requirePerm(req, 'settings:manage');
    const body = await readJsonBody(req);
    const data = validate(body, {
      enabled: { type: 'bool', label: 'Envio ativado' },
      phoneNumberId: { type: 'string', label: 'ID do número', max: 40 },
      templateName: { type: 'string', label: 'Nome do modelo', max: 100 },
      languageCode: { type: 'string', label: 'Idioma do modelo', max: 10 },
    });
    if (data.phoneNumberId && !/^\d{5,30}$/.test(data.phoneNumberId)) throw new HttpError(422, 'O ID do número tem só dígitos.', { phoneNumberId: 'Somente números.' });
    if (data.templateName && !/^[a-z0-9_]+$/.test(data.templateName)) throw new HttpError(422, 'O nome do modelo usa letras minúsculas, números e _.', { templateName: 'Ex.: lembrete_consulta' });
    const current = await N.getWaSettings(store);
    const value = { ...current, ...data, languageCode: data.languageCode || 'pt_BR' };
    if (typeof body.token === 'string' && body.token) value.token = body.token.trim().slice(0, 600);
    if (value.enabled && !N.isWaReady(value)) throw new HttpError(422, 'Preencha ID do número, token e nome do modelo para ativar.', { phoneNumberId: 'Obrigatório para ativar.' });
    await N.saveWaSettings(store, value);
    await audit(store, req, u, 'update', 'settings', null, `WhatsApp ${value.enabled ? 'ativado' : 'desativado'}`);
    sendJson(res, 200, publicWa(value));
  });

  r.get('/api/emails', async (req, res) => {
    const q = query(req);
    const surgeryId = q.get('surgeryId');
    requirePerm(req, surgeryId ? 'surgeries:read' : 'settings:manage');
    const status = q.get('status');
    const limit = Math.min(Number(q.get('limit')) || 300, 1000);
    const list = await store.list('emails', (e) => (!surgeryId || e.surgeryId === surgeryId) && (!status || e.status === status));
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    sendJson(res, 200, list.slice(0, limit).map(({ text, html, dedupeKey, ...e }) => ({ ...e, kindLabel: N.KIND_LABELS[e.kind] })));
  });

  r.post('/api/emails/:id/retry', async (req, res) => {
    const u = requirePerm(req, 'settings:manage');
    const e = await mustGet('emails', req.params.id, 'E-mail');
    if (e.status === 'enviado') throw new HttpError(409, 'Este e-mail já foi enviado.');
    await store.update('emails', e.id, { status: 'pendente', attempts: 0, nextAttemptAt: new Date().toISOString() });
    await audit(store, req, u, 'update', 'emails', e.id, `Reenvio solicitado para ${e.to}`);
    notifier.kick();
    sendJson(res, 200, { ok: true });
  });

  // ---------------- Auditoria ----------------
  r.get('/api/audit', async (req, res) => {
    requirePerm(req, 'audit:read');
    const q = query(req);
    const entity = q.get('entity'); const entityId = q.get('entityId');
    const limit = Math.min(Number(q.get('limit')) || 300, 2000);
    const list = await store.list('audit', (a) => (!entity || a.entity === entity) && (!entityId || a.entityId === entityId));
    list.sort((a, b) => b.at.localeCompare(a.at));
    sendJson(res, 200, list.slice(0, limit));
  });

  return r;
}

function normalize(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

module.exports = { buildApi };

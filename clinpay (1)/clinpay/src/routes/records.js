'use strict';

/**
 * Prontuário eletrônico e portal do paciente.
 *
 * - Evolução clínica: registros não podem ser editados nem apagados (prontuário);
 *   correções são feitas por "adendo", que fica ligado ao registro original.
 * - Exames: o médico lança o resultado manualmente, anexa arquivos e LIBERA para o paciente.
 * - Imagens: fotos clínicas, radiografias e anexos (PNG, JPG, WEBP ou PDF).
 * - Odontograma: situação de cada dente (numeração FDI), com histórico de alterações.
 * - Portal: o paciente entra com login próprio e vê SOMENTE os próprios exames liberados
 *   e as próprias consultas.
 */

const { HttpError, sendJson } = require('../http/core');
const { validate } = require('../validation');
const auth = require('../auth');
const { audit } = require('../audit');

const EXAM_CATEGORIES = { laboratorial: 'Laboratorial', imagem: 'Imagem', radiologico: 'Radiológico', clinico: 'Clínico / funcional', outro: 'Outro' };
const FILE_KINDS = { foto: 'Foto clínica', radiografia: 'Radiografia', exame: 'Arquivo de exame', documento: 'Documento' };
const TOOTH_STATUS = {
  higido: 'Hígido', carie: 'Cárie', restaurado: 'Restaurado', canal: 'Tratamento de canal', coroa: 'Coroa / prótese',
  implante: 'Implante', ausente: 'Ausente', extracao_indicada: 'Extração indicada', fratura: 'Fratura', selante: 'Selante',
};
const TEETH = [
  ...[18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28],
  ...[48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38],
  ...[55, 54, 53, 52, 51, 61, 62, 63, 64, 65, 85, 84, 83, 82, 81, 71, 72, 73, 74, 75],
].map(String);

const MIME = {
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/webp': [0x52, 0x49, 0x46, 0x46],
  'application/pdf': [0x25, 0x50, 0x44, 0x46],
};
const MAX_FILE_BYTES = 8 * 1024 * 1024;

function registerRecords(r, store, { requirePerm, mustGet, query, readJsonBody }) {
  const base = store.base || store;

  async function patientOr404(id) {
    return mustGet('patients', id, 'Paciente');
  }

  // ---------------- Evolução clínica ----------------
  r.get('/api/patients/:id/notes', async (req, res) => {
    const u = requirePerm(req, 'records:read');
    const p = await patientOr404(req.params.id);
    const list = await store.list('record_notes', (n) => n.patientId === p.id);
    list.sort((a, b) => b.at.localeCompare(a.at));
    await audit(store, req, u, 'view', 'records', p.id, `Prontuário de ${p.name}`);
    sendJson(res, 200, list);
  });

  r.post('/api/patients/:id/notes', async (req, res) => {
    const u = requirePerm(req, 'records:write');
    const p = await patientOr404(req.params.id);
    const data = validate(await readJsonBody(req), {
      text: { type: 'text', required: true, label: 'Registro', min: 3, max: 20000 },
      appointmentId: { type: 'string', label: 'Atendimento' },
      addendumOf: { type: 'string', label: 'Registro corrigido' },
    });
    if (data.addendumOf) {
      const orig = await store.get('record_notes', data.addendumOf);
      if (!orig || orig.patientId !== p.id) throw new HttpError(422, 'Registro original não encontrado.');
    }
    if (data.appointmentId) {
      const s = await store.get('surgeries', data.appointmentId);
      if (!s || s.patientId !== p.id) throw new HttpError(422, 'Atendimento não pertence a este paciente.');
    }
    const note = await store.insert('record_notes', {
      patientId: p.id, ...data, kind: data.addendumOf ? 'adendo' : 'evolucao',
      authorId: u.id, authorName: u.name, professionalId: u.professionalId || null, at: new Date().toISOString(),
    });
    await audit(store, req, u, 'create', 'records', p.id, data.addendumOf ? 'Adendo no prontuário' : 'Evolução clínica registrada');
    sendJson(res, 201, note);
  });

  // ---------------- Exames ----------------
  const examSchema = {
    title: { type: 'string', required: true, label: 'Exame', max: 200 },
    category: { type: 'enum', required: true, label: 'Tipo de exame', values: Object.keys(EXAM_CATEGORIES) },
    examDate: { type: 'date', required: true, label: 'Data do exame' },
    resultText: { type: 'text', label: 'Resultado', max: 30000 },
    patientMessage: { type: 'text', label: 'Orientação ao paciente', max: 3000 },
    internalNotes: { type: 'text', label: 'Observação interna', max: 3000 },
  };
  const examView = (e, files) => ({ ...e, files: files.filter((f) => f.examId === e.id).map(({ dataUrl, ...m }) => m) });

  r.get('/api/patients/:id/exams', async (req, res) => {
    requirePerm(req, 'records:read');
    const p = await patientOr404(req.params.id);
    const [list, files] = await Promise.all([
      store.list('exams', (e) => e.patientId === p.id), store.list('files', (f) => f.patientId === p.id && f.examId),
    ]);
    list.sort((a, b) => b.examDate.localeCompare(a.examDate));
    sendJson(res, 200, list.map((e) => examView(e, files)));
  });

  r.post('/api/patients/:id/exams', async (req, res) => {
    const u = requirePerm(req, 'records:write');
    const p = await patientOr404(req.params.id);
    const data = validate(await readJsonBody(req), examSchema);
    const e = await store.insert('exams', {
      patientId: p.id, ...data, released: false, releasedAt: null, releasedByName: null,
      authorId: u.id, authorName: u.name,
    });
    await audit(store, req, u, 'create', 'exams', e.id, `${data.title} — ${p.name}`);
    sendJson(res, 201, examView(e, []));
  });

  r.put('/api/exams/:id', async (req, res) => {
    const u = requirePerm(req, 'records:write');
    const current = await mustGet('exams', req.params.id, 'Exame');
    const data = validate(await readJsonBody(req), examSchema, { partial: true });
    const patch = { ...data };
    if (current.released) patch.editedAfterRelease = new Date().toISOString();
    const e = await store.update('exams', current.id, patch);
    await audit(store, req, u, 'update', 'exams', e.id, `${e.title}${current.released ? ' (alterado depois de liberado ao paciente)' : ''}`);
    sendJson(res, 200, examView(e, await store.list('files', (f) => f.examId === e.id)));
  });

  r.post('/api/exams/:id/release', async (req, res) => {
    const u = requirePerm(req, 'exams:release');
    const current = await mustGet('exams', req.params.id, 'Exame');
    const body = await readJsonBody(req);
    const released = body.released === true;
    if (released && !current.resultText && !(await store.findOne('files', (f) => f.examId === current.id))) {
      throw new HttpError(422, 'Lance o resultado ou anexe o arquivo do exame antes de liberar ao paciente.');
    }
    const e = await store.update('exams', current.id, {
      released, releasedAt: released ? new Date().toISOString() : null, releasedByName: released ? u.name : null,
    });
    await audit(store, req, u, 'release', 'exams', e.id, `${e.title} ${released ? 'liberado ao paciente' : 'retirado do portal'}`);
    sendJson(res, 200, examView(e, await store.list('files', (f) => f.examId === e.id)));
  });

  // ---------------- Arquivos (fotos, radiografias, PDFs) ----------------
  r.get('/api/patients/:id/files', async (req, res) => {
    requirePerm(req, 'records:read');
    const p = await patientOr404(req.params.id);
    const kind = query(req).get('kind');
    const list = await store.list('files', (f) => f.patientId === p.id && (!kind || f.kind === kind));
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    sendJson(res, 200, list.map(({ dataUrl, ...m }) => m));
  });

  r.post('/api/patients/:id/files', async (req, res) => {
    const u = requirePerm(req, 'records:write');
    const p = await patientOr404(req.params.id);
    const body = await readJsonBody(req);
    const data = validate(body, {
      kind: { type: 'enum', required: true, label: 'Tipo', values: Object.keys(FILE_KINDS) },
      name: { type: 'string', required: true, label: 'Nome do arquivo', max: 200 },
      caption: { type: 'string', label: 'Legenda', max: 300 },
      takenAt: { type: 'date', label: 'Data' },
      examId: { type: 'string', label: 'Exame' },
    });
    if (data.examId) {
      const e = await store.get('exams', data.examId);
      if (!e || e.patientId !== p.id) throw new HttpError(422, 'Exame não pertence a este paciente.');
    }
    const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i.exec(String(body.dataUrl || ''));
    if (!m || !MIME[m[1].toLowerCase()]) throw new HttpError(422, 'Envie uma imagem (PNG, JPG, WEBP) ou um PDF.', { dataUrl: 'Formato não aceito.' });
    const mime = m[1].toLowerCase();
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length || buf.length > MAX_FILE_BYTES) throw new HttpError(422, 'O arquivo deve ter no máximo 8 MB.', { dataUrl: 'Arquivo grande demais.' });
    if (!MIME[mime].every((b, i) => buf[i] === b)) throw new HttpError(422, 'O conteúdo do arquivo não corresponde ao tipo informado.', { dataUrl: 'Arquivo inválido.' });
    const f = await store.insert('files', {
      patientId: p.id, ...data, mime, size: buf.length, dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
      uploadedById: u.id, uploadedByName: u.name,
    });
    await audit(store, req, u, 'create', 'files', f.id, `${FILE_KINDS[data.kind]}: ${data.name} — ${p.name}`);
    const { dataUrl, ...meta } = f;
    sendJson(res, 201, meta);
  });

  r.get('/api/files/:id', async (req, res) => {
    const u = requirePerm(req, 'records:read');
    const f = await mustGet('files', req.params.id, 'Arquivo');
    await audit(store, req, u, 'view', 'files', f.id, f.name);
    sendJson(res, 200, f);
  });

  // ---------------- Odontograma ----------------
  async function getOdontogram(patientId) {
    return (await store.findOne('odontograms', (o) => o.patientId === patientId)) || { patientId, teeth: {}, history: [] };
  }

  r.get('/api/patients/:id/odontogram', async (req, res) => {
    requirePerm(req, 'records:read');
    const p = await patientOr404(req.params.id);
    sendJson(res, 200, await getOdontogram(p.id));
  });

  r.put('/api/patients/:id/odontogram/:tooth', async (req, res) => {
    const u = requirePerm(req, 'records:write');
    const p = await patientOr404(req.params.id);
    const tooth = req.params.tooth;
    if (!TEETH.includes(tooth)) throw new HttpError(404, 'Dente inválido (use a numeração FDI, ex.: 11, 36, 55).');
    const data = validate(await readJsonBody(req), {
      status: { type: 'enum', required: true, label: 'Situação', values: Object.keys(TOOTH_STATUS) },
      notes: { type: 'string', label: 'Observação', max: 300 },
    });
    const current = await getOdontogram(p.id);
    const before = current.teeth[tooth] ? current.teeth[tooth].status : 'higido';
    const teeth = { ...current.teeth, [tooth]: { status: data.status, notes: data.notes, at: new Date().toISOString(), byName: u.name } };
    const history = [{ tooth, from: before, to: data.status, notes: data.notes, at: new Date().toISOString(), byName: u.name }, ...(current.history || [])].slice(0, 500);
    const saved = current.id ? await store.update('odontograms', current.id, { teeth, history }) : await store.insert('odontograms', { patientId: p.id, teeth, history });
    await audit(store, req, u, 'update', 'odontogram', p.id, `Dente ${tooth}: ${TOOTH_STATUS[before]} → ${TOOTH_STATUS[data.status]}`);
    sendJson(res, 200, saved);
  });

  // ---------------- Acesso do paciente ao portal ----------------
  const portalUserOf = (patientId) => store.findOne('users', (x) => x.role === auth.PATIENT_ROLE && x.patientId === patientId);

  r.get('/api/patients/:id/portal', async (req, res) => {
    requirePerm(req, 'patients:read');
    const p = await patientOr404(req.params.id);
    const pu = await portalUserOf(p.id);
    sendJson(res, 200, pu ? { exists: true, email: pu.email, active: pu.active } : { exists: false });
  });

  r.post('/api/patients/:id/portal', async (req, res) => {
    const u = requirePerm(req, 'patients:write');
    const p = await patientOr404(req.params.id);
    const body = await readJsonBody(req);
    const existing = await portalUserOf(p.id);
    if (!existing) {
      const { email } = validate(body, { email: { type: 'email', required: true, label: 'E-mail do paciente' } });
      const pwErr = auth.passwordProblem(body.password);
      if (pwErr) throw new HttpError(422, pwErr, { password: pwErr });
      if (await base.findOne('users', (x) => x.email === email)) throw new HttpError(409, 'Este e-mail já é usado por outro acesso.', { email: 'E-mail já cadastrado.' });
      await store.insert('users', {
        name: p.name, email, role: auth.PATIENT_ROLE, patientId: p.id, professionalId: null, active: true,
        passwordHash: auth.hashPassword(body.password),
      });
      await audit(store, req, u, 'create', 'portal', p.id, `Acesso ao portal criado para ${p.name}`);
    } else {
      const patch = {};
      if (typeof body.active === 'boolean') patch.active = body.active;
      if (body.password) {
        const pwErr = auth.passwordProblem(body.password);
        if (pwErr) throw new HttpError(422, pwErr, { password: pwErr });
        patch.passwordHash = auth.hashPassword(body.password);
      }
      await store.update('users', existing.id, patch);
      if (patch.passwordHash || patch.active === false) await auth.destroyUserSessions(existing.id);
      await audit(store, req, u, 'update', 'portal', p.id, `Acesso ao portal ${patch.active === false ? 'desativado' : 'atualizado'}`);
    }
    const pu = await portalUserOf(p.id);
    sendJson(res, 200, { exists: true, email: pu.email, active: pu.active });
  });

  // ---------------- Rotas do próprio paciente ----------------
  const me = (req) => {
    const u = requirePerm(req, 'portal:access');
    if (!u.patientId) throw new HttpError(403, 'Acesso sem paciente vinculado.');
    return u;
  };

  r.get('/api/portal/me', async (req, res) => {
    const u = me(req);
    const p = await mustGet('patients', u.patientId, 'Paciente');
    sendJson(res, 200, { name: p.socialName || p.name, birthDate: p.birthDate, email: u.email });
  });

  r.get('/api/portal/exams', async (req, res) => {
    const u = me(req);
    const [list, files] = await Promise.all([
      store.list('exams', (e) => e.patientId === u.patientId && e.released),
      store.list('files', (f) => f.patientId === u.patientId && f.examId),
    ]);
    list.sort((a, b) => b.examDate.localeCompare(a.examDate));
    // O paciente nunca recebe a observação interna
    sendJson(res, 200, list.map(({ internalNotes, authorId, ...e }) => examView(e, files)));
  });

  r.get('/api/portal/files/:id', async (req, res) => {
    const u = me(req);
    const f = await store.get('files', req.params.id);
    const exam = f && f.examId ? await store.get('exams', f.examId) : null;
    if (!f || f.patientId !== u.patientId || !exam || !exam.released) throw new HttpError(404, 'Arquivo não encontrado.');
    await audit(store, req, u, 'view', 'files', f.id, `Paciente abriu ${f.name}`);
    sendJson(res, 200, { id: f.id, name: f.name, mime: f.mime, dataUrl: f.dataUrl });
  });

  r.get('/api/portal/appointments', async (req, res) => {
    const u = me(req);
    const [list, pros] = await Promise.all([
      store.list('surgeries', (s) => s.patientId === u.patientId),
      store.list('professionals'),
    ]);
    const pm = new Map(pros.map((p) => [p.id, p.name]));
    list.sort((a, b) => (b.date + b.startTime).localeCompare(a.date + a.startTime));
    sendJson(res, 200, list.slice(0, 100).map((s) => ({
      id: s.id, type: s.type || 'cirurgia', date: s.date, startTime: s.startTime, durationMin: s.durationMin,
      status: s.status, professionalName: pm.get(s.surgeonId) || '', procedureName: s.procedureName,
      patientNotes: s.preOpNotes || null, confirmToken: ['agendada', 'confirmada'].includes(s.status) ? s.confirmToken || null : null,
    })));
  });
}

module.exports = { registerRecords, EXAM_CATEGORIES, FILE_KINDS, TOOTH_STATUS, TEETH };

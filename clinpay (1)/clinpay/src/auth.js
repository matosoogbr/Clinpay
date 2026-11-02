'use strict';

const crypto = require('node:crypto');
const config = require('./config');
const { HttpError, parseCookies, clientIp } = require('./http/core');

const COOKIE = 'bic_sess';

// Perfis dentro de uma clínica (o cadastro de usuários da clínica só oferece estes)
const ROLES = {
  admin: 'Médico(a) responsável — acesso total à clínica',
  medico: 'Médico(a)',
  funcionario: 'Funcionário(a) do médico',
  recepcao: 'Recepção da clínica',
  enfermagem: 'Enfermagem',
};

// Perfis que só enxergam/agem sobre a agenda e o financeiro do próprio médico
const SCOPED_ROLES = ['medico', 'funcionario'];

// Administrador da plataforma ClinPay: vê todas as clínicas parceiras e pode entrar em qualquer uma
const PLATFORM_ROLE = 'superadmin';
// Paciente com acesso ao portal (vê só os próprios exames liberados e consultas)
const PATIENT_ROLE = 'paciente';
const ROLE_LABELS = { ...ROLES, [PLATFORM_ROLE]: 'Administrador ClinPay', [PATIENT_ROLE]: 'Paciente (portal)' };

const ALL = [...Object.keys(ROLES), PLATFORM_ROLE];
const CLINIC_ADMIN = ['admin', PLATFORM_ROLE];
const PERMISSIONS = {
  'platform:manage': [PLATFORM_ROLE],
  'users:manage': CLINIC_ADMIN,
  'audit:read': CLINIC_ADMIN,
  'catalog:manage': CLINIC_ADMIN,
  'settings:manage': CLINIC_ADMIN,
  'patients:read': ALL,
  'patients:write': ALL,
  'surgeries:read': ALL,
  'surgeries:write': [...CLINIC_ADMIN, 'medico', 'funcionario', 'recepcao'],
  'surgeries:clinical': [...CLINIC_ADMIN, 'medico', 'enfermagem'], // iniciar/concluir cirurgia e checklist
  'signatures:create': ALL,
  'signatures:read': ALL,
  'finance:read': [...CLINIC_ADMIN, 'medico', 'funcionario', 'recepcao'],
  'finance:write': [...CLINIC_ADMIN, 'medico', 'funcionario', 'recepcao'],
  'finance:reverse': CLINIC_ADMIN,
  'emails:send': [...CLINIC_ADMIN, 'medico', 'funcionario', 'recepcao'],
  // Prontuário: só profissionais de saúde (sigilo médico)
  'records:read': [...CLINIC_ADMIN, 'medico', 'enfermagem'],
  'records:write': [...CLINIC_ADMIN, 'medico', 'enfermagem'],
  'exams:release': [...CLINIC_ADMIN, 'medico'],
  'crm:read': [...CLINIC_ADMIN, 'medico', 'funcionario', 'recepcao'],
  'crm:write': [...CLINIC_ADMIN, 'medico', 'funcionario', 'recepcao'],
  'analytics:read': [...CLINIC_ADMIN, 'medico', 'funcionario', 'recepcao'],
  'portal:access': [PATIENT_ROLE],
  'ai:use': [...CLINIC_ADMIN, 'medico', 'funcionario', 'recepcao', 'enfermagem'],
};

const can = (user, perm) => !!user && (PERMISSIONS[perm] || []).includes(user.role);

/**
 * Médico e funcionário do médico só atuam sobre o próprio profissional vinculado.
 * Retorna null (sem restrição) ou o id do profissional.
 */
function proScope(user) {
  if (!SCOPED_ROLES.includes(user.role)) return null;
  if (!user.professionalId) throw new HttpError(403, 'Seu usuário não está vinculado a um médico. Peça ao administrador para corrigir o cadastro.');
  return user.professionalId;
}

// ---------- Senhas (scrypt, sem dependências externas) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false;
  const [, saltHex, hashHex] = stored.split('$');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'A senha deve ter pelo menos 10 caracteres.';
  if (pw.length > 200) return 'Senha longa demais.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'A senha deve conter letras e números.';
  return null;
}

// ---------- Sessões ----------
// Ficam em memória (rápido) e também no armazenamento (sobrevivem a reinícios do servidor).
// No banco fica só o hash do código da sessão, nunca o código em si.
const sessions = new Map(); // token -> sessão
let sessionStore = null;
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const persistErr = (e) => console.error(new Date().toISOString(), 'Falha ao salvar sessão:', e.message);

/** Liga as sessões ao armazenamento (base, sem filtro de clínica). */
function useSessionStore(store) { sessionStore = store; sessions.clear(); }

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const s = { userId, createdAt: now, lastSeen: now, activeClinicId: null, savedSeen: now, docId: null };
  sessions.set(token, s);
  if (sessionStore) {
    const doc = await sessionStore.insert('sessions', { tokenHash: hashToken(token), userId, createdAtMs: now, lastSeenMs: now, activeClinicId: null });
    s.docId = doc.id;
  }
  return token;
}

async function loadSession(token) {
  if (sessions.has(token)) return sessions.get(token);
  if (!sessionStore) return null;
  const h = hashToken(token);
  const doc = await sessionStore.findOne('sessions', (d) => d.tokenHash === h);
  if (!doc) return null;
  const s = { userId: doc.userId, createdAt: doc.createdAtMs, lastSeen: doc.lastSeenMs, activeClinicId: doc.activeClinicId || null, savedSeen: doc.lastSeenMs, docId: doc.id };
  sessions.set(token, s);
  return s;
}

async function dropSession(token, s) {
  sessions.delete(token);
  if (sessionStore && s && s.docId) await sessionStore.remove('sessions', s.docId);
}

/** Administrador ClinPay escolhe em qual clínica está trabalhando (null = painel da plataforma). */
async function setActiveClinic(token, clinicId) {
  const s = await loadSession(token);
  if (!s) return;
  s.activeClinicId = clinicId;
  if (sessionStore && s.docId) await sessionStore.update('sessions', s.docId, { activeClinicId: clinicId });
}

async function destroySession(token) { await dropSession(token, await loadSession(token)); }

async function destroyUserSessions(userId) {
  for (const [t, s] of sessions) if (s.userId === userId) sessions.delete(t);
  if (sessionStore) for (const d of await sessionStore.list('sessions', (x) => x.userId === userId)) await sessionStore.remove('sessions', d.id);
}

/** Encerra as sessões de todos os usuários de uma clínica (ex.: clínica suspensa). */
async function destroyClinicSessions(userIds) {
  const set = new Set(userIds);
  for (const [t, s] of sessions) if (set.has(s.userId)) sessions.delete(t);
  if (sessionStore) for (const d of await sessionStore.list('sessions', (x) => set.has(x.userId))) await sessionStore.remove('sessions', d.id);
}

function sessionCookie(token, maxAgeSec) {
  return [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
    config.cookieSecure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

async function getSessionUser(req, store) {
  const token = parseCookies(req)[COOKIE];
  if (!token || token.length > 200) return null;
  const s = await loadSession(token);
  if (!s) return null;
  const now = Date.now();
  if (now - s.createdAt > config.sessionTtlMin * 60000 || now - s.lastSeen > config.sessionIdleMin * 60000) {
    await dropSession(token, s);
    return null;
  }
  // store aqui é o armazenamento base (sem filtro de clínica)
  const user = await store.get('users', s.userId);
  if (!user || !user.active) { await dropSession(token, s); return null; }
  if (user.role !== PLATFORM_ROLE) {
    const clinic = user.clinicId ? await store.get('clinics', user.clinicId) : null;
    if (!clinic || clinic.status !== 'ativa') { await dropSession(token, s); return null; }
  } else if (s.activeClinicId) {
    const clinic = await store.get('clinics', s.activeClinicId);
    if (!clinic) s.activeClinicId = null;
  }
  s.lastSeen = now;
  // Salva o "último uso" no banco no máximo a cada 5 minutos (evita gravar em toda requisição)
  if (sessionStore && s.docId && now - s.savedSeen > 5 * 60000) {
    s.savedSeen = now;
    sessionStore.update('sessions', s.docId, { lastSeenMs: now }).catch(persistErr);
  }
  req.sessionToken = token;
  req.session = s;
  return user;
}

/** Remove do banco as sessões vencidas (chamado periodicamente). */
async function purgeExpiredSessions() {
  if (!sessionStore) return 0;
  const now = Date.now();
  const old = await sessionStore.list('sessions', (d) => now - d.createdAtMs > config.sessionTtlMin * 60000 || now - d.lastSeenMs > config.sessionIdleMin * 60000 + 5 * 60000);
  for (const d of old) await sessionStore.remove('sessions', d.id);
  return old.length;
}

// ---------- Proteção contra força bruta no login ----------
const attempts = new Map(); // chave: ip|email

function checkLoginAllowed(req, email) {
  const key = `${clientIp(req)}|${email}`;
  const a = attempts.get(key);
  if (a && a.lockedUntil > Date.now()) {
    const min = Math.ceil((a.lockedUntil - Date.now()) / 60000);
    throw new HttpError(429, `Muitas tentativas. Tente novamente em ${min} minuto(s).`);
  }
  return key;
}

function registerLoginFailure(key) {
  const a = attempts.get(key) || { count: 0, lockedUntil: 0 };
  a.count += 1;
  if (a.count >= config.loginMaxAttempts) {
    a.lockedUntil = Date.now() + config.loginLockMin * 60000;
    a.count = 0;
  }
  attempts.set(key, a);
}

const clearLoginFailures = (key) => attempts.delete(key);

const publicUser = (u) => u && ({
  id: u.id, name: u.name, email: u.email, role: u.role, roleLabel: ROLE_LABELS[u.role],
  professionalId: u.professionalId || null, patientId: u.patientId || null, clinicId: u.clinicId || null, active: u.active, createdAt: u.createdAt,
});

module.exports = {
  COOKIE, ROLES, ROLE_LABELS, PLATFORM_ROLE, PATIENT_ROLE, PERMISSIONS, SCOPED_ROLES, can, proScope, setActiveClinic, destroyClinicSessions,
  useSessionStore, purgeExpiredSessions,
  hashPassword, verifyPassword, passwordProblem,
  createSession, destroySession, destroyUserSessions, sessionCookie, getSessionUser,
  checkLoginAllowed, registerLoginFailure, clearLoginFailures, publicUser,
};

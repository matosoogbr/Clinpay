'use strict';

const { clientIp } = require('./http/core');

/**
 * Registra quem fez o quê, quando e de onde.
 * Necessário para rastreabilidade (LGPD e prontuário). Nunca grave senhas ou imagens aqui.
 */
async function audit(store, req, user, action, entity, entityId, summary) {
  const entry = {
    at: new Date().toISOString(),
    userId: user ? user.id : null,
    // Ações do administrador ClinPay aparecem identificadas na auditoria da clínica
    userName: user ? (user.role === 'superadmin' ? `${user.name} (ClinPay)` : user.name) : 'sistema',
    action,           // ex.: create, update, delete, status, login, signature, view
    entity,           // ex.: patients, surgeries
    entityId: entityId || null,
    summary: summary ? String(summary).slice(0, 500) : null,
    ip: clientIp(req),
  };
  // Dentro de uma clínica: auditoria da clínica. Fora (login, painel ClinPay): auditoria da plataforma.
  const inClinic = typeof store.clinicId === 'function' ? !!store.clinicId() : true;
  if (inClinic) return store.insert('audit', entry);
  return (store.base || store).insert('platform_audit', { ...entry, clinicId: (user && user.clinicId) || null });
}

module.exports = { audit };

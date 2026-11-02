'use strict';

// Todas as configurações podem ser sobrescritas por variáveis de ambiente.
const int = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);

module.exports = Object.freeze({
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  clinicName: process.env.CLINIC_NAME || 'ClinPay',
  // Duração da sessão (minutos) e expiração por inatividade
  sessionTtlMin: int(process.env.SESSION_TTL_MIN, 12 * 60),
  sessionIdleMin: int(process.env.SESSION_IDLE_MIN, 60),
  // Tempo mínimo de limpeza/preparo da sala entre duas cirurgias (minutos)
  roomTurnoverMin: int(process.env.ROOM_TURNOVER_MIN, 30),
  // Em produção atrás de HTTPS, deixe COOKIE_SECURE=1
  cookieSecure: process.env.COOKIE_SECURE === '1',
  // Confiar no IP repassado por proxy reverso (nginx etc.)
  trustProxy: process.env.TRUST_PROXY === '1',
  maxBodyBytes: int(process.env.MAX_BODY_BYTES, 12 * 1024 * 1024), // fotos e exames de imagem
  // Endereço público do sistema, usado nos links de confirmação enviados ao paciente
  publicUrl: (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, ''),
  loginMaxAttempts: int(process.env.LOGIN_MAX_ATTEMPTS, 5),
  loginLockMin: int(process.env.LOGIN_LOCK_MIN, 15),
});

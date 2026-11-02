'use strict';

const http = require('node:http');
const path = require('node:path');
const config = require('./src/config');
const { MemoryStore } = require('./src/store/memoryStore');
const { HttpError, sendJson, serveStatic } = require('./src/http/core');
const { getSessionUser } = require('./src/auth');
const { buildApi } = require('./src/routes/api');
const { createNotifier } = require('./src/notifications');
const crypto = require('node:crypto');
const { TenantStore } = require('./src/tenant');
const { createPersistentStore } = require('./src/store/persistentStore');
const auth = require('./src/auth');

const PUBLIC_DIR = path.join(__dirname, 'public');

function createServer(baseStore = new MemoryStore(), opts = {}) {
  // Todo acesso a dados passa pelo TenantStore, que isola cada clínica
  const store = new TenantStore(baseStore);
  auth.useSessionStore(baseStore);
  const notifier = createNotifier(store, opts.notifier || {});
  const api = buildApi(store, notifier, { ai: opts.ai });

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    try {
      // Verificação de saúde (usada pela hospedagem)
      if (pathname === '/api/health') return sendJson(res, 200, { ok: true });
      // "Despertador" para lembretes: um serviço externo chama a cada 10 min com a chave secreta
      if (pathname === '/api/cron') {
        const secret = process.env.CRON_SECRET || '';
        const given = new URL(req.url, 'http://x').searchParams.get('key') || '';
        const ok = secret.length >= 16 && given.length === secret.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
        if (!ok) throw new HttpError(404, 'Rota não encontrada.');
        const reminders = await notifier.tick();
        await notifier.flush();
        await auth.purgeExpiredSessions();
        return sendJson(res, 200, { ok: true, reminders });
      }
      if (pathname.startsWith('/api/')) {
        req.user = await getSessionUser(req, baseStore);
        const { route, params, pathMatched } = api.match(req.method, pathname);
        if (!route) {
          throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Método não permitido.' : 'Rota não encontrada.');
        }
        req.params = params;
        // Clínica desta requisição: a do usuário; para o administrador ClinPay, a clínica em que ele entrou.
        // Rotas da plataforma sempre rodam fora de qualquer clínica.
        let clinicId = null;
        if (req.user && !pathname.startsWith('/api/platform/')) {
          clinicId = req.user.role === auth.PLATFORM_ROLE ? (req.session && req.session.activeClinicId) || null : req.user.clinicId;
        }
        await store.run({ clinicId, user: req.user }, async () => {
          for (const h of route.handlers) await h(req, res);
        });
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método não permitido.');
      if (serveStatic(req, res, PUBLIC_DIR, pathname)) return;
      // Aplicação de página única: qualquer outra rota abre a interface
      if (!path.extname(pathname) && serveStatic(req, res, PUBLIC_DIR, '/index.html')) return;
      throw new HttpError(404, 'Página não encontrada.');
    } catch (err) {
      if (res.headersSent) return res.destroy();
      if (err && err.code === 'NO_CLINIC') {
        return sendJson(res, 409, { error: 'Escolha uma clínica no painel ClinPay para continuar.', noClinic: true });
      }
      if (err instanceof HttpError) {
        const body = { error: err.message };
        if (err.details) body.fields = err.details;
        if (err.conflicts) { body.conflicts = err.conflicts; body.overridable = !!err.overridable; }
        return sendJson(res, err.status, body);
      }
      console.error(new Date().toISOString(), req.method, pathname, err);
      sendJson(res, 500, { error: 'Erro interno. A operação não foi concluída; tente novamente.' });
    }
  });
  server.notifier = notifier;
  return server;
}

if (require.main === module) {
  (async () => {
    let persisted;
    try {
      persisted = await createPersistentStore();
    } catch (e) {
      console.error('ERRO ao abrir o banco de dados:', e.message);
      console.error('Confira a variável DATABASE_URL (ou o arquivo de dados) e tente de novo.');
      process.exit(1);
    }
    const server = createServer(persisted.store);
    server.notifier.start();
    setInterval(() => auth.purgeExpiredSessions().catch(() => {}), 3600000).unref();
    server.listen(config.port, config.host, () => {
      console.log(`${config.clinicName} — servidor em http://localhost:${config.port}`);
      console.log(`Dados salvos em: ${persisted.kind} (${persisted.records} registros carregados).`);
    });
    const shutdown = () => server.close(async () => { await persisted.store.queue; await persisted.store.close(); process.exit(0); });
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  })();
}

module.exports = { createServer };

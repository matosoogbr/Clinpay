'use strict';

/**
 * Envio pelo WhatsApp Business Platform (API oficial da Meta, "Cloud API").
 *
 * Exige: conta Business verificada, um número de WhatsApp ligado à API, um token de acesso
 * e um MODELO de mensagem aprovado pela Meta. Sugestão de modelo (categoria "Utilidade"):
 *   "Olá, {{1}}! Lembramos do seu atendimento em {{2}} às {{3}} na {{4}}.
 *    Para confirmar ou cancelar, acesse: {{5}}"
 * O sistema preenche {{1}} nome, {{2}} data, {{3}} horário, {{4}} clínica e {{5}} link de confirmação.
 */

/** Converte telefone brasileiro para o formato internacional (somente dígitos, com 55). */
function toE164(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return d;
  if (d.length === 10 || d.length === 11) return '55' + d;
  return null;
}

async function sendWhatsApp(cfg, { to, params }, fetchFn = fetch) {
  if (!/^\d{12,13}$/.test(String(to))) throw new Error(`Telefone inválido para WhatsApp: ${to}`);
  const url = `https://graph.facebook.com/${cfg.apiVersion || 'v21.0'}/${encodeURIComponent(cfg.phoneNumberId)}/messages`;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: cfg.templateName,
        language: { code: cfg.languageCode || 'pt_BR' },
        components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text: String(text).slice(0, 200) })) }],
      },
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = (j.error && j.error.message) || ''; } catch { /* sem detalhe */ }
    throw new Error(`WhatsApp recusou o envio (${res.status})${detail ? `: ${detail}` : ''}`);
  }
}

module.exports = { sendWhatsApp, toE164 };

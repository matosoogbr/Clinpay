'use strict';

/**
 * Chamada à API do Claude (Anthropic) — endpoint oficial /v1/messages.
 * A chave fica só no servidor (variável ANTHROPIC_API_KEY) e nunca vai para o navegador.
 */
async function callClaude({ apiKey, model, system, messages, maxTokens = 1200 }, fetchFn = fetch) {
  let res;
  try {
    res = await fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    throw new Error('Não foi possível falar com o serviço de IA. Verifique a internet do servidor.');
  }
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = (j.error && j.error.message) || ''; } catch { /* sem detalhe */ }
    if (res.status === 401) throw new Error('A chave da IA é inválida. Avise o suporte ClinPay.');
    if (res.status === 429) throw new Error('Muitos pedidos à IA ao mesmo tempo. Tente de novo em alguns instantes.');
    if (res.status === 529 || res.status >= 500) throw new Error('O serviço de IA está sobrecarregado. Tente de novo em alguns instantes.');
    throw new Error(`O serviço de IA recusou o pedido (${res.status})${detail ? `: ${detail}` : ''}.`);
  }
  const j = await res.json();
  const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!text) throw new Error('A IA não retornou resposta. Tente reformular a pergunta.');
  return text;
}

module.exports = { callClaude };

'use strict';

/**
 * De onde veio cada recebimento: atendimento (consulta/cirurgia), orçamento ou cobrança avulsa.
 * O valor é dividido entre os procedimentos de origem SEM perder centavos
 * (método do maior resto: a soma das partes é sempre igual ao valor recebido).
 */

/** Divide "cents" proporcionalmente aos pesos, com soma exata. */
function splitCents(cents, weights) {
  const total = weights.reduce((s, w) => s + w, 0);
  if (!weights.length) return [];
  if (total <= 0) return weights.map((_, i) => (i === 0 ? cents : 0));
  const raw = weights.map((w) => (cents * w) / total);
  const out = raw.map(Math.floor);
  let rest = cents - out.reduce((s, v) => s + v, 0);
  const order = raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) out[order[k][1]] += 1;
  return out;
}

/**
 * Monta a origem de uma cobrança.
 * maps: { appts: Map, quotes: Map, procs: Map }
 * Retorna { origin, parts: [{ name, category, weight }] }
 */
function chargeSources(c, maps) {
  const a = c.appointmentId ? maps.appts.get(c.appointmentId) : null;
  if (a) {
    const proc = a.procedureId ? maps.procs.get(a.procedureId) : null;
    return { origin: a.type === 'cirurgia' ? 'Cirurgias' : 'Consultas', parts: [{ name: a.procedureName, category: (proc && proc.category) || null, weight: 1 }] };
  }
  const q = c.quoteId ? maps.quotes.get(c.quoteId) : null;
  if (q && q.subtotalCents > 0) {
    return {
      origin: 'Orçamentos',
      parts: q.items.map((it) => {
        const pr = it.procedureId ? maps.procs.get(it.procedureId) : null;
        return { name: it.name, category: (pr && pr.category) || null, weight: it.qty * it.unitCents };
      }),
    };
  }
  return { origin: 'Cobranças avulsas', parts: [{ name: c.description, category: null, weight: 1 }] };
}

/** Divide um pagamento entre as partes da origem. Retorna [{ name, category, cents }]. */
function allocatePayment(amountCents, sources) {
  const values = splitCents(amountCents, sources.parts.map((p) => p.weight));
  return sources.parts.map((p, i) => ({ name: p.name, category: p.category, cents: values[i] })).filter((x) => x.cents !== 0);
}

module.exports = { splitCents, chargeSources, allocatePayment };

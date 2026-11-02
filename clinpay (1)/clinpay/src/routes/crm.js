'use strict';

/**
 * CRM e vendas.
 * - Funil: do primeiro contato (lead) até o fechamento.
 * - Orçamentos com itens do catálogo de procedimentos, desconto, forma de pagamento e validade.
 * - Orçamento aprovado gera a cobrança no Financeiro e marca a oportunidade como ganha.
 */

const { HttpError, sendJson } = require('../http/core');
const { validate } = require('../validation');
const auth = require('../auth');
const { audit } = require('../audit');
const F = require('../domain/finance');

const STAGES = {
  novo: 'Novo contato', contato: 'Em conversa', avaliacao: 'Avaliação agendada',
  orcamento: 'Orçamento enviado', ganho: 'Fechado (ganho)', perdido: 'Perdido',
};
const SOURCES = {
  indicacao: 'Indicação', instagram: 'Instagram', facebook: 'Facebook', google: 'Google', site: 'Site',
  whatsapp: 'WhatsApp', telefone: 'Telefone', convenio: 'Convênio', retorno: 'Paciente antigo', outro: 'Outro',
};
const QUOTE_STATUS = { rascunho: 'Rascunho', enviado: 'Enviado', aprovado: 'Aprovado', recusado: 'Recusado', vencido: 'Vencido' };

function registerCrm(r, store, { requirePerm, mustGet, query, readJsonBody }) {
  const scope = (u) => auth.proScope(u);
  const canSeeLead = (u, l) => { const s = scope(u); return !s || !l.professionalId || l.professionalId === s; };
  const today = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

  // ---------------- Oportunidades (leads) ----------------
  const leadSchema = {
    name: { type: 'string', required: true, label: 'Nome', min: 2, max: 150 },
    phone: { type: 'string', label: 'Telefone', max: 30 },
    email: { type: 'email', label: 'E-mail' },
    source: { type: 'enum', required: true, label: 'Origem', values: Object.keys(SOURCES) },
    interest: { type: 'string', label: 'Interesse', max: 300 },
    professionalId: { type: 'string', label: 'Médico' },
    estimatedCents: { type: 'int', label: 'Valor estimado', min: 0, max: 100000000 },
    nextContactAt: { type: 'date', label: 'Próximo contato' },
    notes: { type: 'text', label: 'Observações', max: 3000 },
  };

  async function checkLeadRefs(u, data) {
    if (!data.phone && !data.email) throw new HttpError(422, 'Informe um telefone ou e-mail para contato.', { phone: 'Telefone ou e-mail obrigatório.' });
    if (data.professionalId) {
      if (!(await store.get('professionals', data.professionalId))) throw new HttpError(422, 'Médico não encontrado.', { professionalId: 'Inválido.' });
      const s = scope(u);
      if (s && data.professionalId !== s) throw new HttpError(403, 'Você só pode atribuir oportunidades ao seu médico.');
    }
  }

  r.get('/api/crm/leads', async (req, res) => {
    const u = requirePerm(req, 'crm:read');
    const list = (await store.list('leads')).filter((l) => canSeeLead(u, l));
    list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    sendJson(res, 200, list);
  });

  r.post('/api/crm/leads', async (req, res) => {
    const u = requirePerm(req, 'crm:write');
    const data = validate(await readJsonBody(req), leadSchema);
    if (!data.professionalId && scope(u)) data.professionalId = scope(u);
    await checkLeadRefs(u, data);
    const l = await store.insert('leads', {
      ...data, stage: 'novo', patientId: null, lostReason: null,
      history: [{ at: new Date().toISOString(), byName: u.name, to: 'novo', note: 'Oportunidade criada' }],
    });
    await audit(store, req, u, 'create', 'leads', l.id, l.name);
    sendJson(res, 201, l);
  });

  r.put('/api/crm/leads/:id', async (req, res) => {
    const u = requirePerm(req, 'crm:write');
    const current = await mustGet('leads', req.params.id, 'Oportunidade');
    if (!canSeeLead(u, current)) throw new HttpError(404, 'Oportunidade não encontrada.');
    const data = validate(await readJsonBody(req), leadSchema, { partial: true });
    await checkLeadRefs(u, { ...current, ...data });
    const l = await store.update('leads', current.id, data);
    sendJson(res, 200, l);
  });

  r.post('/api/crm/leads/:id/stage', async (req, res) => {
    const u = requirePerm(req, 'crm:write');
    const current = await mustGet('leads', req.params.id, 'Oportunidade');
    if (!canSeeLead(u, current)) throw new HttpError(404, 'Oportunidade não encontrada.');
    const body = await readJsonBody(req);
    if (!STAGES[body.stage]) throw new HttpError(422, 'Etapa inválida.');
    const note = String(body.note || '').trim().slice(0, 300);
    if (body.stage === 'perdido' && note.length < 3) throw new HttpError(422, 'Informe o motivo da perda.', { note: 'Motivo obrigatório.' });
    const l = await store.update('leads', current.id, {
      stage: body.stage, lostReason: body.stage === 'perdido' ? note : null,
      history: [{ at: new Date().toISOString(), byName: u.name, from: current.stage, to: body.stage, note: note || null }, ...(current.history || [])].slice(0, 100),
    });
    await audit(store, req, u, 'stage', 'leads', l.id, `${l.name}: ${STAGES[current.stage]} → ${STAGES[body.stage]}`);
    sendJson(res, 200, l);
  });

  r.post('/api/crm/leads/:id/link', async (req, res) => {
    const u = requirePerm(req, 'crm:write');
    const current = await mustGet('leads', req.params.id, 'Oportunidade');
    if (!canSeeLead(u, current)) throw new HttpError(404, 'Oportunidade não encontrada.');
    const body = await readJsonBody(req);
    const p = await mustGet('patients', String(body.patientId || ''), 'Paciente');
    const l = await store.update('leads', current.id, { patientId: p.id });
    await audit(store, req, u, 'update', 'leads', l.id, `${l.name} vinculado ao paciente ${p.name}`);
    sendJson(res, 200, l);
  });

  // ---------------- Orçamentos ----------------
  const quoteSchema = {
    patientId: { type: 'string', required: true, label: 'Paciente' },
    professionalId: { type: 'string', required: true, label: 'Médico' },
    leadId: { type: 'string', label: 'Oportunidade' },
    discountCents: { type: 'int', label: 'Desconto', min: 0, max: 100000000 },
    validUntil: { type: 'date', required: true, label: 'Validade' },
    method: { type: 'enum', required: true, label: 'Forma de pagamento', values: Object.keys(F.METHODS) },
    installments: { type: 'int', label: 'Parcelas', min: 1, max: 24 },
    notes: { type: 'text', label: 'Observações ao paciente', max: 3000 },
  };

  function cleanItems(items) {
    if (!Array.isArray(items) || !items.length || items.length > 50) throw new HttpError(422, 'Inclua de 1 a 50 itens no orçamento.', { items: 'Itens obrigatórios.' });
    return items.map((it, i) => {
      const name = String((it && it.name) || '').trim().slice(0, 200);
      const qty = Number(it && it.qty);
      const unitCents = Number(it && it.unitCents);
      if (!name || !Number.isInteger(qty) || qty < 1 || qty > 999 || !Number.isInteger(unitCents) || unitCents < 0 || unitCents > 100000000) {
        throw new HttpError(422, `Item ${i + 1} do orçamento inválido: confira nome, quantidade e valor.`, { items: 'Item inválido.' });
      }
      return { name, qty, unitCents, procedureId: it.procedureId ? String(it.procedureId) : null, tooth: it.tooth ? String(it.tooth).slice(0, 10) : null };
    });
  }
  const totals = (items, discountCents = 0) => {
    const subtotal = items.reduce((s, it) => s + it.qty * it.unitCents, 0);
    if (discountCents > subtotal) throw new HttpError(422, 'O desconto não pode ser maior que o total.', { discountCents: 'Desconto maior que o total.' });
    return { subtotalCents: subtotal, totalCents: subtotal - discountCents };
  };
  const scopeQuote = (u, q) => { const s = scope(u); if (s && q.professionalId !== s) throw new HttpError(404, 'Orçamento não encontrado.'); };
  const effectiveStatus = (q) => (q.status === 'enviado' && q.validUntil < today() ? 'vencido' : q.status);

  async function view(q) {
    const [p, pro] = await Promise.all([store.get('patients', q.patientId), store.get('professionals', q.professionalId)]);
    return { ...q, status: effectiveStatus(q), patientName: p ? p.name : '', professionalName: pro ? pro.name : '' };
  }

  r.get('/api/crm/quotes', async (req, res) => {
    const u = requirePerm(req, 'crm:read');
    const q = query(req);
    const s = scope(u);
    let list = await store.list('quotes', (x) => (!s || x.professionalId === s) &&
      (!q.get('patientId') || x.patientId === q.get('patientId')) && (!q.get('leadId') || x.leadId === q.get('leadId')));
    list.sort((a, b) => b.number - a.number);
    list = await Promise.all(list.slice(0, 500).map(view));
    if (q.get('status')) list = list.filter((x) => x.status === q.get('status'));
    sendJson(res, 200, list);
  });

  r.post('/api/crm/quotes', async (req, res) => {
    const u = requirePerm(req, 'crm:write');
    const body = await readJsonBody(req);
    const data = validate(body, quoteSchema);
    const s = scope(u);
    if (s && data.professionalId !== s) throw new HttpError(403, 'Você só pode criar orçamentos do seu médico.');
    await mustGet('patients', data.patientId, 'Paciente');
    await mustGet('professionals', data.professionalId, 'Médico');
    if (data.leadId) await mustGet('leads', data.leadId, 'Oportunidade');
    const items = cleanItems(body.items);
    const t = totals(items, data.discountCents || 0);
    const number = (await store.list('quotes')).reduce((m, x) => Math.max(m, x.number || 0), 0) + 1;
    const q = await store.insert('quotes', {
      ...data, discountCents: data.discountCents || 0, installments: data.installments || 1, items, ...t, number,
      status: 'rascunho', chargeId: null, createdById: u.id, createdByName: u.name,
      history: [{ at: new Date().toISOString(), byName: u.name, status: 'rascunho' }],
    });
    await audit(store, req, u, 'create', 'quotes', q.id, `Orçamento nº ${number} — ${F.brl(t.totalCents)}`);
    sendJson(res, 201, await view(q));
  });

  r.put('/api/crm/quotes/:id', async (req, res) => {
    const u = requirePerm(req, 'crm:write');
    const current = await mustGet('quotes', req.params.id, 'Orçamento');
    scopeQuote(u, current);
    if (!['rascunho', 'enviado'].includes(current.status)) throw new HttpError(409, 'Orçamento aprovado ou recusado não pode ser alterado.');
    const body = await readJsonBody(req);
    const data = validate(body, quoteSchema);
    const s = scope(u);
    if (s && data.professionalId !== s) throw new HttpError(403, 'Você só pode editar orçamentos do seu médico.');
    const items = cleanItems(body.items);
    const q = await store.update('quotes', current.id, { ...data, discountCents: data.discountCents || 0, installments: data.installments || 1, items, ...totals(items, data.discountCents || 0) });
    sendJson(res, 200, await view(q));
  });

  r.post('/api/crm/quotes/:id/status', async (req, res) => {
    const u = requirePerm(req, 'crm:write');
    const current = await mustGet('quotes', req.params.id, 'Orçamento');
    scopeQuote(u, current);
    const body = await readJsonBody(req);
    const next = body.status;
    const allowed = { rascunho: ['enviado', 'aprovado', 'recusado'], enviado: ['aprovado', 'recusado', 'rascunho'], aprovado: [], recusado: [] };
    if (!(allowed[current.status] || []).includes(next)) throw new HttpError(409, `Não é possível mudar de "${QUOTE_STATUS[current.status]}" para "${QUOTE_STATUS[next] || next}".`);
    if (next === 'aprovado' && current.validUntil < today()) throw new HttpError(409, 'Orçamento vencido. Atualize a validade antes de aprovar.');
    const reason = String(body.reason || '').trim().slice(0, 300) || null;
    if (next === 'recusado' && !reason) throw new HttpError(422, 'Informe o motivo da recusa.', { reason: 'Motivo obrigatório.' });
    const patch = { status: next, history: [...(current.history || []), { at: new Date().toISOString(), byName: u.name, status: next, reason }] };
    if (next === 'aprovado') {
      if (!auth.can(u, 'finance:write')) throw new HttpError(403, 'Aprovar orçamento cria cobrança: seu perfil não tem acesso ao financeiro.');
      const charge = await store.insert('charges', {
        appointmentId: null, quoteId: current.id, patientId: current.patientId, professionalId: current.professionalId,
        description: `Orçamento nº ${current.number}`, amountCents: current.totalCents, dueDate: today(),
        method: current.method, installments: current.installments, coverage: 'particular', insurer: null,
        notes: current.items.map((it) => `${it.qty}x ${it.name}`).join('; ').slice(0, 2000),
        payments: [], status: 'aberto', createdById: u.id, createdByName: u.name,
      });
      patch.chargeId = charge.id;
      patch.approvedAt = new Date().toISOString();
    }
    const q = await store.update('quotes', current.id, patch);
    if (current.leadId) {
      const lead = await store.get('leads', current.leadId);
      const stage = next === 'aprovado' ? 'ganho' : next === 'enviado' ? 'orcamento' : null;
      if (lead && stage && lead.stage !== stage) {
        await store.update('leads', lead.id, {
          stage, history: [{ at: new Date().toISOString(), byName: u.name, from: lead.stage, to: stage, note: `Orçamento nº ${current.number} ${QUOTE_STATUS[next].toLowerCase()}` }, ...(lead.history || [])].slice(0, 100),
        });
      }
    }
    await audit(store, req, u, 'status', 'quotes', q.id, `Orçamento nº ${q.number}: ${QUOTE_STATUS[current.status]} → ${QUOTE_STATUS[next]}`);
    sendJson(res, 200, await view(q));
  });
}

module.exports = { registerCrm, STAGES, SOURCES, QUOTE_STATUS };

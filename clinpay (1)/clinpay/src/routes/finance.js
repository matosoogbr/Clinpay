'use strict';

const crypto = require('node:crypto');
const { HttpError, sendJson, readJsonBody } = require('../http/core');
const { validate } = require('../validation');
const auth = require('../auth');
const { audit } = require('../audit');
const F = require('../domain/finance');

const todayStr = () => {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const chargeSchema = {
  patientId: { type: 'string', required: true, label: 'Paciente' },
  professionalId: { type: 'string', required: true, label: 'Médico(a)' },
  description: { type: 'string', required: true, label: 'Descrição', max: 200 },
  amountCents: { type: 'int', required: true, label: 'Valor', min: 1, max: 100000000 },
  dueDate: { type: 'date', required: true, label: 'Vencimento' },
  method: { type: 'enum', required: true, label: 'Forma de cobrança', values: Object.keys(F.METHODS) },
  installments: { type: 'int', label: 'Parcelas', min: 1, max: 24 },
  coverage: { type: 'enum', label: 'Atendimento', values: ['particular', 'convenio'] },
  insurer: { type: 'string', label: 'Convênio', max: 120 },
  notes: { type: 'text', label: 'Observações', max: 2000 },
};

/**
 * Registra as rotas do financeiro e devolve funções usadas pela agenda
 * para criar/ajustar a cobrança de cada atendimento.
 */
function registerFinance(r, store, { requirePerm, mustGet, query }) {
  const scopeCheck = (u, professionalId) => {
    const scope = auth.proScope(u);
    if (scope && professionalId !== scope) throw new HttpError(403, 'Você só tem acesso ao financeiro do seu médico.');
  };

  async function enrichCharge(c, maps) {
    const patient = maps ? maps.patients.get(c.patientId) : await store.get('patients', c.patientId);
    const pro = maps ? maps.pros.get(c.professionalId) : await store.get('professionals', c.professionalId);
    const balance = F.balanceCents(c);
    return {
      ...c,
      patientName: patient ? patient.name : '(paciente)',
      professionalName: pro ? pro.name : '(profissional)',
      paidCents: F.paidCents(c),
      balanceCents: balance,
      overdue: balance > 0 && c.status !== 'cancelado' && c.dueDate < todayStr(),
    };
  }

  async function checkRefs(data) {
    const errors = {};
    const p = await store.get('patients', data.patientId);
    if (!p) errors.patientId = 'Paciente não encontrado.';
    const pro = await store.get('professionals', data.professionalId);
    if (!pro) errors.professionalId = 'Profissional não encontrado.';
    if (data.coverage === 'convenio' && !data.insurer) errors.insurer = 'Informe o convênio.';
    if (Object.keys(errors).length) throw new HttpError(422, 'Revise os campos destacados.', errors);
  }

  // ---------- Integração com a agenda ----------
  const findForAppointment = (appointmentId) =>
    store.findOne('charges', (c) => c.appointmentId === appointmentId && c.status !== 'cancelado');

  /** Cria, atualiza ou cancela a cobrança ligada a um atendimento. Lança 409 se houver pagamento em conflito. */
  async function syncAppointmentCharge(s, u, { dryRun = false } = {}) {
    const existing = await findForAppointment(s.id);
    const want = s.priceCents > 0;
    if (existing) {
      const paid = F.paidCents(existing);
      if (!want) {
        if (paid > 0) throw new HttpError(409, 'Já há pagamento registrado para este atendimento. Ajuste ou estorne no Financeiro antes de remover o valor.');
        if (!dryRun) await cancelCharge(existing, u, 'Valor removido do agendamento');
        return null;
      }
      if (paid > 0 && existing.amountCents !== s.priceCents) {
        throw new HttpError(409, 'Já há pagamento registrado para este atendimento. Altere o valor pelo Financeiro.');
      }
      if (dryRun) return existing;
      const patch = { patientId: s.patientId, professionalId: s.surgeonId, dueDate: s.date, coverage: s.coverage, insurer: s.insurer || null };
      if (paid === 0) Object.assign(patch, { amountCents: s.priceCents, method: s.chargeMethod || existing.method, installments: s.installments || 1 });
      const upd = await store.update('charges', existing.id, patch);
      return store.update('charges', upd.id, { status: F.computeStatus(upd) });
    }
    if (!want || dryRun) return null;
    return store.insert('charges', {
      appointmentId: s.id,
      patientId: s.patientId,
      professionalId: s.surgeonId,
      description: `${s.type === 'cirurgia' ? 'Cirurgia' : 'Consulta'} — ${s.procedureName} (${s.date.split('-').reverse().join('/')})`,
      amountCents: s.priceCents,
      dueDate: s.date,
      method: s.chargeMethod || 'pix',
      installments: s.installments || 1,
      coverage: s.coverage || 'particular',
      insurer: s.insurer || null,
      notes: null,
      payments: [],
      status: 'aberto',
      createdById: u.id, createdByName: u.name,
    });
  }

  async function cancelCharge(c, u, reason) {
    return store.update('charges', c.id, {
      canceledAt: new Date().toISOString(), canceledById: u.id, canceledByName: u.name, cancelReason: reason, status: 'cancelado',
    });
  }

  /** Atendimento cancelado: cancela a cobrança se nada foi pago. */
  async function onAppointmentCanceled(s, u) {
    const c = await findForAppointment(s.id);
    if (c && F.paidCents(c) === 0) await cancelCharge(c, u, 'Atendimento cancelado');
  }

  async function chargeSummaryFor(appointmentIds) {
    const set = new Set(appointmentIds);
    const list = await store.list('charges', (c) => set.has(c.appointmentId) && c.status !== 'cancelado');
    return new Map(list.map((c) => [c.appointmentId, {
      id: c.id, amountCents: c.amountCents, paidCents: F.paidCents(c), status: c.status, method: c.method, professionalId: c.professionalId,
    }]));
  }

  // ---------- Rotas ----------
  r.get('/api/finance/charges', async (req, res) => {
    const u = requirePerm(req, 'finance:read');
    const q = query(req);
    const scope = auth.proScope(u);
    const pro = scope || q.get('professionalId');
    const from = q.get('from'); const to = q.get('to');
    const status = q.get('status'); const patientId = q.get('patientId'); const appointmentId = q.get('appointmentId');
    const today = todayStr();
    let list = await store.list('charges', (c) =>
      (!pro || c.professionalId === pro) && (!patientId || c.patientId === patientId) &&
      (!appointmentId || c.appointmentId === appointmentId) &&
      // No período: vencimento no período OU algum pagamento recebido no período
      (!(from || to) || ((!from || c.dueDate >= from) && (!to || c.dueDate <= to)) ||
        F.activePayments(c).some((p) => (!from || p.paidAt >= from) && (!to || p.paidAt <= to))) &&
      (!status || (status === 'atrasado'
        ? c.status !== 'cancelado' && c.status !== 'pago' && c.dueDate < today
        : status === 'pendente' ? c.status === 'aberto' || c.status === 'parcial' : c.status === status)));
    list.sort((a, b) => b.dueDate.localeCompare(a.dueDate) || b.createdAt.localeCompare(a.createdAt));
    list = list.slice(0, 1000);
    const maps = {
      patients: new Map((await store.list('patients')).map((p) => [p.id, p])),
      pros: new Map((await store.list('professionals')).map((p) => [p.id, p])),
    };
    sendJson(res, 200, await Promise.all(list.map((c) => enrichCharge(c, maps))));
  });

  r.get('/api/finance/charges/:id', async (req, res) => {
    const u = requirePerm(req, 'finance:read');
    const c = await mustGet('charges', req.params.id, 'Cobrança');
    scopeCheck(u, c.professionalId);
    sendJson(res, 200, await enrichCharge(c));
  });

  r.post('/api/finance/charges', async (req, res) => {
    const u = requirePerm(req, 'finance:write');
    const data = validate(await readJsonBody(req), chargeSchema);
    scopeCheck(u, data.professionalId);
    await checkRefs(data);
    const c = await store.insert('charges', {
      ...data, installments: data.installments || 1, coverage: data.coverage || 'particular',
      appointmentId: null, payments: [], status: 'aberto', createdById: u.id, createdByName: u.name,
    });
    await audit(store, req, u, 'create', 'charges', c.id, `${data.description} — ${F.brl(data.amountCents)}`);
    sendJson(res, 201, await enrichCharge(c));
  });

  r.put('/api/finance/charges/:id', async (req, res) => {
    const u = requirePerm(req, 'finance:write');
    const current = await mustGet('charges', req.params.id, 'Cobrança');
    scopeCheck(u, current.professionalId);
    if (current.status === 'cancelado') throw new HttpError(409, 'Cobrança cancelada não pode ser alterada.');
    const data = validate(await readJsonBody(req), chargeSchema, { partial: true });
    if (data.professionalId) scopeCheck(u, data.professionalId);
    const merged = { ...current, ...data };
    await checkRefs(merged);
    if (current.appointmentId && (data.patientId && data.patientId !== current.patientId)) {
      throw new HttpError(409, 'O paciente desta cobrança vem do agendamento. Altere pelo agendamento.');
    }
    const paid = F.paidCents(current);
    if (data.amountCents !== undefined && data.amountCents < paid) {
      throw new HttpError(422, `O valor não pode ser menor que o já pago (${F.brl(paid)}).`, { amountCents: 'Menor que o valor já pago.' });
    }
    const upd = await store.update('charges', current.id, data);
    const final = await store.update('charges', current.id, { status: F.computeStatus(upd) });
    await audit(store, req, u, 'update', 'charges', current.id,
      `${current.description}${data.amountCents !== undefined && data.amountCents !== current.amountCents ? ` — valor ${F.brl(current.amountCents)} → ${F.brl(data.amountCents)}` : ''}`);
    sendJson(res, 200, await enrichCharge(final));
  });

  r.post('/api/finance/charges/:id/payments', async (req, res) => {
    const u = requirePerm(req, 'finance:write');
    const c = await mustGet('charges', req.params.id, 'Cobrança');
    scopeCheck(u, c.professionalId);
    if (c.status === 'cancelado') throw new HttpError(409, 'Cobrança cancelada não recebe pagamentos.');
    const data = validate(await readJsonBody(req), {
      amountCents: { type: 'int', required: true, label: 'Valor recebido', min: 1, max: 100000000 },
      method: { type: 'enum', required: true, label: 'Forma de pagamento', values: Object.keys(F.METHODS) },
      paidAt: { type: 'date', required: true, label: 'Data do recebimento', custom: (v) => (v > todayStr() ? 'A data não pode estar no futuro.' : null) },
      installments: { type: 'int', label: 'Parcelas', min: 1, max: 24 },
      notes: { type: 'string', label: 'Observação', max: 300 },
    });
    const balance = F.balanceCents(c);
    if (data.amountCents > balance) {
      throw new HttpError(422, `O valor é maior que o saldo em aberto (${F.brl(balance)}).`, { amountCents: `Máximo: ${F.brl(balance)}.` });
    }
    const payment = {
      id: crypto.randomUUID(), ...data, installments: data.installments || 1,
      at: new Date().toISOString(), byId: u.id, byName: u.name, reversedAt: null,
    };
    const upd = { ...c, payments: [...(c.payments || []), payment] };
    const saved = await store.update('charges', c.id, { payments: upd.payments, status: F.computeStatus(upd) });
    await audit(store, req, u, 'payment', 'charges', c.id, `${F.brl(data.amountCents)} via ${F.METHODS[data.method]} — ${c.description}`);
    sendJson(res, 200, await enrichCharge(saved));
  });

  r.post('/api/finance/charges/:id/payments/:pid/reverse', async (req, res) => {
    const u = requirePerm(req, 'finance:reverse');
    const c = await mustGet('charges', req.params.id, 'Cobrança');
    const body = await readJsonBody(req);
    const reason = String(body.reason || '').trim();
    if (reason.length < 5) throw new HttpError(422, 'Informe o motivo do estorno.', { reason: 'Motivo obrigatório.' });
    const p = (c.payments || []).find((x) => x.id === req.params.pid);
    if (!p) throw new HttpError(404, 'Pagamento não encontrado.');
    if (p.reversedAt) throw new HttpError(409, 'Este pagamento já foi estornado.');
    const payments = c.payments.map((x) => (x.id === p.id
      ? { ...x, reversedAt: new Date().toISOString(), reversedById: u.id, reversedByName: u.name, reverseReason: reason.slice(0, 300) } : x));
    const saved = await store.update('charges', c.id, { payments, status: F.computeStatus({ ...c, payments }) });
    await audit(store, req, u, 'reverse', 'charges', c.id, `Estorno de ${F.brl(p.amountCents)}: ${reason}`);
    sendJson(res, 200, await enrichCharge(saved));
  });

  r.post('/api/finance/charges/:id/cancel', async (req, res) => {
    const u = requirePerm(req, 'finance:write');
    const c = await mustGet('charges', req.params.id, 'Cobrança');
    scopeCheck(u, c.professionalId);
    if (c.status === 'cancelado') throw new HttpError(409, 'Cobrança já cancelada.');
    if (F.paidCents(c) > 0) throw new HttpError(409, 'Há pagamentos registrados. Peça ao administrador para estorná-los antes de cancelar.');
    const body = await readJsonBody(req);
    const reason = String(body.reason || '').trim();
    if (reason.length < 3) throw new HttpError(422, 'Informe o motivo do cancelamento.', { reason: 'Motivo obrigatório.' });
    const saved = await cancelCharge(c, u, reason.slice(0, 300));
    await audit(store, req, u, 'cancel', 'charges', c.id, `${c.description}: ${reason}`);
    sendJson(res, 200, await enrichCharge(saved));
  });

  r.get('/api/finance/summary', async (req, res) => {
    const u = requirePerm(req, 'finance:read');
    const q = query(req);
    const scope = auth.proScope(u);
    const pro = scope || q.get('professionalId');
    const today = todayStr();
    const from = q.get('from') || today.slice(0, 8) + '01';
    const to = q.get('to') || today;
    const charges = await store.list('charges', (c) => !pro || c.professionalId === pro);
    const pros = new Map((await store.list('professionals')).map((p) => [p.id, p]));
    let receivedCents = 0; let toReceiveCents = 0; let overdueCents = 0; let billedCents = 0;
    const byMethod = {}; const byPro = new Map();
    const proRow = (id) => {
      if (!byPro.has(id)) byPro.set(id, { professionalId: id, name: (pros.get(id) || {}).name || '(profissional)', receivedCents: 0, toReceiveCents: 0 });
      return byPro.get(id);
    };
    for (const c of charges) {
      for (const p of F.activePayments(c)) {
        if (p.paidAt >= from && p.paidAt <= to) {
          receivedCents += p.amountCents;
          byMethod[p.method] = (byMethod[p.method] || 0) + p.amountCents;
          proRow(c.professionalId).receivedCents += p.amountCents;
        }
      }
      if (c.status === 'cancelado') continue;
      const bal = F.balanceCents(c);
      if (c.dueDate >= from && c.dueDate <= to) {
        billedCents += c.amountCents;
        toReceiveCents += bal;
        proRow(c.professionalId).toReceiveCents += bal;
      }
      if (bal > 0 && c.dueDate < today) overdueCents += bal;
    }
    const exps = await store.list('expenses', (e) => !pro || e.professionalId === pro);
    let expensesPaidCents = 0; let expensesOpenCents = 0; const byExpense = {};
    for (const e of exps) {
      if (e.status === 'pago' && e.paidAt >= from && e.paidAt <= to) { expensesPaidCents += e.amountCents; byExpense[e.category] = (byExpense[e.category] || 0) + e.amountCents; }
      if (e.status === 'aberto' && e.dueDate <= to) expensesOpenCents += e.amountCents;
    }
    sendJson(res, 200, {
      from, to, receivedCents, toReceiveCents, overdueCents, billedCents,
      expensesPaidCents, expensesOpenCents, profitCents: receivedCents - expensesPaidCents,
      byExpenseCategory: Object.entries(byExpense).map(([k, v]) => ({ key: k, label: F.EXPENSE_CATEGORIES[k], cents: v })).sort((x, y) => y.cents - x.cents),
      byMethod: Object.entries(byMethod).map(([method, cents]) => ({ method, label: F.METHODS[method], cents })).sort((a, b) => b.cents - a.cents),
      byProfessional: scope ? [] : [...byPro.values()].sort((a, b) => b.receivedCents - a.receivedCents),
    });
  });

  // ---------------- Despesas (contas a pagar) ----------------
  // Médico e funcionário veem só as despesas ligadas ao próprio médico; despesas gerais da clínica
  // (sem médico) ficam com o médico responsável e a recepção.
  const expenseSchema = {
    description: { type: 'string', required: true, label: 'Descrição', max: 200 },
    category: { type: 'enum', required: true, label: 'Categoria', values: Object.keys(F.EXPENSE_CATEGORIES) },
    amountCents: { type: 'int', required: true, label: 'Valor', min: 1, max: 100000000 },
    dueDate: { type: 'date', required: true, label: 'Vencimento' },
    supplier: { type: 'string', label: 'Fornecedor', max: 150 },
    professionalId: { type: 'string', label: 'Médico' },
    notes: { type: 'text', label: 'Observações', max: 2000 },
  };
  const expScope = (u, e) => { const s = auth.proScope(u); if (s && e.professionalId !== s) throw new HttpError(404, 'Despesa não encontrada.'); };

  r.get('/api/finance/expenses', async (req, res) => {
    const u = requirePerm(req, 'finance:read');
    const q = query(req); const s = auth.proScope(u);
    const from = q.get('from'); const to = q.get('to'); const status = q.get('status');
    const list = await store.list('expenses', (e) => (!s || e.professionalId === s) &&
      (!from || (e.paidAt || e.dueDate) >= from) && (!to || (e.paidAt || e.dueDate) <= to) && (!status || e.status === status));
    list.sort((a, b) => (b.paidAt || b.dueDate).localeCompare(a.paidAt || a.dueDate));
    const pros = new Map((await store.list('professionals')).map((p) => [p.id, p.name]));
    sendJson(res, 200, list.slice(0, 1000).map((e) => ({ ...e, professionalName: e.professionalId ? pros.get(e.professionalId) || '' : null, overdue: e.status === 'aberto' && e.dueDate < todayStr() })));
  });

  r.post('/api/finance/expenses', async (req, res) => {
    const u = requirePerm(req, 'finance:write');
    const body = await readJsonBody(req);
    const data = validate(body, expenseSchema);
    const s = auth.proScope(u);
    if (s) data.professionalId = s;
    if (data.professionalId && !(await store.get('professionals', data.professionalId))) throw new HttpError(422, 'Médico não encontrado.');
    const paid = body.paidAt ? validate(body, {
      paidAt: { type: 'date', required: true, label: 'Data do pagamento', custom: (v) => (v > todayStr() ? 'A data não pode estar no futuro.' : null) },
      method: { type: 'enum', required: true, label: 'Forma de pagamento', values: Object.keys(F.METHODS) },
    }) : null;
    const e = await store.insert('expenses', {
      ...data, status: paid ? 'pago' : 'aberto', paidAt: paid ? paid.paidAt : null, method: paid ? paid.method : null,
      createdById: u.id, createdByName: u.name,
    });
    await audit(store, req, u, 'create', 'expenses', e.id, `${e.description} — ${F.brl(e.amountCents)}`);
    sendJson(res, 201, e);
  });

  r.put('/api/finance/expenses/:id', async (req, res) => {
    const u = requirePerm(req, 'finance:write');
    const current = await mustGet('expenses', req.params.id, 'Despesa');
    expScope(u, current);
    if (current.status !== 'aberto') throw new HttpError(409, 'Só é possível editar despesas em aberto.');
    const data = validate(await readJsonBody(req), expenseSchema, { partial: true });
    if (auth.proScope(u)) delete data.professionalId;
    const e = await store.update('expenses', current.id, data);
    await audit(store, req, u, 'update', 'expenses', e.id, e.description);
    sendJson(res, 200, e);
  });

  r.post('/api/finance/expenses/:id/pay', async (req, res) => {
    const u = requirePerm(req, 'finance:write');
    const current = await mustGet('expenses', req.params.id, 'Despesa');
    expScope(u, current);
    if (current.status !== 'aberto') throw new HttpError(409, 'Esta despesa não está em aberto.');
    const data = validate(await readJsonBody(req), {
      paidAt: { type: 'date', required: true, label: 'Data do pagamento', custom: (v) => (v > todayStr() ? 'A data não pode estar no futuro.' : null) },
      method: { type: 'enum', required: true, label: 'Forma de pagamento', values: Object.keys(F.METHODS) },
    });
    const e = await store.update('expenses', current.id, { ...data, status: 'pago', paidById: u.id, paidByName: u.name });
    await audit(store, req, u, 'payment', 'expenses', e.id, `Pago: ${e.description} — ${F.brl(e.amountCents)}`);
    sendJson(res, 200, e);
  });

  r.post('/api/finance/expenses/:id/cancel', async (req, res) => {
    const u = requirePerm(req, 'finance:write');
    const current = await mustGet('expenses', req.params.id, 'Despesa');
    expScope(u, current);
    if (current.status === 'cancelado') throw new HttpError(409, 'Despesa já cancelada.');
    if (current.status === 'pago' && !auth.can(u, 'finance:reverse')) throw new HttpError(403, 'Só o médico responsável pode cancelar uma despesa já paga.');
    const reason = String((await readJsonBody(req)).reason || '').trim();
    if (reason.length < 3) throw new HttpError(422, 'Informe o motivo.', { reason: 'Motivo obrigatório.' });
    const e = await store.update('expenses', current.id, { status: 'cancelado', canceledAt: new Date().toISOString(), cancelReason: reason.slice(0, 300), canceledByName: u.name });
    await audit(store, req, u, 'cancel', 'expenses', e.id, `${e.description}: ${reason}`);
    sendJson(res, 200, e);
  });

  return { syncAppointmentCharge, onAppointmentCanceled, chargeSummaryFor };
}

module.exports = { registerFinance };

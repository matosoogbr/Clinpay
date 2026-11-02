// CRM e vendas: funil de oportunidades (arrastar e soltar) e orçamentos
import {
  api, state, esc, fmtDate, fmtDateTime, todayStr, addDays, toast, $, modal, showErrors, readForm, options, can,
  notifyChange, ICONS, myPro, fmtMoney, parseMoney, moneyInput, promptDialog, printModal,
} from './core.js';
import { openPatientForm } from './patients.js';

const STAGE_ORDER = ['novo', 'contato', 'avaliacao', 'orcamento', 'ganho', 'perdido'];
const Q_CHIP = { rascunho: '', enviado: 'agendada', aprovado: 'concluida', recusado: 'cancelada', vencido: 'faltou' };

export async function crmPage(page, params) {
  const tab = params.get('tab') === 'orcamentos' ? 'orcamentos' : 'funil';
  const [leads, quotes, pros] = await Promise.all([api('GET', '/api/crm/leads'), api('GET', '/api/crm/quotes'), api('GET', '/api/professionals')]);
  const M = state.meta;
  const open = leads.filter((l) => !['ganho', 'perdido'].includes(l.stage));
  const pipeline = open.reduce((s, l) => s + (l.estimatedCents || 0), 0);
  const sent = quotes.filter((q) => q.status === 'enviado');
  page.innerHTML = `
    <div class="page-head">
      <div><button class="btn menu-toggle" id="menuToggle" aria-label="Abrir menu">${ICONS.menu}</button><h1>CRM e vendas</h1>
      <p class="muted">Do primeiro contato ao orçamento aprovado.</p></div>
      <div class="toolbar">${can('crm:write') ? '<button class="btn" id="newQuote">Novo orçamento</button><button class="btn primary" id="newLead">Nova oportunidade</button>' : ''}</div>
    </div>
    <div class="stats">
      <div class="stat"><b>${open.length}</b><span>oportunidades abertas</span></div>
      <div class="stat"><b>${esc(fmtMoney(pipeline))}</b><span>valor estimado em negociação</span></div>
      <div class="stat"><b>${sent.length}</b><span>orçamentos aguardando resposta (${esc(fmtMoney(sent.reduce((s, q) => s + q.totalCents, 0)))})</span></div>
      <div class="stat"><b>${leads.filter((l) => l.nextContactAt && l.nextContactAt <= todayStr() && !['ganho', 'perdido'].includes(l.stage)).length}</b><span>contatos para fazer hoje</span></div>
    </div>
    <div class="tabs" role="tablist"><button data-tab="funil" class="${tab === 'funil' ? 'active' : ''}">Funil</button><button data-tab="orcamentos" class="${tab === 'orcamentos' ? 'active' : ''}">Orçamentos (${quotes.length})</button></div>
    <div id="crmBody"></div>`;
  page.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { location.hash = `#/crm?tab=${b.dataset.tab}`; }; });
  const nl = $('#newLead'); if (nl) nl.onclick = () => openLead(null, pros);
  const nq = $('#newQuote'); if (nq) nq.onclick = () => openQuoteForm({}, pros);
  const body = $('#crmBody');

  if (tab === 'orcamentos') {
    body.innerHTML = quotes.length ? `<div class="table-wrap"><table class="list"><thead><tr><th>Nº</th><th>Paciente</th><th>Médico(a)</th><th>Itens</th><th>Total</th><th>Validade</th><th>Situação</th></tr></thead><tbody>
      ${quotes.map((q) => `<tr class="clickable" data-q="${esc(q.id)}"><td>${q.number}</td><td>${esc(q.patientName)}</td><td>${esc(q.professionalName)}</td>
        <td class="small">${esc(q.items.map((i) => `${i.qty}x ${i.name}`).join(', ').slice(0, 80))}</td><td><strong>${esc(fmtMoney(q.totalCents))}</strong></td>
        <td>${esc(fmtDate(q.validUntil))}</td><td><span class="chip ${Q_CHIP[q.status]}">${esc(M.quoteStatus[q.status])}</span></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="panel empty"><h2>Nenhum orçamento</h2><p>Crie um orçamento a partir de uma oportunidade ou do botão "Novo orçamento".</p></div>';
    body.querySelectorAll('[data-q]').forEach((tr) => { tr.onclick = () => openQuote(tr.dataset.q, pros); });
    return;
  }

  body.innerHTML = `<p class="muted small">Arraste os cartões entre as etapas ou clique para ver detalhes.</p>
    <div class="kanban">${STAGE_ORDER.map((st) => {
      const items = leads.filter((l) => l.stage === st);
      return `<div class="kcol" data-stage="${st}"><h3><span>${esc(M.leadStages[st])}</span><span class="chip">${items.length}</span></h3>
        ${items.map((l) => `<div class="kcard" draggable="${can('crm:write')}" data-lead="${esc(l.id)}" tabindex="0">
          <strong>${esc(l.name)}</strong><span class="small">${esc(l.interest || '')}</span>
          <div class="small muted">${esc(M.leadSources[l.source])}${l.estimatedCents ? ` · ${esc(fmtMoney(l.estimatedCents))}` : ''}</div>
          ${l.nextContactAt && !['ganho', 'perdido'].includes(st) ? `<div class="small" style="color:${l.nextContactAt <= todayStr() ? 'var(--danger)' : 'var(--muted)'}">Retornar em ${esc(fmtDate(l.nextContactAt))}</div>` : ''}
        </div>`).join('')}</div>`;
    }).join('')}</div>`;
  body.querySelectorAll('[data-lead]').forEach((c) => {
    c.onclick = () => openLead(leads.find((l) => l.id === c.dataset.lead), pros);
    c.onkeydown = (e) => { if (e.key === 'Enter') c.click(); };
    c.ondragstart = (e) => { e.dataTransfer.setData('text/plain', c.dataset.lead); };
  });
  body.querySelectorAll('[data-stage]').forEach((col) => {
    col.ondragover = (e) => { e.preventDefault(); col.classList.add('drop'); };
    col.ondragleave = () => col.classList.remove('drop');
    col.ondrop = async (e) => {
      e.preventDefault(); col.classList.remove('drop');
      const id = e.dataTransfer.getData('text/plain'); const stage = col.dataset.stage;
      const lead = leads.find((l) => l.id === id);
      if (!lead || lead.stage === stage) return;
      await moveLead(lead, stage);
    };
  });
}

async function moveLead(lead, stage) {
  let note = null;
  if (stage === 'perdido') { note = await promptDialog('Oportunidade perdida', 'Motivo (ex.: preço, desistiu, escolheu outra clínica)', { okLabel: 'Marcar como perdida' }); if (!note) return; }
  try { await api('POST', `/api/crm/leads/${encodeURIComponent(lead.id)}/stage`, { stage, note }); toast(`Movido para "${state.meta.leadStages[stage]}".`); notifyChange(); } catch (e) { toast(e.message, 'error'); }
}

function openLead(l, pros) {
  const M = state.meta; const mine = myPro();
  const v = l || { source: 'whatsapp', professionalId: mine || '' };
  const docs = pros.filter((p) => p.active && (!mine || p.id === mine));
  const m = modal({
    title: l ? l.name : 'Nova oportunidade',
    wide: !!l,
    body: `<div class="form" id="lForm">
      <div class="field s3"><label class="req" for="name">Nome</label><input name="name" id="name" value="${esc(v.name || '')}"></div>
      <div class="field s3"><label class="req" for="source">Origem</label><select name="source" id="source">${options(M.leadSources, v.source)}</select></div>
      <div class="field s2"><label for="phone">Telefone</label><input name="phone" id="phone" value="${esc(v.phone || '')}"></div>
      <div class="field s2"><label for="email">E-mail</label><input type="email" name="email" id="email" value="${esc(v.email || '')}"></div>
      <div class="field s2"><label for="nextContactAt">Próximo contato</label><input type="date" name="nextContactAt" id="nextContactAt" value="${esc(v.nextContactAt || '')}"></div>
      <div class="field s3"><label for="interest">Interesse</label><input name="interest" id="interest" value="${esc(v.interest || '')}" placeholder="Ex.: implante, clareamento, avaliação"></div>
      <div class="field s2"><label for="professionalId">Médico(a)</label><select name="professionalId" id="professionalId">${mine ? '' : '<option value="">Sem médico definido</option>'}${docs.map((p) => `<option value="${esc(p.id)}"${p.id === v.professionalId ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div class="field s1"><label for="est">Valor estimado</label><input id="est" inputmode="decimal" value="${esc(moneyInput(v.estimatedCents))}" placeholder="0,00"></div>
      <div class="field s6"><label for="notes">Observações</label><textarea name="notes" id="notes">${esc(v.notes || '')}</textarea></div>
      ${l ? `<div class="field s6"><label for="stage">Etapa</label><select id="stage">${options(M.leadStages, l.stage)}</select>${l.lostReason ? `<span class="hint">Motivo da perda: ${esc(l.lostReason)}</span>` : ''}</div>
      <div class="field s6"><div class="toolbar">
        ${l.patientId ? '<span class="chip concluida">Já é paciente</span>' : '<button class="btn sm" type="button" id="toPatient">Cadastrar como paciente</button>'}
        ${l.patientId ? '<button class="btn sm primary" type="button" id="mkQuote">Criar orçamento</button>' : ''}
        ${l.phone ? `<a class="btn sm" target="_blank" rel="noopener" href="https://wa.me/${esc(waNumber(l.phone))}">Abrir conversa no WhatsApp</a>` : ''}
      </div></div>
      <div class="field s6"><label>Histórico</label><ul class="history">${(l.history || []).map((h) => `<li class="small">${esc(fmtDateTime(h.at))} — ${esc(h.byName)}: ${h.from ? `${esc(M.leadStages[h.from])} → ` : ''}${esc(M.leadStages[h.to] || '')}${h.note ? ` — ${esc(h.note)}` : ''}</li>`).join('')}</ul></div>` : ''}
      <div class="field s6" id="lErr"></div></div>`,
    foot: `<button class="btn" data-cancel>Fechar</button>${can('crm:write') ? `<button class="btn primary" data-save>${l ? 'Salvar' : 'Criar oportunidade'}</button>` : ''}`,
  });
  const f = m.el.querySelector('#lForm');
  m.el.querySelector('[data-cancel]').onclick = m.close;
  const save = m.el.querySelector('[data-save]');
  if (save) save.onclick = async () => {
    const d = readForm(f);
    const est = parseMoney(f.querySelector('#est').value);
    if (Number.isNaN(est)) { showErrors(f, { message: 'Valor estimado inválido.', fields: {} }, f.querySelector('#lErr')); return; }
    d.estimatedCents = est; if (!d.professionalId) d.professionalId = null;
    try {
      if (l) {
        await api('PUT', `/api/crm/leads/${encodeURIComponent(l.id)}`, d);
        const st = f.querySelector('#stage').value;
        if (st !== l.stage) { m.close(); await moveLead(l, st); return; }
      } else await api('POST', '/api/crm/leads', d);
      m.close(); toast('Oportunidade salva.'); notifyChange();
    } catch (e) { showErrors(f, e, f.querySelector('#lErr')); }
  };
  const tp = f.querySelector('#toPatient');
  if (tp) tp.onclick = () => {
    m.close();
    openPatientForm({ name: l.name, phone: l.phone, email: l.email, coverage: 'particular', __new: true }, async (p) => {
      await api('POST', `/api/crm/leads/${encodeURIComponent(l.id)}/link`, { patientId: p.id });
      toast('Paciente cadastrado e ligado à oportunidade.'); notifyChange();
    });
  };
  const mq = f.querySelector('#mkQuote');
  if (mq) mq.onclick = () => { m.close(); openQuoteForm({ patientId: l.patientId, leadId: l.id, professionalId: l.professionalId }, pros); };
}

const waNumber = (phone) => { const d = String(phone || '').replace(/\D/g, ''); return d.length <= 11 ? '55' + d : d; };

// ---------- Orçamento ----------
async function openQuoteForm(pre, pros, existing) {
  const procs = (await api('GET', '/api/procedures')).filter((p) => p.active);
  const mine = myPro();
  const docs = pros.filter((p) => p.active && (!mine || p.id === mine));
  const doctors = docs.filter((p) => ['medico', 'cirurgiao'].includes(p.role));
  const only = doctors.length === 1 ? doctors[0].id : '';
  const v = existing || { validUntil: addDays(todayStr(), 15), method: 'pix', installments: 1, discountCents: 0, items: [{ name: '', qty: 1, unitCents: 0 }], ...pre, professionalId: pre.professionalId || mine || only };
  let patientName = '';
  if (v.patientId) { try { patientName = (await api('GET', `/api/patients/${encodeURIComponent(v.patientId)}`)).name; } catch { /* sem acesso */ } }
  const M = state.meta;
  const m = modal({
    title: existing ? `Editar orçamento nº ${existing.number}` : 'Novo orçamento',
    wide: true,
    body: `<div class="form" id="qForm">
      <div class="field s3"><label class="req">Paciente</label><input type="hidden" name="patientId" value="${esc(v.patientId || '')}">
        ${v.patientId ? `<input disabled value="${esc(patientName)}">` : '<div class="typeahead"><input id="pq" placeholder="Digite o nome do paciente" autocomplete="off"><div class="results hidden" id="pres"></div></div>'}</div>
      <div class="field s3"><label class="req" for="professionalId">Médico(a)</label><select name="professionalId" id="professionalId">${mine ? '' : '<option value="">Selecione…</option>'}${docs.map((p) => `<option value="${esc(p.id)}"${p.id === v.professionalId ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div class="field s6"><label>Itens</label>
        <div class="table-wrap"><table class="list"><thead><tr><th>Procedimento</th><th style="width:90px">Dente</th><th style="width:80px">Qtd.</th><th style="width:130px">Valor unit.</th><th style="width:120px">Subtotal</th><th></th></tr></thead><tbody id="items"></tbody></table></div>
        <div class="toolbar" style="margin-top:8px"><button class="btn sm" type="button" id="addItem">Adicionar item</button>
          <select id="pickProc" class="btn sm" aria-label="Adicionar do catálogo"><option value="">Adicionar do catálogo…</option>${procs.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.priceCents ? ` — ${esc(fmtMoney(p.priceCents))}` : ''}</option>`).join('')}</select></div></div>
      <div class="field s2"><label for="disc">Desconto (R$)</label><input id="disc" inputmode="decimal" value="${esc(moneyInput(v.discountCents))}"></div>
      <div class="field s2"><label class="req" for="validUntil">Válido até</label><input type="date" name="validUntil" id="validUntil" value="${esc(v.validUntil)}"></div>
      <div class="field s1"><label class="req" for="method">Pagamento</label><select name="method" id="method">${options(M.paymentMethods, v.method)}</select></div>
      <div class="field s1"><label for="installments">Parcelas</label><select name="installments" id="installments">${Array.from({ length: 24 }, (_, i) => `<option value="${i + 1}"${v.installments === i + 1 ? ' selected' : ''}>${i + 1}x</option>`).join('')}</select></div>
      <div class="field s6"><label for="notes">Observações para o paciente</label><textarea name="notes" id="notes">${esc(v.notes || '')}</textarea></div>
      <div class="field s6"><div class="alert info" id="totals" style="margin:0"></div></div>
      <div class="field s6" id="qErr"></div></div>`,
    foot: `<button class="btn" data-cancel>Cancelar</button><button class="btn primary" data-save>${existing ? 'Salvar' : 'Criar orçamento'}</button>`,
  });
  const f = m.el.querySelector('#qForm');
  let items = v.items.map((x) => ({ ...x }));
  const tbody = f.querySelector('#items');
  const draw = () => {
    tbody.innerHTML = items.map((it, i) => `<tr>
      <td><input data-i="${i}" data-k="name" value="${esc(it.name)}" style="width:100%" aria-label="Procedimento"></td>
      <td><input data-i="${i}" data-k="tooth" value="${esc(it.tooth || '')}" style="width:100%" placeholder="Ex.: 36" aria-label="Dente"></td>
      <td><input data-i="${i}" data-k="qty" type="number" min="1" max="999" value="${it.qty}" style="width:100%" aria-label="Quantidade"></td>
      <td><input data-i="${i}" data-k="unit" inputmode="decimal" value="${esc(moneyInput(it.unitCents))}" style="width:100%" aria-label="Valor unitário"></td>
      <td data-sub="${i}">${esc(fmtMoney((Number(it.qty) || 0) * (it.unitCents || 0)))}</td>
      <td><button class="btn sm ghost" type="button" data-del="${i}" aria-label="Remover item">✕</button></td></tr>`).join('');
    // Digitar só atualiza os dados e os totais: a tabela não é redesenhada enquanto o campo está em uso
    tbody.querySelectorAll('input').forEach((inp) => {
      inp.oninput = () => {
        const it = items[inp.dataset.i];
        if (inp.dataset.k === 'unit') { const c = parseMoney(inp.value); it.unitCents = Number.isNaN(c) || c == null ? 0 : c; }
        else if (inp.dataset.k === 'qty') it.qty = Math.max(1, parseInt(inp.value, 10) || 1);
        else it[inp.dataset.k] = inp.value;
        totals();
      };
    });
    tbody.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => { items.splice(Number(b.dataset.del), 1); if (!items.length) items.push({ name: '', qty: 1, unitCents: 0 }); draw(); }; });
    totals();
  };
  const totals = () => {
    items.forEach((it, i) => { const td = tbody.querySelector(`[data-sub="${i}"]`); if (td) td.textContent = fmtMoney((Number(it.qty) || 0) * (it.unitCents || 0)); });
    const sub = items.reduce((s, it) => s + (Number(it.qty) || 0) * (it.unitCents || 0), 0);
    const disc = parseMoney(f.querySelector('#disc').value) || 0;
    const n = Number(f.querySelector('#installments').value) || 1;
    f.querySelector('#totals').innerHTML = `Subtotal ${esc(fmtMoney(sub))} · Desconto ${esc(fmtMoney(disc))} · <strong>Total ${esc(fmtMoney(Math.max(sub - disc, 0)))}</strong>${n > 1 ? ` · ${n}x de ${esc(fmtMoney(Math.round(Math.max(sub - disc, 0) / n)))}` : ''}`;
  };
  draw();
  f.querySelector('#disc').oninput = totals; f.querySelector('#installments').onchange = totals;
  f.querySelector('#addItem').onclick = () => { items.push({ name: '', qty: 1, unitCents: 0 }); draw(); };
  f.querySelector('#pickProc').onchange = (e) => {
    const p = procs.find((x) => x.id === e.target.value); if (!p) return;
    const blank = items.findIndex((it) => !it.name);
    const row = { name: p.name, qty: 1, unitCents: p.priceCents || 0, procedureId: p.id };
    if (blank >= 0) items[blank] = row; else items.push(row);
    e.target.value = ''; draw();
  };
  if (!v.patientId) {
    const q = f.querySelector('#pq'); const res = f.querySelector('#pres'); let t;
    q.oninput = () => {
      clearTimeout(t); f.querySelector('[name=patientId]').value = '';
      t = setTimeout(async () => {
        if (q.value.trim().length < 2) { res.classList.add('hidden'); return; }
        const list = (await api('GET', `/api/patients?q=${encodeURIComponent(q.value.trim())}`)).slice(0, 12);
        res.innerHTML = list.map((p) => `<button type="button" data-pid="${esc(p.id)}">${esc(p.name)}</button>`).join('') || '<div style="padding:10px" class="muted">Nenhum paciente.</div>';
        res.classList.remove('hidden');
        res.querySelectorAll('[data-pid]').forEach((b) => { b.onclick = () => { f.querySelector('[name=patientId]').value = b.dataset.pid; q.value = b.textContent; res.classList.add('hidden'); }; });
      }, 250);
    };
  }
  m.el.querySelector('[data-cancel]').onclick = m.close;
  m.el.querySelector('[data-save]').onclick = async () => {
    const d = readForm(f);
    const disc = parseMoney(f.querySelector('#disc').value);
    const errBox = f.querySelector('#qErr');
    if (!d.patientId) { showErrors(f, { message: 'Selecione o paciente.', fields: {} }, errBox); return; }
    if (Number.isNaN(disc)) { showErrors(f, { message: 'Desconto inválido.', fields: {} }, errBox); return; }
    const payload = { ...d, leadId: v.leadId || null, discountCents: disc || 0, installments: Number(d.installments) || 1,
      items: items.filter((it) => it.name.trim()).map((it) => ({ name: it.name.trim(), qty: Number(it.qty), unitCents: it.unitCents, procedureId: it.procedureId || null, tooth: it.tooth || null })) };
    try {
      const q = existing ? await api('PUT', `/api/crm/quotes/${encodeURIComponent(existing.id)}`, payload) : await api('POST', '/api/crm/quotes', payload);
      m.close(); toast('Orçamento salvo.'); notifyChange(); openQuote(q.id, pros);
    } catch (e) { showErrors(f, e, errBox); }
  };
}

async function openQuote(id, pros) {
  const list = await api('GET', '/api/crm/quotes');
  const q = list.find((x) => x.id === id);
  if (!q) { toast('Orçamento não encontrado.', 'error'); return; }
  const M = state.meta;
  const editable = ['rascunho', 'enviado'].includes(q.status) && can('crm:write');
  const m = modal({
    title: `Orçamento nº ${q.number}`,
    wide: true,
    body: `<div class="print-only"><img src="/logo.svg" alt="ClinPay" style="width:150px"><br>${esc(M.clinicName)}</div>
      <div class="toolbar" style="margin-bottom:10px"><span class="chip ${Q_CHIP[q.status]}">${esc(M.quoteStatus[q.status])}</span></div>
      <dl class="kv"><dt>Paciente</dt><dd>${esc(q.patientName)}</dd><dt>Médico(a)</dt><dd>${esc(q.professionalName)}</dd>
        <dt>Válido até</dt><dd>${esc(fmtDate(q.validUntil))}</dd><dt>Pagamento</dt><dd>${esc(M.paymentMethods[q.method])}${q.installments > 1 ? ` em ${q.installments}x de ${esc(fmtMoney(Math.round(q.totalCents / q.installments)))}` : ''}</dd></dl>
      <div class="table-wrap" style="margin:14px 0"><table class="list"><thead><tr><th>Procedimento</th><th>Dente</th><th>Qtd.</th><th>Valor unit.</th><th>Subtotal</th></tr></thead><tbody>
        ${q.items.map((i) => `<tr><td>${esc(i.name)}</td><td>${esc(i.tooth || '—')}</td><td>${i.qty}</td><td>${esc(fmtMoney(i.unitCents))}</td><td>${esc(fmtMoney(i.qty * i.unitCents))}</td></tr>`).join('')}
        ${q.discountCents ? `<tr><td colspan="4">Desconto</td><td>− ${esc(fmtMoney(q.discountCents))}</td></tr>` : ''}
        <tr><td colspan="4"><strong>Total</strong></td><td><strong>${esc(fmtMoney(q.totalCents))}</strong></td></tr></tbody></table></div>
      ${q.notes ? `<p>${esc(q.notes)}</p>` : ''}
      <div class="toolbar no-print" id="qActs">
        ${editable ? '<button class="btn" data-edit>Editar</button>' : ''}
        ${q.status === 'rascunho' && can('crm:write') ? '<button class="btn primary" data-st="enviado">Marcar como enviado</button>' : ''}
        ${editable && can('finance:write') ? '<button class="btn ok" data-st="aprovado">Paciente aprovou</button>' : ''}
        ${editable ? '<button class="btn danger" data-st="recusado">Paciente recusou</button>' : ''}
        <button class="btn" data-print>${ICONS.print} Imprimir</button>
        ${q.chargeId ? `<a class="btn" href="#/financeiro?charge=${esc(q.chargeId)}" data-gofin>Ver cobrança</a>` : ''}
      </div>
      <h3 style="margin:16px 0 6px" class="no-print">Histórico</h3>
      <ul class="history no-print">${(q.history || []).map((h) => `<li class="small">${esc(fmtDateTime(h.at))} — ${esc(h.byName)}: ${esc(M.quoteStatus[h.status])}${h.reason ? ` — ${esc(h.reason)}` : ''}</li>`).join('')}</ul>
      <div id="qErr2"></div>`,
  });
  const b = m.el.querySelector('.modal-body');
  const ed = b.querySelector('[data-edit]'); if (ed) ed.onclick = () => { m.close(); openQuoteForm({}, pros, q); };
  b.querySelector('[data-print]').onclick = () => printModal(m);
  const gf = b.querySelector('[data-gofin]'); if (gf) gf.onclick = () => m.close();
  b.querySelectorAll('[data-st]').forEach((btn) => {
    btn.onclick = async () => {
      const st = btn.dataset.st; let reason = null;
      if (st === 'recusado') { reason = await promptDialog('Orçamento recusado', 'Motivo da recusa'); if (!reason) return; }
      try {
        await api('POST', `/api/crm/quotes/${encodeURIComponent(q.id)}/status`, { status: st, reason });
        m.close(); toast(st === 'aprovado' ? 'Orçamento aprovado: a cobrança foi criada no Financeiro.' : 'Orçamento atualizado.'); notifyChange();
      } catch (e) { b.querySelector('#qErr2').innerHTML = `<div class="alert danger">${esc(e.message)}</div>`; }
    };
  });
}

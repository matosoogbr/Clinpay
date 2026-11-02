import {
  api, state, esc, fmtDate, fmtDateTime, todayStr, addDays, endTime, age, toast, $, modal, confirmDialog,
  promptDialog, showErrors, readForm, options, can, notifyChange, printModal, pad, ICONS, fmtCpf,
  myPro, fmtMoney, parseMoney, moneyInput,
} from './core.js';
import { openSignatureForm, openSignatureView } from './signatures.js';
import { openPatientForm } from './patients.js';
import { openPaymentForm } from './finance.js';

const SLOT_MIN = 30;
const SLOT_PX = 44;
const OPEN_STATUSES = ['agendada', 'confirmada', 'adiada'];

async function catalogs() {
  const [rooms, pros, procs] = await Promise.all([
    api('GET', '/api/rooms'), api('GET', '/api/professionals'), api('GET', '/api/procedures'),
  ]);
  return { rooms, pros, procs };
}

// =====================================================================
// Agenda
// =====================================================================
const VIEWS = { medico: 'Dia por médico', sala: 'Dia por sala', semana: 'Semana em lista' };

export async function agendaPage(page, params) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.get('d') || '') ? params.get('d') : todayStr();
  const view = VIEWS[params.get('v')] ? params.get('v') : 'medico';
  // Médico e funcionário veem o próprio médico por padrão; "todos" mostra a agenda geral
  const proParam = params.get('pro');
  const pro = proParam === 'todos' ? '' : proParam || myPro() || '';
  const nav = (d, v = view, p = proParam || '') => { location.hash = `#/agenda?d=${d}&v=${v}${p ? `&pro=${encodeURIComponent(p)}` : ''}`; };
  const { rooms, pros } = await catalogs();
  const step = view === 'semana' ? 7 : 1;

  const dt = new Date(date + 'T12:00:00');
  const title = view !== 'semana'
    ? dt.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : `${fmtDate(date)} a ${fmtDate(addDays(date, 6))}`;

  page.innerHTML = `
    <div class="page-head">
      <div class="agenda-head">
        <button class="btn menu-toggle" id="menuToggle" aria-label="Abrir menu">${ICONS.menu}</button>
        <h1 class="agenda-date">${esc(title.charAt(0).toUpperCase() + title.slice(1))}</h1>
      </div>
      <div class="toolbar">
        <button class="btn" id="prev" aria-label="Anterior">‹</button>
        <button class="btn" id="today">Hoje</button>
        <button class="btn" id="next" aria-label="Próximo">›</button>
        <input type="date" id="pick" value="${esc(date)}" class="btn" aria-label="Ir para data">
        <select id="viewSel" class="btn" aria-label="Visualização">${options(VIEWS, view)}</select>
        <select id="proSel" class="btn" aria-label="Filtrar por médico">
          <option value="todos">Todos os médicos</option>
          ${pros.map((p) => `<option value="${esc(p.id)}"${p.id === pro ? ' selected' : ''}>${esc(p.name)}${p.id === myPro() ? ' (você)' : ''}</option>`).join('')}
        </select>
        ${can('surgeries:write') ? '<button class="btn primary" id="newSx">Agendar consulta</button>' : ''}
      </div>
    </div>
    <div id="agendaBody"></div>`;

  $('#prev').onclick = () => nav(addDays(date, -step));
  $('#next').onclick = () => nav(addDays(date, step));
  $('#today').onclick = () => nav(todayStr());
  $('#pick').onchange = (e) => e.target.value && nav(e.target.value);
  $('#viewSel').onchange = (e) => nav(date, e.target.value);
  $('#proSel').onchange = (e) => nav(date, view, e.target.value);
  const nb = $('#newSx'); if (nb) nb.onclick = () => openSurgeryForm({ date, surgeonId: pro || undefined });

  const body = $('#agendaBody');
  if (!pros.some((p) => p.active)) {
    body.innerHTML = `<div class="panel empty"><h2>Nenhum médico cadastrado</h2><p>A agenda mostra os atendimentos de cada médico.</p>
      ${can('users:manage') ? '<a class="btn primary" href="#/usuarios">Cadastrar médicos</a>' : '<p>Peça ao administrador para cadastrar os médicos.</p>'}</div>`;
    return;
  }

  const qPro = pro ? `&professionalId=${encodeURIComponent(pro)}` : '';
  if (view === 'semana') {
    const list = await api('GET', `/api/surgeries?from=${date}&to=${addDays(date, 6)}${qPro}`);
    body.innerHTML = weekList(list, date);
  } else {
    const list = await api('GET', `/api/surgeries?from=${addDays(date, -1)}&to=${date}${qPro}`);
    let cols; let colOf; let prefill;
    if (view === 'sala') {
      cols = rooms.filter((r) => r.active).map((r) => ({ id: r.id, name: r.name }));
      list.forEach((s) => { if (s.roomId && !cols.some((c) => c.id === s.roomId)) cols.push({ id: s.roomId, name: `${s.roomName} (inativa)`, inactive: true }); });
      if (list.some((s) => !s.roomId)) cols.push({ id: '', name: 'Sem sala definida' });
      if (!cols.length) cols.push({ id: '', name: 'Sem sala definida' });
      colOf = (s) => s.roomId || '';
      prefill = (c) => (c.id ? { roomId: c.id } : {});
    } else {
      const doctorRoles = ['medico', 'cirurgiao'];
      cols = pros.filter((p) => (pro ? p.id === pro : p.active && doctorRoles.includes(p.role))).map((p) => ({ id: p.id, name: p.name, color: p.color }));
      list.forEach((s) => { if (!cols.some((c) => c.id === s.surgeonId) && (!pro || s.surgeonId === pro)) cols.push({ id: s.surgeonId, name: s.surgeonName }); });
      if (!cols.length) cols = pros.filter((p) => p.active).map((p) => ({ id: p.id, name: p.name, color: p.color }));
      colOf = (s) => s.surgeonId;
      prefill = (c) => ({ surgeonId: c.id });
    }
    renderBoard(body, date, cols, colOf, prefill, list, view);
  }
  body.querySelectorAll('[data-sx]').forEach((el) => { el.onclick = () => openSurgeryDetail(el.dataset.sx); });
}

function weekList(list, from) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  return days.map((d) => {
    const items = list.filter((s) => s.date === d);
    const label = new Date(d + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' });
    return `<section class="panel"><h3>${esc(label)}</h3>
      ${items.length ? `<div class="table-wrap"><table class="list"><thead><tr><th>Horário</th><th>Paciente</th><th>Atendimento</th><th>Médico(a)</th><th>Sala</th><th>Situação</th></tr></thead><tbody>
      ${items.map((s) => `<tr class="clickable" data-sx="${esc(s.id)}">
        <td><strong>${esc(s.startTime)}</strong>–${esc(endTime(s.startTime, s.durationMin))}</td>
        <td>${esc(s.patientName)}${s.patientAllergies ? ' <span class="chip emergencia">Alergia</span>' : ''}</td>
        <td><span class="chip">${esc(state.meta.types[s.type])}</span> ${esc(s.procedureName)}${s.type === 'cirurgia' ? ` <span class="chip">${esc(state.meta.laterality[s.laterality])}</span>` : ''}</td>
        <td>${esc(s.surgeonName)}</td>
        <td>${s.roomId ? esc(s.roomName) : '<span class="muted">—</span>'}</td>
        <td><span class="chip ${esc(s.status)}">${esc(state.meta.status[s.status])}</span>${s.charge ? `<br><span class="small">${esc(fmtMoney(s.charge.amountCents))} · ${esc(state.meta.chargeStatus[s.charge.status])}</span>` : ''}${s.missingDocs.length && OPEN_STATUSES.includes(s.status) ? '<br><span class="small" style="color:var(--warn)">Termos pendentes</span>' : ''}</td>
      </tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nenhum atendimento.</p>'}</section>`;
  }).join('');
}

function renderBoard(body, date, cols, colOf, prefill, list, view) {
  const toMin = (s) => {
    const [h, m] = s.startTime.split(':').map(Number);
    return (s.date === date ? 0 : -1440) + h * 60 + m;
  };
  const visible = list.filter((s) => { const st = toMin(s); return st < 1440 && st + s.durationMin > 0; });

  body.innerHTML = `
    <div class="safety-legend no-print" style="margin-bottom:10px">
      <span>Clique num horário vazio para agendar.</span>
      <span><span class="chip emergencia">Alergia</span> paciente com alergia registrada</span>
      <span><span class="bar"><i></i><i></i><i></i></span> checklist da cirurgia: Entrada, Pausa e Saída</span>
    </div>
    <div class="board" id="board"></div>`;
  const board = $('#board');
  board.style.gridTemplateColumns = `64px repeat(${cols.length}, minmax(190px, 1fr))`;

  const corner = document.createElement('div'); corner.className = 'corner'; board.appendChild(corner);
  cols.forEach((c) => {
    const h = document.createElement('div'); h.className = 'room-h';
    h.textContent = c.name;
    if (c.color) h.style.borderTop = `4px solid ${c.color}`;
    board.appendChild(h);
  });
  const times = document.createElement('div'); times.className = 'times';
  for (let i = 0; i < 1440 / SLOT_MIN; i++) {
    const t = document.createElement('div'); t.className = 'time';
    if (i % 2 === 0 && i > 0) t.textContent = `${pad(i / 2)}:00`;
    times.appendChild(t);
  }
  board.appendChild(times);

  const nowMin = date === todayStr() ? new Date().getHours() * 60 + new Date().getMinutes() : null;
  cols.forEach((c) => {
    const col = document.createElement('div'); col.className = 'col';
    for (let i = 0; i < 1440 / SLOT_MIN; i++) {
      const slot = document.createElement('div');
      slot.className = 'slot' + (i % 2 === 0 ? ' hour' : '');
      const t = `${pad(Math.floor((i * SLOT_MIN) / 60))}:${pad((i * SLOT_MIN) % 60)}`;
      slot.title = `${c.name} — ${t}`;
      const allowed = can('surgeries:write') && !c.inactive && (view !== 'medico' || !myPro() || c.id === myPro());
      if (allowed) slot.onclick = () => openSurgeryForm({ date, startTime: t, ...prefill(c) });
      col.appendChild(slot);
    }
    if (nowMin !== null) {
      const n = document.createElement('div'); n.className = 'now'; n.style.top = `${(nowMin / SLOT_MIN) * SLOT_PX}px`; col.appendChild(n);
    }
    // Distribui em faixas os atendimentos que se sobrepõem
    const items = visible.filter((s) => colOf(s) === c.id).sort((a, b) => toMin(a) - toMin(b));
    const lanes = [];
    const placed = items.map((s) => {
      const st = toMin(s); const en = st + s.durationMin;
      let lane = lanes.findIndex((end) => end <= st);
      if (lane === -1) { lanes.push(en); lane = lanes.length - 1; } else lanes[lane] = en;
      return { s, st, en, lane };
    });
    placed.forEach(({ s, st, en, lane }) => {
      const top = Math.max(st, 0); const bottom = Math.min(en, 1440);
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `sx ${s.status}`;
      el.dataset.sx = s.id;
      el.style.top = `${(top / SLOT_MIN) * SLOT_PX + 1}px`;
      el.style.height = `${Math.max(((bottom - top) / SLOT_MIN) * SLOT_PX - 3, 34)}px`;
      if (lanes.length > 1) {
        el.style.left = `calc(${(lane / lanes.length) * 100}% + 3px)`;
        el.style.right = 'auto';
        el.style.width = `calc(${100 / lanes.length}% - 6px)`;
      }
      if (s.surgeonColor) el.style.borderLeftColor = s.surgeonColor;
      const done = new Set(s.checklistDone);
      const isCir = s.type === 'cirurgia';
      const where = view === 'sala' ? s.surgeonName : (s.roomId ? s.roomName : '');
      el.innerHTML = `
        <div class="p"><span class="t">${esc(s.startTime)}</span> ${esc(s.patientName)} ${s.priority !== 'eletiva' ? `<span class="chip ${esc(s.priority)}">${esc(state.meta.priority[s.priority])}</span>` : ''}</div>
        <div>${isCir ? '<span class="side">Cirurgia</span> ' : ''}${esc(s.procedureName)} ${isCir ? `<span class="side">${esc(state.meta.laterality[s.laterality])}</span>` : ''} ${s.patientAllergies ? '<span class="alg">Alergia</span>' : ''}</div>
        <div class="muted">até ${esc(endTime(s.startTime, s.durationMin))}${where ? ` · ${esc(where)}` : ''} · ${esc(state.meta.status[s.status])}${s.charge && s.charge.status === 'pago' ? ' · Pago' : ''}</div>
        ${isCir ? `<div class="safety" aria-label="Checklist: ${done.size} de 3 etapas concluídas"><i class="${done.has('entrada') ? 'done' : ''}"></i><i class="${done.has('pausa') ? 'done' : ''}"></i><i class="${done.has('saida') ? 'done' : ''}"></i></div>` : ''}`;
      el.setAttribute('aria-label', `${s.startTime} ${s.patientName}, ${s.procedureName}, ${state.meta.status[s.status]}`);
      col.appendChild(el);
    });
    board.appendChild(col);
  });
  // Rola até o primeiro atendimento do dia; sem atendimentos, até o horário atual (hoje) ou 07:00
  const firstStart = visible.length ? Math.max(Math.min(...visible.map(toMin)), 0) : null;
  const target = firstStart !== null ? Math.max(firstStart - 30, 0) : nowMin !== null ? Math.max(nowMin - 90, 0) : 7 * 60;
  board.scrollTop = (target / SLOT_MIN) * SLOT_PX;
}

/** Procedimentos agrupados por especialidade (optgroup), em ordem alfabética dentro de cada grupo. */
function procGroups(procs, selected) {
  const groups = new Map();
  for (const p of procs.filter((x) => x.active || x.id === selected)) {
    const g = p.category || 'Outros';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }
  return [...groups.entries()].map(([g, list]) => `<optgroup label="${esc(g)}">${list.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')).map((p) =>
    `<option value="${esc(p.id)}"${p.id === selected ? ' selected' : ''}>${esc(p.name)}${p.code ? ` (${esc(p.code)})` : ''}${p.priceCents ? ` — ${esc(fmtMoney(p.priceCents))}` : ''}</option>`).join('')}</optgroup>`).join('');
}

// =====================================================================
// Formulário de agendamento (consulta ou cirurgia)
// =====================================================================
export async function openSurgeryForm(prefill = {}, existing = null) {
  const { rooms, pros, procs } = await catalogs();
  const activeRooms = rooms.filter((r) => r.active || (existing && r.id === existing.roomId));
  const used = existing ? [existing.surgeonId, existing.anesthetistId, ...(existing.teamIds || [])] : [];
  const activePros = pros.filter((p) => p.active || used.includes(p.id));
  if (!activePros.length) {
    toast('Cadastre pelo menos um médico antes de agendar.', 'error');
    return;
  }
  const mine = myPro();
  // Clínica com um só médico: ele já vem selecionado
  const doctors = activePros.filter((p) => ['medico', 'cirurgiao'].includes(p.role));
  const onlyDoctor = doctors.length === 1 ? doctors[0].id : '';
  const v = existing || {
    type: prefill.type || 'consulta',
    date: prefill.date || todayStr(), startTime: prefill.startTime || '08:00', roomId: prefill.roomId || '',
    durationMin: 30, laterality: '', anesthesiaType: '', priority: 'eletiva', coverage: 'particular',
    teamIds: [], patientId: prefill.patientId || '', surgeonId: mine || prefill.surgeonId || onlyDoctor,
    priceCents: null, chargeMethod: 'pix',
  };
  const M = state.meta;
  const showFinance = can('finance:write');
  const byRole = (roles) => [...activePros].sort((a, b) => (roles.includes(b.role) - roles.includes(a.role)) || a.name.localeCompare(b.name, 'pt-BR'));
  const proOpts = (roles, sel, empty) => `<option value="">${esc(empty)}</option>` + byRole(roles).map((p) =>
    `<option value="${esc(p.id)}"${p.id === sel ? ' selected' : ''}>${esc(p.name)} — ${esc(M.professionalRoles[p.role])}</option>`).join('');
  // Médico e funcionário só agendam para o próprio médico
  const doctorSelect = mine
    ? `<select name="surgeonId" id="surgeonId">${activePros.filter((p) => p.id === mine).map((p) => `<option value="${esc(p.id)}" selected>${esc(p.name)}</option>`).join('')}</select>`
    : `<select name="surgeonId" id="surgeonId">${proOpts(['medico', 'cirurgiao'], v.surgeonId, 'Selecione…')}</select>`;
  const label = (t) => (t === 'cirurgia' ? 'cirurgia' : 'consulta');

  const m = modal({
    title: existing ? `Editar ${label(v.type)}` : 'Novo agendamento',
    wide: true,
    body: `
    <div id="sxForm" class="form">
      <div class="field s6"><label class="req">Tipo de atendimento</label>
        <div class="toolbar" role="radiogroup">
          ${Object.entries(M.types).map(([k, l]) => `<label class="check btn" style="font-weight:600"><input type="radio" name="type" value="${k}"${v.type === k ? ' checked' : ''}${existing && existing.checklistDone && existing.checklistDone.length ? ' disabled' : ''}> ${esc(l)}</label>`).join('')}
        </div>
        <span class="hint cir">Cirurgia exige sala, lado, anestesia, termos assinados e o checklist de segurança antes de começar.</span></div>

      <div class="fieldset-title">Paciente</div>
      <div class="field s6">
        <label class="req">Paciente</label>
        <input type="hidden" name="patientId" value="${esc(v.patientId)}">
        <div id="patientBox"></div>
      </div>

      <div class="fieldset-title">Médico e horário</div>
      <div class="field s2"><label class="req" for="surgeonId">Médico(a) responsável</label>${doctorSelect}</div>
      <div class="field s1"><label class="req" for="date">Data</label><input type="date" name="date" id="date" value="${esc(v.date)}"></div>
      <div class="field s1"><label class="req" for="startTime">Início</label><input type="time" name="startTime" id="startTime" value="${esc(v.startTime)}"></div>
      <div class="field s1"><label class="req" for="durationMin">Duração (min)</label><input type="number" name="durationMin" id="durationMin" min="10" max="1440" step="5" value="${esc(v.durationMin)}"></div>
      <div class="field s1"><label>Término</label><input id="endPreview" disabled></div>
      <div class="field s2"><label id="roomLabel" for="roomId">Sala / consultório</label>
        <select name="roomId" id="roomId"><option value="">Sem sala definida</option>${activeRooms.map((r) => `<option value="${esc(r.id)}"${r.id === v.roomId ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div>
      <div class="field s2"><label class="req" for="priority">Prioridade</label>
        <select name="priority" id="priority">${options(M.priority, v.priority)}</select></div>
      <div class="field s2"><label>&nbsp;</label><button class="btn" type="button" id="suggestBtn">Sugerir horários livres</button></div>
      <div class="field s6 hidden" id="suggestBox"></div>
      <div class="field s6" id="timeWarn"></div>

      <div class="fieldset-title" id="procTitle">Atendimento</div>
      <div class="field">
        <label for="procedureId">Procedimento (${procs.filter((p) => p.active).length} disponíveis)</label>
        <input id="procFilter" placeholder="Filtrar: canal, implante, limpeza…" autocomplete="off" style="margin-bottom:6px">
        <select name="procedureId" id="procedureId">
          <option value="">Outro (digitar ao lado)</option>
          ${procGroups(procs, v.procedureId)}
        </select>
      </div>
      <div class="field"><label class="req" for="procedureName">Motivo / procedimento</label><input name="procedureName" id="procedureName" maxlength="300" value="${esc(v.procedureName || '')}" placeholder="Ex.: Consulta de rotina, Retorno, Avaliação"></div>
      <div class="field s3 cir"><label class="req" for="laterality">Lateralidade</label>
        <select name="laterality" id="laterality">${options(M.laterality, v.laterality, 'Selecione…')}</select>
        <span class="hint" id="latHint">Confirme o lado com o paciente e o pedido médico.</span></div>
      <div class="field s3 cir"><label class="req" for="anesthesiaType">Anestesia</label>
        <select name="anesthesiaType" id="anesthesiaType">${options(M.anesthesia, v.anesthesiaType, 'Selecione…')}</select></div>

      <div class="fieldset-title cir">Equipe da cirurgia</div>
      <div class="field cir"><label id="anLabel" for="anesthetistId">Anestesista</label><select name="anesthetistId" id="anesthetistId">${proOpts(['anestesista'], v.anesthetistId, 'Sem anestesista')}</select></div>
      <div class="field cir"></div>
      <div class="field s6 cir"><label>Demais membros da equipe</label>
        <div class="team-box">${activePros.map((p) => `<label class="check"><input type="checkbox" data-multi="teamIds" value="${esc(p.id)}"${(v.teamIds || []).includes(p.id) ? ' checked' : ''}> ${esc(p.name)} <span class="muted small">${esc(M.professionalRoles[p.role])}</span></label>`).join('')}</div>
        <span class="hint">O médico responsável e o anestesista já fazem parte da equipe.</span></div>
      <div class="field s6" id="conflicts"></div>

      <div class="fieldset-title">Convênio${showFinance ? ' e cobrança' : ''}</div>
      <div class="field s2"><label class="req" for="coverage">Atendimento</label>
        <select name="coverage" id="coverage">${options({ particular: 'Particular', convenio: 'Convênio' }, v.coverage)}</select></div>
      <div class="field s2 cv"><label class="req" for="insurer">Convênio</label><input name="insurer" id="insurer" value="${esc(v.insurer || '')}"></div>
      <div class="field s2 cv"><label for="authorizationNumber">Nº autorização / guia</label><input name="authorizationNumber" id="authorizationNumber" value="${esc(v.authorizationNumber || '')}"></div>
      ${showFinance ? `
      <div class="field s2"><label for="priceInput">Valor (R$)</label><input id="priceInput" inputmode="decimal" placeholder="0,00" value="${esc(moneyInput(v.priceCents))}">
        <span class="hint">Cria a cobrança no Financeiro. Em branco: sem cobrança.</span></div>
      <div class="field s2"><label for="chargeMethod">Forma de cobrança</label><select name="chargeMethod" id="chargeMethod">${options(M.paymentMethods, v.chargeMethod || (existing && existing.charge && existing.charge.method) || 'pix')}</select></div>
      <div class="field s2" id="instBox"><label for="installments">Parcelas</label><select name="installments" id="installments">${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}"${(v.installments || 1) === i + 1 ? ' selected' : ''}>${i + 1}x</option>`).join('')}</select></div>
      ${existing && existing.charge && existing.charge.paidCents > 0 ? `<div class="field s6"><div class="alert info small">Já foram pagos ${esc(fmtMoney(existing.charge.paidCents))}. Para mudar o valor, use o Financeiro.</div></div>` : ''}` : ''}

      <div class="fieldset-title cir">Reservas e materiais</div>
      <div class="field s3 cir"><label class="check"><input type="checkbox" name="needsIcu"${v.needsIcu ? ' checked' : ''}> Reservar leito de UTI</label></div>
      <div class="field s3 cir"><label class="check"><input type="checkbox" name="needsBloodReserve"${v.needsBloodReserve ? ' checked' : ''}> Reservar hemocomponentes (exige termo de hemotransfusão)</label></div>
      <div class="field s6 cir"><label for="materials">Materiais especiais / OPME</label><textarea name="materials" id="materials">${esc(v.materials || '')}</textarea></div>

      <div class="fieldset-title">Orientações e observações</div>
      <div class="field"><label for="preOpNotes">Orientações para o paciente</label><textarea name="preOpNotes" id="preOpNotes" placeholder="Ex.: trazer exames, jejum, suspender medicamentos">${esc(v.preOpNotes || '')}</textarea>
        <span class="hint">Este texto vai para o paciente nos e-mails de aviso e lembrete.</span></div>
      <div class="field"><label for="notes">Observações internas</label><textarea name="notes" id="notes">${esc(v.notes || '')}</textarea>
        <span class="hint">Não são enviadas ao paciente.</span></div>
      <div class="field s6 hidden" id="overrideBox">
        <div class="alert danger"><label class="check"><input type="checkbox" name="overrideConflicts"> Manter o agendamento mesmo com conflito (somente emergência)</label>
        <div class="field" style="margin-top:8px"><label class="req" for="overrideReason">Justificativa clínica</label><textarea name="overrideReason" id="overrideReason" maxlength="1000"></textarea></div></div>
      </div>
      <div class="field s6" id="formErr"></div>
    </div>`,
    foot: `<button class="btn" data-cancel>Cancelar</button><button class="btn primary" data-save>${existing ? 'Salvar alterações' : 'Agendar'}</button>`,
  });
  const f = m.el.querySelector('#sxForm');
  m.el.querySelector('[data-cancel]').onclick = m.close;
  let checkTimer; // declarado antes de qualquer uso (evita erro ao abrir com paciente já escolhido)

  // ---- Paciente (busca com sugestões) ----
  const pidInput = f.querySelector('[name=patientId]');
  const box = f.querySelector('#patientBox');
  const renderSelected = (p) => {
    pidInput.value = p.id;
    box.innerHTML = `
      <div class="panel" style="padding:12px">
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <div><strong>${esc(p.name)}</strong>${p.socialName ? ` <span class="muted">(nome social: ${esc(p.socialName)})</span>` : ''}<br>
          <span class="muted small">${esc(fmtDate(p.birthDate))} · ${esc(age(p.birthDate))}${p.cpf ? ` · CPF ${esc(fmtCpf(p.cpf))}` : ''}${p.motherName ? ` · Mãe: ${esc(p.motherName)}` : ''}</span></div>
          ${existing && existing.checklistDone.length ? '' : '<button class="btn sm" type="button" id="swapPatient">Trocar paciente</button>'}
        </div>
        ${p.noKnownAllergies ? '<div class="allergy none" style="margin-top:8px">Nega alergias</div>' : `<div class="allergy" style="margin-top:8px">Alergias: ${esc(p.allergies)}</div>`}
      </div>`;
    const sw = box.querySelector('#swapPatient'); if (sw) sw.onclick = renderSearch;
    scheduleCheck();
  };
  const renderSearch = () => {
    pidInput.value = '';
    box.innerHTML = `
      <div class="typeahead">
        <div style="display:flex;gap:8px">
          <input id="pq" placeholder="Digite nome ou CPF do paciente" autocomplete="off" aria-label="Buscar paciente">
          ${can('patients:write') ? '<button class="btn" type="button" id="newPatient">Novo paciente</button>' : ''}
        </div>
        <div class="results hidden" id="pres" role="listbox"></div>
      </div>`;
    const q = box.querySelector('#pq'); const res = box.querySelector('#pres');
    let timer;
    q.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const term = q.value.trim();
        if (term.length < 2) { res.classList.add('hidden'); return; }
        const list = (await api('GET', `/api/patients?q=${encodeURIComponent(term)}`)).filter((p) => p.active !== false).slice(0, 20);
        res.innerHTML = list.length ? list.map((p) => `<button type="button" data-pid="${esc(p.id)}"><strong>${esc(p.name)}</strong> <span class="muted small">${esc(fmtDate(p.birthDate))}${p.cpf ? ` · CPF ${esc(fmtCpf(p.cpf))}` : ''}</span></button>`).join('')
          : '<div style="padding:10px" class="muted">Nenhum paciente encontrado.</div>';
        res.classList.remove('hidden');
        res.querySelectorAll('[data-pid]').forEach((b) => {
          b.onclick = () => renderSelected(list.find((p) => p.id === b.dataset.pid));
        });
      }, 250);
    };
    q.focus();
    const np = box.querySelector('#newPatient');
    if (np) np.onclick = () => openPatientForm(null, (p) => renderSelected(p));
  };
  if (v.patientId) {
    let pat = null;
    try { pat = await api('GET', `/api/patients/${encodeURIComponent(v.patientId)}`); } catch (e) {
      renderSearch();
      toast(`Não foi possível carregar o paciente: ${e.message}`, 'error');
    }
    if (pat) renderSelected(pat);
  } else renderSearch();

  // ---- Comportamentos do formulário ----
  const sel = (n) => f.querySelector(`[name="${n}"]`);
  const typeNow = () => (f.querySelector('[name=type]:checked') || {}).value || 'consulta';
  const updateType = () => {
    const cir = typeNow() === 'cirurgia';
    f.querySelectorAll('.cir').forEach((el) => el.classList.toggle('hidden', !cir));
    f.querySelector('#roomLabel').classList.toggle('req', cir);
    f.querySelector('#procTitle').textContent = cir ? 'Procedimento cirúrgico' : 'Consulta';
    if (!existing) m.el.querySelector('#mt').textContent = cir ? 'Agendar cirurgia' : 'Agendar consulta';
    m.el.querySelector('[data-save]').textContent = existing ? 'Salvar alterações' : cir ? 'Agendar cirurgia' : 'Agendar consulta';
  };
  f.querySelectorAll('[name=type]').forEach((r) => r.addEventListener('change', () => { updateType(); autoPrice(); }));

  // Valor sugerido: preço do procedimento ou valor de consulta do médico (até o usuário digitar)
  const priceEl = f.querySelector('#priceInput');
  let priceTouched = !!(existing && existing.priceCents);
  if (priceEl) priceEl.addEventListener('input', () => { priceTouched = true; });
  function autoPrice() {
    if (!priceEl || priceTouched) return;
    const proc = procs.find((x) => x.id === sel('procedureId').value);
    const doc = pros.find((x) => x.id === sel('surgeonId').value);
    const cents = (proc && proc.priceCents) || (typeNow() === 'consulta' && doc && doc.consultPriceCents) || null;
    priceEl.value = moneyInput(cents);
  }
  sel('surgeonId').addEventListener('change', autoPrice);
  const instBox = f.querySelector('#instBox');
  const updateInst = () => { if (instBox) instBox.classList.toggle('hidden', sel('chargeMethod').value !== 'cartao_credito'); };
  if (instBox) { sel('chargeMethod').onchange = updateInst; updateInst(); }

  const procSel = sel('procedureId');
  // Filtro: mostra só os procedimentos que contêm o texto digitado
  const filt = f.querySelector('#procFilter');
  const norm = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  filt.oninput = () => {
    const q = norm(filt.value.trim());
    procSel.querySelectorAll('option[value]:not([value=""])').forEach((o) => { o.hidden = !!q && !norm(o.textContent).includes(q); });
    procSel.querySelectorAll('optgroup').forEach((g) => { g.hidden = !!q && ![...g.children].some((o) => !o.hidden); });
    const first = procSel.querySelector('option[value]:not([value=""]):not([hidden])');
    if (q && first && procSel.selectedOptions[0] && procSel.selectedOptions[0].hidden) procSel.value = '';
    if (q && first) procSel.size = Math.min(8, procSel.querySelectorAll('option:not([hidden]), optgroup:not([hidden])').length); else procSel.size = 0;
  };
  procSel.addEventListener('change', () => { procSel.size = 0; });
  procSel.onchange = () => {
    const p = procs.find((x) => x.id === procSel.value);
    procSel.size = 0;
    if (p) {
      sel('procedureName').value = p.name;
      if (p.defaultDurationMin) sel('durationMin').value = p.defaultDurationMin;
      // Cirurgia oral, implantes etc. já marcam o tipo "Cirurgia"
      if (!existing && p.kind && f.querySelector(`[name=type][value=${p.kind}]`)) { f.querySelector(`[name=type][value=${p.kind}]`).checked = true; updateType(); }
      updateEnd(); scheduleCheck();
    }
    updateLat(); autoPrice();
  };
  const updateLat = () => {
    const p = procs.find((x) => x.id === procSel.value);
    f.querySelector('#latHint').textContent = p && p.requiresLaterality
      ? 'Este procedimento exige indicar o lado (direito, esquerdo ou bilateral).'
      : 'Confirme o lado com o paciente e o pedido médico.';
  };
  updateLat();
  const updateAnest = () => {
    const need = M.needsAnesthetist.includes(sel('anesthesiaType').value);
    f.querySelector('#anLabel').classList.toggle('req', need);
  };
  sel('anesthesiaType').onchange = updateAnest; updateAnest();
  const updateCov = () => f.querySelectorAll('.cv').forEach((el) => el.classList.toggle('hidden', sel('coverage').value !== 'convenio'));
  sel('coverage').onchange = updateCov; updateCov();
  const updateEnd = () => {
    const st = sel('startTime').value; const d = Number(sel('durationMin').value);
    f.querySelector('#endPreview').value = st && d > 0 ? endTime(st, d) : '';
    const warn = f.querySelector('#timeWarn');
    const now = new Date();
    const nowStr = `${todayStr()}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    warn.innerHTML = sel('date').value && st && `${sel('date').value}T${st}` < nowStr && !existing
      ? '<div class="alert warn">Atenção: data e horário já passaram. Confira se está correto.</div>' : '';
  };
  ['startTime', 'durationMin', 'date'].forEach((n) => sel(n).addEventListener('input', updateEnd));
  updateEnd();
  updateType();
  if (!existing) autoPrice();

  // ---- Agenda inteligente: próximos horários livres do médico ----
  f.querySelector('#suggestBtn').onclick = async () => {
    const box = f.querySelector('#suggestBox');
    const d = readForm(f);
    if (!d.surgeonId) { box.classList.remove('hidden'); box.innerHTML = '<div class="alert warn" style="margin:0">Escolha o médico primeiro.</div>'; return; }
    box.classList.remove('hidden'); box.innerHTML = '<span class="muted small">Procurando horários…</span>';
    try {
      const q = new URLSearchParams({ professionalId: d.surgeonId, durationMin: String(d.durationMin || 30), from: d.date || todayStr(), days: '21', limit: '16', type: typeNow() });
      if (d.roomId) q.set('roomId', d.roomId);
      if (d.patientId) q.set('patientId', d.patientId);
      if (existing) q.set('excludeId', existing.id);
      const r = await api('GET', `/api/schedule/suggest?${q}`);
      const wd = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
      box.innerHTML = r.slots.length
        ? `<span class="small"><strong>Horários livres</strong>${r.usesDefaultHours ? ' (expediente padrão: seg a sex, 8h–12h e 13h–18h; ajuste em Salas e equipe)' : ''}:</span>
           <div class="slots">${r.slots.map((x) => `<button type="button" data-d="${x.date}" data-t="${x.startTime}">${wd[x.weekday]} ${esc(fmtDate(x.date).slice(0, 5))} ${esc(x.startTime)}</button>`).join('')}</div>`
        : '<div class="alert warn" style="margin:0">Nenhum horário livre nas próximas 3 semanas dentro do expediente.</div>';
      box.querySelectorAll('[data-d]').forEach((b) => {
        b.onclick = () => { sel('date').value = b.dataset.d; sel('startTime').value = b.dataset.t; updateEnd(); scheduleCheck(); box.classList.add('hidden'); };
      });
    } catch (e) { box.innerHTML = `<div class="alert danger" style="margin:0">${esc(e.message)}</div>`; }
  };

  // ---- Verificação de conflitos em tempo real ----
  function scheduleCheck() { clearTimeout(checkTimer); checkTimer = setTimeout(runCheck, 400); }
  async function runCheck() {
    const d = readForm(f);
    const out = f.querySelector('#conflicts');
    if (!d.date || !d.startTime || !(d.durationMin >= 10)) { out.innerHTML = ''; return; }
    try {
      const r = await api('POST', '/api/surgeries/check', {
        id: existing ? existing.id : null, type: d.type || 'consulta', patientId: d.patientId || null, roomId: d.roomId || null,
        surgeonId: d.surgeonId || null, anesthetistId: d.anesthetistId || null, teamIds: d.teamIds || [],
        date: d.date, startTime: d.startTime, durationMin: d.durationMin,
      });
      out.innerHTML = r.conflicts.length
        ? `<div class="alert danger"><strong>Conflitos encontrados:</strong><ul>${r.conflicts.map((c) => `<li>${esc(c.message)}</li>`).join('')}</ul></div>`
        : (d.surgeonId ? `<div class="alert ok">${d.roomId ? 'Sala e médico livres' : 'Médico livre'} neste horário.</div>` : '');
    } catch { out.innerHTML = ''; }
  }
  f.addEventListener('change', (e) => { if (e.target.name !== 'overrideReason') scheduleCheck(); });
  scheduleCheck();

  // ---- Salvar ----
  const saveBtn = m.el.querySelector('[data-save]');
  saveBtn.onclick = async () => {
    const d = readForm(f);
    const errBox = f.querySelector('#formErr');
    if (!d.patientId) { showErrors(f, { message: 'Selecione o paciente.', fields: { patientId: 'Selecione o paciente.' } }, errBox); return; }
    const cir = typeNow() === 'cirurgia';
    const payload = {
      ...d,
      type: typeNow(),
      procedureId: d.procedureId || null, roomId: d.roomId || null,
      anesthetistId: cir ? d.anesthetistId || null : null,
      teamIds: cir ? d.teamIds || [] : [],
      laterality: cir ? d.laterality : null, anesthesiaType: cir ? d.anesthesiaType : null,
      installments: d.installments ? Number(d.installments) : 1,
    };
    if (priceEl) {
      const cents = parseMoney(priceEl.value);
      if (Number.isNaN(cents)) {
        showErrors(f, { message: 'Valor inválido. Use o formato 150,00.', fields: {} }, errBox);
        priceEl.closest('.field').classList.add('invalid'); priceEl.focus(); return;
      }
      payload.priceCents = cents;
    }
    saveBtn.disabled = true;
    try {
      const saved = existing
        ? await api('PUT', `/api/surgeries/${encodeURIComponent(existing.id)}`, payload)
        : await api('POST', '/api/surgeries', payload);
      m.close();
      toast(existing ? 'Agendamento atualizado.' : `${cir ? 'Cirurgia' : 'Consulta'} agendada.`);
      notifyChange();
      if (!existing) openSurgeryDetail(saved.id);
    } catch (e) {
      if (e.conflicts) {
        f.querySelector('#conflicts').innerHTML = `<div class="alert danger"><strong>${esc(e.message)}</strong><ul>${e.conflicts.map((c) => `<li>${esc(c.message)}</li>`).join('')}</ul></div>`;
        f.querySelector('#overrideBox').classList.toggle('hidden', !e.overridable);
        errBox.innerHTML = '';
        f.querySelector('#conflicts').scrollIntoView({ block: 'center' });
      } else showErrors(f, e, errBox);
    } finally { saveBtn.disabled = false; }
  };
}

/** Link do WhatsApp com a mensagem de lembrete pronta (funciona sem a API do WhatsApp). */
function waReminder(s, patient) {
  const d = String(patient.phone || '').replace(/\D/g, '');
  if (d.length < 10 || !['agendada', 'confirmada'].includes(s.status)) return null;
  const first = (patient.socialName || patient.name).split(' ')[0];
  const link = s.confirmToken ? `\nConfirme ou cancele aqui: ${location.origin}/confirmar.html?t=${encodeURIComponent(s.confirmToken)}` : '';
  const text = `Olá, ${first}! Lembramos do seu atendimento em ${fmtDate(s.date)} às ${s.startTime} com ${s.surgeonName} na ${state.meta.clinicName}.${link}`;
  return `https://wa.me/${d.length <= 11 ? '55' + d : d}?text=${encodeURIComponent(text)}`;
}

// =====================================================================
// Detalhe do atendimento (consulta ou cirurgia)
// =====================================================================
const actionLabel = (next, s) => {
  const w = s.type === 'cirurgia' ? 'cirurgia' : 'consulta';
  return {
    confirmada: `Confirmar ${w}`, em_andamento: s.type === 'cirurgia' ? 'Iniciar cirurgia' : 'Iniciar atendimento',
    concluida: s.type === 'cirurgia' ? 'Concluir cirurgia' : 'Concluir atendimento',
    adiada: 'Adiar', cancelada: `Cancelar ${w}`, faltou: 'Paciente faltou',
    agendada: s.status === 'adiada' ? 'Reagendar' : 'Voltar para agendada',
  }[next];
};

export async function openSurgeryDetail(id) {
  const m = modal({ title: 'Atendimento', wide: true, body: '<p class="muted">Carregando…</p>' });
  const load = async () => {
    let s; let sigs; let patient; let emails = [];
    try {
      [s, sigs] = await Promise.all([
        api('GET', `/api/surgeries/${encodeURIComponent(id)}`),
        api('GET', `/api/signatures?surgeryId=${encodeURIComponent(id)}`),
      ]);
      patient = await api('GET', `/api/patients/${encodeURIComponent(s.patientId)}`);
      emails = await api('GET', `/api/emails?surgeryId=${encodeURIComponent(id)}`).catch(() => []);
    } catch (e) {
      m.el.querySelector('.modal-body').innerHTML = `<div class="alert danger">${esc(e.message)}</div>`;
      return;
    }
    renderDetail(m, s, sigs, patient, load, emails);
  };
  await load();
}

function renderDetail(m, s, sigs, patient, reload, emails = []) {
  const M = state.meta;
  const open = OPEN_STATUSES.includes(s.status);
  const isCir = s.type === 'cirurgia';
  m.el.querySelector('#mt').textContent = `${M.types[s.type]}: ${s.procedureName}`;

  // Médico/funcionário só gerenciam atendimentos do próprio médico (médico da equipe pode atuar na cirurgia)
  const mine = myPro();
  const own = !mine || s.surgeonId === mine;
  const inTeam = !mine || [s.surgeonId, s.anesthetistId, ...(s.teamIds || [])].includes(mine);
  const actions = (M.transitions[s.status] || []).filter((next) => {
    const clinical = ['em_andamento', 'concluida'].includes(next);
    if (clinical) return (isCir ? can('surgeries:clinical') : can('surgeries:clinical') || can('surgeries:write')) && (isCir ? inTeam : own);
    return can('surgeries:write') && own;
  });
  const actionBtn = (next) => {
    const cls = next === 'cancelada' ? 'danger' : next === 'em_andamento' || next === 'concluida' ? 'ok' : next === 'confirmada' ? 'primary' : '';
    return `<button class="btn ${cls}" data-status="${esc(next)}">${esc(actionLabel(next, s))}</button>`;
  };

  const validSig = (x) => x.patientId === s.patientId && (!s.patientChangedAt || x.signedAt > s.patientChangedAt);
  const docsHtml = s.requiredDocs.map((dt) => {
    const done = sigs.filter((x) => x.docType === dt && ['paciente', 'responsavel'].includes(x.signerRole) && validSig(x));
    return `<div class="doc-row ${done.length ? 'signed' : 'pending'}">
      <div><strong>${esc(M.docTypes[dt])}</strong><br>
      ${done.length ? done.map((x) => `<span class="small">Assinado por ${esc(x.signerName)} (${esc(M.signerRoles[x.signerRole])}) em ${esc(fmtDateTime(x.signedAt))} — <a href="#" data-viewsig="${esc(x.id)}">ver documento</a></span>`).join('<br>') : '<span class="small">Pendente — obrigatório para iniciar a cirurgia</span>'}</div>
      ${!done.length && open && can('signatures:create') ? `<button class="btn primary sm" data-sign="${esc(dt)}">Coletar assinatura</button>` : ''}
    </div>`;
  }).join('');
  const extra = sigs.filter((x) => !(s.requiredDocs.includes(x.docType) && ['paciente', 'responsavel'].includes(x.signerRole) && validSig(x)));

  const phaseHtml = (phase, idx) => {
    const def = M.checklist[phase];
    const cur = s.checklist[phase];
    const prevDone = idx === 0 || !!s.checklist[['entrada', 'pausa', 'saida'][idx - 1]].completedAt;
    const statusOk = phase === 'entrada' ? s.status === 'confirmada' : s.status === 'em_andamento';
    const editable = !cur.completedAt && prevDone && statusOk && can('surgeries:clinical');
    let why = '';
    if (!cur.completedAt && !editable) {
      if (!can('surgeries:clinical')) why = 'Preenchido pela equipe médica ou de enfermagem.';
      else if (!prevDone) why = 'Conclua a etapa anterior primeiro.';
      else if (phase === 'entrada' && s.status === 'agendada') why = 'Confirme a cirurgia para liberar esta etapa.';
      else if (phase !== 'entrada' && s.status === 'confirmada') why = 'Inicie a cirurgia para liberar esta etapa.';
      else why = 'Etapa indisponível na situação atual.';
    }
    return `<div class="phase ${cur.completedAt ? 'done' : ''} ${!editable && !cur.completedAt ? 'locked' : ''}" data-phase="${esc(phase)}">
      <div class="phase-head"><strong>${esc(def.label)}</strong>
        <span class="small">${cur.completedAt ? `Concluída por ${esc(cur.completedByName)} em ${esc(fmtDateTime(cur.completedAt))}` : esc(why)}</span></div>
      <div class="phase-body">
        ${Object.entries(def.items).map(([k, label]) => `<label class="check"><input type="checkbox" data-item="${esc(k)}"${cur.items[k] ? ' checked' : ''}${editable ? '' : ' disabled'}> ${esc(label)}</label>`).join('')}
        ${editable ? `<div class="field s6"><label>Observações da etapa</label><textarea data-notes maxlength="2000">${esc(cur.notes || '')}</textarea></div>
          <div class="toolbar"><button class="btn sm" data-savephase>Salvar progresso</button><button class="btn ok sm" data-completephase>Concluir etapa</button></div>`
          : cur.notes ? `<p class="small"><strong>Observações:</strong> ${esc(cur.notes)}</p>` : ''}
      </div></div>`;
  };

  const body = m.el.querySelector('.modal-body');
  body.innerHTML = `
    <div class="print-only" style="margin-bottom:12px"><img src="/logo.svg" alt="ClinPay" style="width:160px"><br>${esc(M.clinicName)} — Ficha de atendimento</div>
    <div class="page-head" style="margin-bottom:12px">
      <div class="sx-title">
        <h2>${esc(patient.socialName || patient.name)}</h2>
        <span class="muted">${esc(fmtDate(patient.birthDate))} · ${esc(age(patient.birthDate))}${patient.cpf ? ` · CPF ${esc(fmtCpf(patient.cpf))}` : ''}${patient.bloodType ? ` · Tipo sanguíneo ${esc(patient.bloodType)}` : ''}</span>
      </div>
      <div class="toolbar">
        <span class="chip ${esc(s.status)}">${esc(M.status[s.status])}</span>
        ${s.priority !== 'eletiva' ? `<span class="chip ${esc(s.priority)}">${esc(M.priority[s.priority])}</span>` : ''}
      </div>
    </div>
    ${patient.noKnownAllergies ? '<div class="allergy none">Nega alergias</div>' : `<div class="allergy">Alergias: ${esc(patient.allergies)}</div>`}

    <div class="toolbar no-print" style="margin:14px 0">
      ${actions.map(actionBtn).join('')}
      ${open && can('surgeries:write') && own ? '<button class="btn" data-edit>Editar dados</button>' : ''}
      ${waReminder(s, patient) ? `<a class="btn" target="_blank" rel="noopener" href="${esc(waReminder(s, patient))}">Lembrete por WhatsApp</a>` : ''}
      <button class="btn" data-print>${ICONS.print} Imprimir ficha</button>
      <a class="btn ghost" href="#/paciente/${esc(patient.id)}" data-gopatient>Abrir cadastro do paciente</a>
    </div>
    <div id="actErr"></div>

    <div class="grid2">
      <section class="panel">
        <h3 style="margin-bottom:10px">${isCir ? 'Procedimento cirúrgico' : 'Consulta'}</h3>
        <p style="margin:0 0 10px"><strong>${esc(s.procedureName)}</strong> ${isCir ? `<span class="side-big">${esc(M.laterality[s.laterality])}</span>` : ''}</p>
        <dl class="kv">
          <dt>Data e horário</dt><dd>${esc(fmtDate(s.date))}, ${esc(s.startTime)} às ${esc(endTime(s.startTime, s.durationMin))} (${esc(s.durationMin)} min)</dd>
          <dt>Médico(a)</dt><dd>${esc(s.surgeonName)}</dd>
          <dt>Sala</dt><dd>${esc(s.roomName)}</dd>
          ${isCir ? `<dt>Anestesia</dt><dd>${esc(M.anesthesia[s.anesthesiaType])}</dd>
          <dt>Anestesista</dt><dd>${esc(s.anesthetistName || '—')}</dd>
          <dt>Equipe</dt><dd>${s.teamNames.length ? s.teamNames.map(esc).join(', ') : '—'}</dd>
          <dt>Reservas</dt><dd>${[s.needsIcu && 'UTI', s.needsBloodReserve && 'Hemocomponentes'].filter(Boolean).join(', ') || 'Nenhuma'}</dd>` : ''}
          <dt>Atendimento</dt><dd>${s.coverage === 'convenio' ? `Convênio ${esc(s.insurer)}${s.authorizationNumber ? ` — guia ${esc(s.authorizationNumber)}` : ''}` : 'Particular'}</dd>
          ${s.materials && isCir ? `<dt>Materiais / OPME</dt><dd>${esc(s.materials)}</dd>` : ''}
          ${s.preOpNotes ? `<dt>Orientações ao paciente</dt><dd>${esc(s.preOpNotes)}</dd>` : ''}
          ${s.notes ? `<dt>Observações internas</dt><dd>${esc(s.notes)}</dd>` : ''}
        </dl>
        ${patient.comorbidities || patient.medications ? `<h3 style="margin:14px 0 6px">Dados clínicos do cadastro</h3><dl class="kv">
          ${patient.comorbidities ? `<dt>Comorbidades</dt><dd>${esc(patient.comorbidities)}</dd>` : ''}
          ${patient.medications ? `<dt>Medicamentos em uso</dt><dd>${esc(patient.medications)}</dd>` : ''}
          ${patient.weightKg ? `<dt>Peso / altura</dt><dd>${esc(patient.weightKg)} kg${patient.heightCm ? ` / ${esc(patient.heightCm)} cm` : ''}</dd>` : ''}
        </dl>` : ''}
      </section>
      <section class="panel">
        ${s.charge || (can('finance:write') && own) ? `
        <h3 style="margin-bottom:10px">Cobrança</h3>
        ${s.charge ? `<dl class="kv">
          <dt>Valor</dt><dd><strong>${esc(fmtMoney(s.charge.amountCents))}</strong> — ${esc(M.paymentMethods[s.charge.method] || '')}</dd>
          <dt>Recebido</dt><dd>${esc(fmtMoney(s.charge.paidCents))}</dd>
          <dt>Situação</dt><dd><span class="chip ${s.charge.status === 'pago' ? 'concluida' : s.charge.status === 'parcial' ? 'em_andamento' : 'agendada'}">${esc(M.chargeStatus[s.charge.status])}</span></dd>
        </dl>
        <div class="toolbar no-print" style="margin:10px 0 16px">
          ${s.charge.status !== 'pago' && can('finance:write') ? '<button class="btn ok sm" data-pay>Registrar pagamento</button>' : ''}
          <a class="btn sm" href="#/financeiro?charge=${esc(s.charge.id)}" data-gofin>Ver no financeiro</a>
        </div>` : `<p class="muted small">Sem cobrança. ${open ? 'Use "Editar dados" para informar o valor.' : ''}</p>`}` : ''}
        <h3 style="margin-bottom:10px">${isCir ? 'Termos de consentimento' : 'Documentos assinados'}</h3>
        <div class="docs-list">${docsHtml || (isCir ? '' : '<p class="muted small">Consultas não exigem termos. Se precisar, colete uma assinatura abaixo.</p>')}</div>
        ${extra.length ? `<h3 style="margin:14px 0 6px">Outros documentos assinados</h3><ul class="history">${extra.map((x) => `<li>${esc(M.docTypes[x.docType])} — ${esc(x.signerName)} (${esc(M.signerRoles[x.signerRole])}), ${esc(fmtDateTime(x.signedAt))} — <a href="#" data-viewsig="${esc(x.id)}">ver</a></li>`).join('')}</ul>` : ''}
        ${s.status !== 'cancelada' && s.status !== 'concluida' && can('signatures:create') ? `<button class="btn sm no-print" style="margin-top:10px" data-signother>${isCir ? 'Coletar outra assinatura' : 'Coletar assinatura'}</button>` : ''}
      </section>
    </div>

    ${isCir ? `<section class="panel">
      <h3>Checklist de segurança cirúrgica</h3>
      <p class="muted small">Baseado na Lista de Verificação de Segurança Cirúrgica da OMS. Cada etapa concluída fica registrada e não pode ser desfeita.</p>
      ${['entrada', 'pausa', 'saida'].map(phaseHtml).join('')}
    </section>` : ''}

    <section class="panel">
      <h3 style="margin-bottom:8px">Histórico</h3>
      <ul class="history">
        ${(s.statusHistory || []).map((h) => `<li><strong>${esc(M.status[h.status])}</strong> — ${esc(h.byName)}, ${esc(fmtDateTime(h.at))}${h.reason ? ` — Motivo: ${esc(h.reason)}` : ''}</li>`).join('')}
        ${(s.conflictOverrides || []).map((o) => `<li class="small" style="color:var(--danger)"><strong>Conflito mantido em emergência</strong> por ${esc(o.byName)} em ${esc(fmtDateTime(o.at))}: ${esc(o.reason)}<br>${o.conflicts.map(esc).join('<br>')}</li>`).join('')}
      </ul>
      <p class="small muted">Agendado por ${esc(s.createdByName || '')} em ${esc(fmtDateTime(s.createdAt))}.</p>
    </section>

    <section class="panel no-print">
      <h3 style="margin-bottom:8px">Avisos por e-mail</h3>
      ${emails.length ? `<ul class="history">${emails.map((e) => `<li><strong>${esc(e.kindLabel)}</strong> para ${esc(e.toName || e.to)} (${esc(e.audience)}) — ${e.status === 'enviado' ? `enviado em ${esc(fmtDateTime(e.sentAt))}`
        : e.status === 'falhou' ? `<span style="color:var(--danger)">não enviado: ${esc(e.lastError)}</span>` : `aguardando envio${e.lastError ? ` (nova tentativa; erro: ${esc(e.lastError)})` : ''}`}</li>`).join('')}</ul>`
        : `<p class="muted small">Nenhum aviso enviado. ${patient.emailReminders ? '' : 'O paciente não autorizou receber e-mails ou não tem e-mail cadastrado.'}</p>`}
    </section>`;

  const errBox = body.querySelector('#actErr');
  const fail = (e) => { errBox.innerHTML = `<div class="alert danger">${esc(e.message)}${e.conflicts ? `<ul>${e.conflicts.map((c) => `<li>${esc(c.message)}</li>`).join('')}</ul>` : ''}</div>`; errBox.scrollIntoView({ block: 'nearest' }); };
  const after = async (msg) => { toast(msg); notifyChange(); await reload(); };

  body.querySelectorAll('[data-status]').forEach((b) => {
    b.onclick = async () => {
      const next = b.dataset.status;
      let reason = null;
      if (next === 'cancelada' || next === 'adiada') {
        reason = await promptDialog(actionLabel(next, s), `Motivo${next === 'cancelada' && s.charge && s.charge.paidCents === 0 ? ' (a cobrança sem pagamento também será cancelada)' : ''}`, { okLabel: actionLabel(next, s) });
        if (!reason) return;
      } else if (next === 'faltou') {
        if (!(await confirmDialog(`Registrar que ${patient.name} faltou? A cobrança, se houver, continua em aberto no Financeiro.`, { okLabel: 'Paciente faltou' }))) return;
      } else if (next === 'em_andamento') {
        const msg = isCir ? `Iniciar a cirurgia de ${patient.name} (${s.procedureName}, lado ${M.laterality[s.laterality].toLowerCase()})?` : `Iniciar o atendimento de ${patient.name}?`;
        if (!(await confirmDialog(msg, { okLabel: actionLabel(next, s) }))) return;
      } else if (next === 'concluida') {
        if (!(await confirmDialog(`${actionLabel(next, s)}? Depois disso, o agendamento não poderá ser editado.`, { okLabel: actionLabel(next, s) }))) return;
      } else if (next === 'agendada' && s.status === 'adiada') {
        if (!(await confirmDialog('Reagendar? Antes, use "Editar dados" para definir a nova data e horário.', { okLabel: 'Reagendar' }))) return;
      }
      try {
        await api('POST', `/api/surgeries/${encodeURIComponent(s.id)}/status`, { status: next, reason });
        await after(`Situação alterada para "${M.status[next]}".`);
      } catch (e) { fail(e); }
    };
  });
  const ed = body.querySelector('[data-edit]');
  if (ed) ed.onclick = () => { m.close(); openSurgeryForm({}, s); };
  body.querySelector('[data-print]').onclick = () => printModal(m);
  body.querySelector('[data-gopatient]').onclick = () => m.close();
  const gf = body.querySelector('[data-gofin]'); if (gf) gf.onclick = () => m.close();
  const pay = body.querySelector('[data-pay]');
  if (pay) pay.onclick = async () => {
    const charge = await api('GET', `/api/finance/charges/${encodeURIComponent(s.charge.id)}`);
    openPaymentForm(charge, () => after('Pagamento registrado.'));
  };
  body.querySelectorAll('[data-viewsig]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); openSignatureView(a.dataset.viewsig); }; });
  body.querySelectorAll('[data-sign]').forEach((b) => {
    b.onclick = () => openSignatureForm({ patient, surgery: s, docType: b.dataset.sign, onDone: () => after('Assinatura registrada.') });
  });
  const so = body.querySelector('[data-signother]');
  if (so) so.onclick = () => openSignatureForm({ patient, surgery: s, onDone: () => after('Assinatura registrada.') });

  body.querySelectorAll('.phase').forEach((ph) => {
    const phase = ph.dataset.phase;
    const save = async (complete) => {
      const items = {};
      ph.querySelectorAll('[data-item]').forEach((c) => { items[c.dataset.item] = c.checked; });
      if (complete && !Object.values(items).every(Boolean)) { fail({ message: 'Confira todos os itens antes de concluir a etapa.' }); return; }
      if (complete && !(await confirmDialog(`Concluir a etapa "${M.checklist[phase].label}"? Ela será registrada em seu nome e não poderá ser alterada.`, { okLabel: 'Concluir etapa' }))) return;
      try {
        await api('PUT', `/api/surgeries/${encodeURIComponent(s.id)}/checklist/${phase}`, {
          items, complete, notes: (ph.querySelector('[data-notes]') || {}).value || null,
        });
        await after(complete ? 'Etapa do checklist concluída.' : 'Progresso salvo.');
      } catch (e) { fail(e); }
    };
    const sp = ph.querySelector('[data-savephase]'); if (sp) sp.onclick = () => save(false);
    const cp = ph.querySelector('[data-completephase]'); if (cp) cp.onclick = () => save(true);
  });
}

// DRE gerencial (regime de caixa) pelo plano de contas
import { api, esc, fmtDate, todayStr, addDays, $, options, ICONS, myPro, fmtMoney, state } from './core.js';
import { donut } from './charts.js';

const PERIODS = { mes: 'Este mês', mes_passado: 'Mês passado', trimestre: 'Últimos 3 meses', ano: 'Este ano', personalizado: 'Personalizado' };

function range(p, params) {
  const t = todayStr(); const [y, m] = t.split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const last = (yy, mm) => new Date(yy, mm, 0).getDate();
  if (p === 'mes_passado') { const py = m === 1 ? y - 1 : y; const pm = m === 1 ? 12 : m - 1; return [`${py}-${pad(pm)}-01`, `${py}-${pad(pm)}-${last(py, pm)}`]; }
  if (p === 'trimestre') { const d = new Date(y, m - 3, 1); return [`${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`, t]; }
  if (p === 'ano') return [`${y}-01-01`, t];
  if (p === 'personalizado') return [params.get('from') || `${y}-${pad(m)}-01`, params.get('to') || t];
  return [`${y}-${pad(m)}-01`, t];
}

const money = (c) => (c < 0 ? `(${fmtMoney(-c)})` : fmtMoney(c));
const pct = (v) => (v == null ? '—' : `${String(v).replace('.', ',')}%`);

export async function drePage(page, params) {
  const mode = params.get('modo') === 'mensal' ? 'mensal' : 'periodo';
  const period = PERIODS[params.get('p')] ? params.get('p') : 'mes';
  const year = /^\d{4}$/.test(params.get('ano') || '') ? params.get('ano') : todayStr().slice(0, 4);
  const mine = myPro();
  const pro = mine ? '' : params.get('pro') || '';
  const [from, to] = range(period, params);
  const go = (ch) => {
    const q = new URLSearchParams({ modo: mode, p: period, ano: year, ...(pro ? { pro } : {}), ...(period === 'personalizado' ? { from, to } : {}), ...ch });
    for (const [k, v] of [...q]) if (v === '') q.delete(k);
    location.hash = `#/dre?${q}`;
  };
  const qs = mode === 'mensal' ? `mode=mensal&year=${year}` : `from=${from}&to=${to}`;
  const [d, pros] = await Promise.all([
    api('GET', `/api/finance/dre?${qs}${pro ? `&professionalId=${encodeURIComponent(pro)}` : ''}`),
    api('GET', '/api/professionals'),
  ]);
  const line = (code) => d.lines.find((l) => l.code === code);
  const ref = mode === 'mensal' ? d.columns.length - 1 : 0;
  const v = (code) => (line(code) ? line(code).values[ref] : 0);
  const years = Array.from({ length: 6 }, (_, i) => String(Number(todayStr().slice(0, 4)) - i));

  const head = d.columns.map((c) => `<th style="text-align:right">${esc(c.label)}${mode === 'periodo' ? `<br><span class="small muted" style="text-transform:none;letter-spacing:0">${esc(fmtDate(c.from))} a ${esc(fmtDate(c.to))}</span>` : ''}</th>`).join('');
  const rows = d.lines.map((l) => {
    const cls = l.type === 'result' ? 'dre-result' : l.type === 'group' ? 'dre-group' : 'dre-acc';
    const cells = l.values.map((x, i) => `<td class="num ${x < 0 ? 'neg' : ''}${i === ref && mode === 'mensal' ? ' tot' : ''}">${x === 0 && l.type === 'account' ? '—' : esc(money(x))}</td>`).join('');
    return `<tr class="${cls}"><td><span class="dre-code">${l.code.length <= 2 && /^[A-Z]/.test(l.code) ? '' : esc(l.code)}</span><span style="padding-left:${l.level * 18}px">${esc(l.name)}</span></td>${cells}
      <td class="num muted">${esc(pct(l.av))}</td>${mode === 'periodo' ? `<td class="num ${l.ah > 0 ? 'pos' : l.ah < 0 ? 'neg' : ''}">${l.ah == null ? '—' : `${l.ah > 0 ? '+' : ''}${esc(pct(l.ah))}`}</td>` : ''}</tr>`;
  }).join('');

  const result = v('RP');
  page.innerHTML = `
    <div class="page-head">
      <div><button class="btn menu-toggle" id="menuToggle" aria-label="Abrir menu">${ICONS.menu}</button><h1>DRE gerencial</h1>
        <p class="muted">Resultado pelo plano de contas, a partir do que foi <strong>recebido e pago</strong> (regime de caixa)${d.professional ? ` · ${esc(d.professional.name)}` : ''}.</p></div>
      <div class="toolbar no-print">
        <select id="mode" class="btn" aria-label="Visão">${options({ periodo: 'Período (comparado ao anterior)', mensal: 'Mês a mês do ano' }, mode)}</select>
        ${mode === 'mensal' ? `<select id="year" class="btn" aria-label="Ano">${options(Object.fromEntries(years.map((y) => [y, y])), year)}</select>`
          : `<select id="per" class="btn" aria-label="Período">${options(PERIODS, period)}</select>
             ${period === 'personalizado' ? `<input type="date" id="from" class="btn" value="${esc(from)}" aria-label="De"><input type="date" id="to" class="btn" value="${esc(to)}" aria-label="Até">` : ''}`}
        ${mine ? '' : `<select id="proF" class="btn" aria-label="Médico"><option value="">Toda a clínica</option>${pros.map((p) => `<option value="${esc(p.id)}"${p.id === pro ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`}
        <button class="btn" id="csv">Exportar para Excel</button>
        <button class="btn" id="print">${ICONS.print} Imprimir</button>
      </div>
    </div>
    <div class="print-only" style="margin-bottom:10px"><strong>${esc(state.meta.clinicName)} — DRE gerencial (regime de caixa)</strong><br>${esc(d.columns.map((c) => `${c.label}: ${fmtDate(c.from)} a ${fmtDate(c.to)}`).join(' · '))}</div>
    <div class="stats">
      <div class="stat"><b>${esc(fmtMoney(v('1')))}</b><span>receita bruta</span></div>
      <div class="stat"><b>${esc(money(v('LB')))}</b><span>lucro bruto · ${esc(pct(line('LB').av))} da receita</span></div>
      <div class="stat"><b>${esc(money(v('RO')))}</b><span>resultado operacional · ${esc(pct(line('RO').av))}</span></div>
      <div class="stat"><b style="color:${result < 0 ? 'var(--danger)' : 'var(--ok)'}">${esc(money(result))}</b><span>resultado do período${mode === 'mensal' ? ' (ano)' : ''}</span></div>
    </div>
    <section class="panel"><div class="table-wrap"><table class="list dre">
      <thead><tr><th>Conta</th>${head}<th style="text-align:right">% receita</th>${mode === 'periodo' ? '<th style="text-align:right">Variação</th>' : ''}</tr></thead>
      <tbody>${rows}</tbody></table></div>
      <ul class="small muted" style="margin:12px 0 0;padding-left:18px">${d.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
    </section>
    <div class="grid2 no-print">
      <section class="panel"><h3 style="margin-bottom:10px">Para onde foi a receita</h3>${donut([
        { label: 'Deduções (impostos e taxas)', value: -v('2'), color: '#F0A93B' },
        { label: 'Custos dos serviços', value: -v('3'), color: '#E35D6A' },
        { label: 'Despesas operacionais', value: -v('4'), color: '#7C5CDB' },
        { label: 'Investimentos', value: -v('5'), color: '#5B8DB8' },
        { label: 'Resultado (sobra)', value: Math.max(result, 0), color: '#17A673' },
      ], { fmt: fmtMoney, size: 180, center: fmtMoney(v('1')), centerSub: 'receita', empty: 'Sem movimentação no período.' })}
      ${result < 0 ? '<p class="small" style="color:var(--danger);margin:8px 0 0">As saídas superaram a receita: o período fechou no negativo.</p>' : ''}</section>
      <section class="panel"><h3 style="margin-bottom:10px">Receita por especialidade</h3>${donut(d.lines.filter((l) => l.code.startsWith('1.')).map((l) => ({ label: l.name, value: l.values[ref] })), { fmt: fmtMoney, size: 180, empty: 'Nenhum recebimento no período.' })}</section>
    </div>`;

  const md = $('#mode'); md.onchange = (e) => go({ modo: e.target.value });
  const yr = $('#year'); if (yr) yr.onchange = (e) => go({ ano: e.target.value });
  const pr = $('#per'); if (pr) pr.onchange = (e) => go({ p: e.target.value });
  if ($('#from')) { $('#from').onchange = (e) => go({ from: e.target.value }); $('#to').onchange = (e) => go({ to: e.target.value }); }
  const pf = $('#proF'); if (pf) pf.onchange = (e) => go({ pro: e.target.value });
  $('#print').onclick = () => window.print();
  $('#csv').onclick = () => exportCsv(d, mode);
}

/** Exporta em CSV com ponto e vírgula e vírgula decimal (abre direto no Excel em português). */
function exportCsv(d, mode) {
  const num = (c) => (c / 100).toFixed(2).replace('.', ',');
  const q = (t) => `"${String(t).replace(/"/g, '""')}"`;
  const header = ['Código', 'Conta', ...d.columns.map((c) => `${c.label} (${fmtDate(c.from)} a ${fmtDate(c.to)})`), '% receita', ...(mode === 'periodo' ? ['Variação %'] : [])];
  const rows = d.lines.map((l) => [l.code, `${'  '.repeat(l.level)}${l.name}`, ...l.values.map(num), l.av == null ? '' : String(l.av).replace('.', ','), ...(mode === 'periodo' ? [l.ah == null ? '' : String(l.ah).replace('.', ',')] : [])]);
  const csv = '\uFEFF' + [header, ...rows].map((r) => r.map(q).join(';')).join('\r\n') + '\r\n\r\n' + d.notes.map(q).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = `DRE-${d.columns[0].from}-a-${d.columns[d.columns.length - 1].to}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

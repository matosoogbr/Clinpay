// Portal do paciente: os próprios exames liberados pelo médico e as próprias consultas
import { api, state, esc, fmtDate, fmtDateTime, modal, ICONS, endTime } from './core.js';

const CAT = { laboratorial: 'Laboratorial', imagem: 'Imagem', radiologico: 'Radiológico', clinico: 'Clínico / funcional', outro: 'Outro' };

export async function portalPage(page, tab) {
  const me = await api('GET', '/api/portal/me');
  const head = (title, sub) => `<div class="page-head"><div><button class="btn menu-toggle" id="menuToggle" aria-label="Abrir menu">${ICONS.menu}</button>
    <h1>${esc(title)}</h1><p class="muted">${esc(sub)}</p></div></div>`;

  if (tab === 'consultas') {
    const list = await api('GET', '/api/portal/appointments');
    const now = new Date();
    const upcoming = list.filter((a) => new Date(`${a.date}T${a.startTime}:00`) >= now && !['cancelada', 'faltou'].includes(a.status)).reverse();
    const past = list.filter((a) => !upcoming.includes(a));
    const row = (a) => `<tr><td><strong>${esc(fmtDate(a.date))}</strong><br><span class="muted small">${esc(a.startTime)}–${esc(endTime(a.startTime, a.durationMin))}</span></td>
      <td>${esc(a.type === 'cirurgia' ? 'Cirurgia' : 'Consulta')}<br><span class="muted small">${esc(a.professionalName)}</span></td>
      <td><span class="chip ${esc(a.status)}">${esc(state.meta.status[a.status] || a.status)}</span>${a.patientNotes ? `<br><span class="small">${esc(a.patientNotes)}</span>` : ''}</td>
      <td>${a.confirmToken ? `<a class="btn sm primary" href="/confirmar.html?t=${encodeURIComponent(a.confirmToken)}">Confirmar ou cancelar</a>` : ''}</td></tr>`;
    page.innerHTML = `${head('Minhas consultas', `${me.name}, aqui estão os seus atendimentos nesta clínica.`)}
      <section class="panel"><h2 style="margin-bottom:10px">Próximas</h2>
        ${upcoming.length ? `<div class="table-wrap"><table class="list"><tbody>${upcoming.map(row).join('')}</tbody></table></div>` : '<p class="muted">Nenhuma consulta marcada.</p>'}</section>
      <section class="panel"><h2 style="margin-bottom:10px">Anteriores</h2>
        ${past.length ? `<div class="table-wrap"><table class="list"><tbody>${past.map(row).join('')}</tbody></table></div>` : '<p class="muted">Nenhuma.</p>'}</section>`;
    return;
  }

  const exams = await api('GET', '/api/portal/exams');
  page.innerHTML = `${head('Meus exames', `${me.name}, os resultados aparecem aqui assim que o médico liberar.`)}
    ${exams.length ? exams.map((e) => `<section class="panel">
      <div class="page-head" style="margin-bottom:8px"><div><h2>${esc(e.title)}</h2>
        <p class="muted small">${esc(CAT[e.category] || '')} · realizado em ${esc(fmtDate(e.examDate))} · liberado em ${esc(fmtDateTime(e.releasedAt))}</p></div></div>
      ${e.resultText ? `<div class="doc-text">${esc(e.resultText)}</div>` : ''}
      ${e.patientMessage ? `<div class="alert info" style="margin-top:10px"><strong>Orientação do médico:</strong> ${esc(e.patientMessage)}</div>` : ''}
      ${e.files.length ? `<div class="toolbar" style="margin-top:10px">${e.files.map((f) => `<button class="btn sm" data-file="${esc(f.id)}">Abrir ${esc(f.name)}</button>`).join('')}</div>` : ''}
      ${e.editedAfterRelease ? '<p class="small muted" style="margin-top:8px">Este resultado foi atualizado pelo médico depois de liberado.</p>' : ''}
    </section>`).join('') : '<div class="panel empty"><h2>Nenhum exame liberado ainda</h2><p>Quando o médico lançar e liberar um resultado, ele aparecerá aqui.</p></div>'}
    <p class="small muted" style="margin-top:14px">Os resultados não substituem a consulta. Em caso de dúvida, fale com o seu médico.</p>`;
  page.querySelectorAll('[data-file]').forEach((b) => { b.onclick = () => openFile(`/api/portal/files/${encodeURIComponent(b.dataset.file)}`); });
}

/** Abre imagem ou PDF numa janela. */
export async function openFile(url) {
  const m = modal({ title: 'Arquivo', wide: true, body: '<p class="muted">Carregando…</p>' });
  try {
    const f = await api('GET', url);
    m.el.querySelector('#mt').textContent = f.name;
    const body = m.el.querySelector('.modal-body');
    if (f.mime === 'application/pdf') {
      // PDF: oferece o download (o navegador abre com o leitor de PDF)
      const a = document.createElement('a');
      a.href = f.dataUrl; a.download = f.name; a.className = 'btn primary'; a.textContent = `Baixar ${f.name}`;
      body.innerHTML = '<p>Arquivo em PDF.</p>'; body.appendChild(a);
    } else {
      const img = document.createElement('img');
      img.src = f.dataUrl; img.alt = f.name; img.style.maxWidth = '100%'; img.style.borderRadius = '8px';
      body.innerHTML = ''; body.appendChild(img);
    }
  } catch (e) { m.el.querySelector('.modal-body').innerHTML = `<div class="alert danger">${esc(e.message)}</div>`; }
}

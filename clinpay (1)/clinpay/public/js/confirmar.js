// Página pública: o paciente confirma ou cancela pelo link do lembrete (sem login)
(function () {
  var box = document.getElementById('box');
  var t = new URLSearchParams(location.search).get('t') || '';
  if (document.documentElement.getAttribute('data-theme') === 'dark') document.querySelector('.logo-light').src = '/logo-white.svg';
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var STATUS = { agendada: 'Agendado', confirmada: 'Confirmado', cancelada: 'Cancelado', concluida: 'Concluído', em_andamento: 'Em atendimento', adiada: 'Adiado', faltou: 'Não compareceu' };
  function fmt(d) { var p = d.split('-'); var dt = new Date(+p[0], +p[1] - 1, +p[2], 12); var s = dt.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' }); return s.charAt(0).toUpperCase() + s.slice(1); }
  function call(method, body) {
    return fetch('/api/public/appointment' + (method === 'GET' ? '?t=' + encodeURIComponent(t) : ''), {
      method: method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j && j.error || 'Erro'); return j; }); });
  }
  function render(v, msg) {
    box.innerHTML =
      '<h1 style="font-size:1.4rem">Olá, ' + esc(v.patientFirstName) + '!</h1>' +
      '<p class="muted">' + esc(v.clinicName) + '</p>' +
      (msg ? '<div class="alert ' + msg[0] + '">' + esc(msg[1]) + '</div>' : '') +
      '<dl class="kv" style="margin:14px 0"><dt>' + (v.type === 'cirurgia' ? 'Procedimento' : 'Consulta') + '</dt><dd>com ' + esc(v.professionalName) + '</dd>' +
      '<dt>Data</dt><dd><strong>' + esc(fmt(v.date)) + '</strong></dd><dt>Horário</dt><dd><strong>' + esc(v.startTime) + '</strong></dd>' +
      '<dt>Situação</dt><dd><span class="chip ' + esc(v.status) + '">' + esc(STATUS[v.status] || v.status) + '</span></dd></dl>' +
      (v.canAnswer ? '<div class="toolbar">' + (v.status === 'agendada' ? '<button class="btn primary" id="ok">Confirmar presença</button>' : '') +
        '<button class="btn danger" id="no">Não poderei ir (cancelar)</button></div>' : '') +
      (v.clinicPhone ? '<p class="small muted" style="margin-top:16px">Dúvidas ou para remarcar: ' + esc(v.clinicPhone) + '</p>' : '');
    var ok = document.getElementById('ok'); var no = document.getElementById('no');
    if (ok) ok.onclick = function () { answer('confirmar'); };
    if (no) no.onclick = function () { if (confirm('Cancelar este atendimento? A clínica será avisada.')) answer('cancelar'); };
  }
  function answer(action) {
    box.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    call('POST', { t: t, action: action }).then(function (v) {
      render(v, action === 'confirmar' ? ['ok', 'Presença confirmada. Obrigado!'] : ['warn', 'Atendimento cancelado. Se quiser remarcar, fale com a clínica.']);
    }).catch(function (e) { box.insertAdjacentHTML('afterbegin', '<div class="alert danger">' + esc(e.message) + '</div>'); });
  }
  call('GET').then(function (v) { render(v); }).catch(function (e) {
    box.innerHTML = '<h1 style="font-size:1.3rem">Link inválido</h1><p class="muted">' + esc(e.message) + ' Entre em contato com a clínica.</p>';
  });
})();

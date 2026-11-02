'use strict';

/**
 * Avisos e lembretes de consultas e cirurgias por e-mail.
 *
 * - Ao agendar, alterar data/hora/sala, adiar ou cancelar, avisa o paciente e a equipe.
 * - Lembretes automáticos antes do atendimento (padrão: 3 dias e 1 dia antes).
 * - Só recebe quem tem e-mail cadastrado E autorizou o recebimento.
 * - Os e-mails vão para uma fila: se o envio falhar, o sistema tenta de novo
 *   (até 5 vezes) e registra o erro para o administrador ver.
 *
 * Os horários das cirurgias são comparados com o relógio do computador servidor,
 * que deve estar no fuso horário da clínica.
 */

const config = require('./config');
const crypto = require('node:crypto');
const { sendMail } = require('./mail/smtp');
const { sendWhatsApp, toE164 } = require('./whatsapp');
const S = require('./domain/surgeries');

const SETTINGS_KEY = 'email';
const MAX_ATTEMPTS = 5;

const DEFAULTS = {
  enabled: false,
  host: '',
  port: 587,
  security: 'starttls',
  user: '',
  pass: '',
  fromName: config.clinicName,
  fromAddr: '',
  clinicAddress: '',
  clinicPhone: '',
  reminderHours: [72, 24], // 3 dias e 1 dia antes
  notifyTeam: true,
  includeProcedureForPatient: false,
};

const KIND_LABELS = {
  agendada: 'Agendamento',
  alterada: 'Alteração',
  adiada: 'Adiamento',
  cancelada: 'Cancelamento',
  lembrete: 'Lembrete',
  teste: 'Teste',
  mensagem: 'Mensagem',
};

// Configuração de e-mail de cada clínica (o armazenamento já está filtrado pela clínica do contexto)
async function getSettings(store) {
  const doc = await store.findOne('settings', (s) => s.key === SETTINGS_KEY);
  const clinicId = store.clinicId ? store.clinicId() : null;
  const clinic = clinicId && store.base ? await store.base.get('clinics', clinicId) : null;
  return { ...DEFAULTS, fromName: clinic ? clinic.name : DEFAULTS.fromName, ...(doc ? doc.value : {}) };
}

async function saveSettings(store, value) {
  const doc = await store.findOne('settings', (s) => s.key === SETTINGS_KEY);
  if (doc) return store.update('settings', doc.id, { value });
  return store.insert('settings', { key: SETTINGS_KEY, value });
}

const isReady = (st) => !!(st.enabled && st.host && st.fromAddr);

// ---------- WhatsApp (configuração de cada clínica) ----------
const WA_KEY = 'whatsapp';
const WA_DEFAULTS = { enabled: false, phoneNumberId: '', token: '', templateName: '', languageCode: 'pt_BR', apiVersion: 'v21.0' };
async function getWaSettings(store) {
  const doc = await store.findOne('settings', (s) => s.key === WA_KEY);
  return { ...WA_DEFAULTS, ...(doc ? doc.value : {}) };
}
async function saveWaSettings(store, value) {
  const doc = await store.findOne('settings', (s) => s.key === WA_KEY);
  if (doc) return store.update('settings', doc.id, { value });
  return store.insert('settings', { key: WA_KEY, value });
}
const isWaReady = (w) => !!(w.enabled && w.phoneNumberId && w.token && w.templateName);
const confirmLink = (s) => `${config.publicUrl}/confirmar.html?t=${encodeURIComponent(s.confirmToken)}`;

// ---------------- Composição das mensagens ----------------
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

function localStart(s) {
  const [y, m, d] = s.date.split('-').map(Number);
  const [hh, mm] = s.startTime.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm);
}

function longDate(s) {
  const [y, m, d] = s.date.split('-').map(Number);
  const txt = new Date(y, m - 1, d, 12).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}
const shortDate = (s) => s.date.split('-').reverse().slice(0, 2).join('/');
const firstName = (n) => String(n || '').trim().split(/\s+/)[0];

function layout(st, title, rows, paragraphs) {
  const text = [
    title, '',
    ...paragraphs.filter((p) => p && p.before).map((p) => p.text),
    ...rows.map(([k, v]) => `${k}: ${v}`), '',
    ...paragraphs.filter((p) => p && !p.before).map((p) => p.text), '',
    st.fromName,
    st.clinicAddress, st.clinicPhone ? `Telefone: ${st.clinicPhone}` : '',
    '', 'Este é um e-mail automático. Para não receber mais avisos, entre em contato com a clínica.',
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');

  const html = `<!doctype html><html><body style="margin:0;background:#EEF3F8;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#142033">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #D6DFEA;border-radius:10px">
<tr><td style="padding:20px 24px;border-bottom:1px solid #D6DFEA;font-size:20px;font-weight:700;color:#0B2545">${esc(st.fromName)}</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 14px;font-size:20px;color:#0B2545">${esc(title)}</h1>
${paragraphs.filter((p) => p && p.before).map((p) => `<p style="margin:0 0 12px;line-height:1.5">${esc(p.text)}</p>`).join('')}
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:8px 0 16px;border-collapse:collapse">
${rows.map(([k, v]) => `<tr><td style="padding:8px 10px;background:#F6F9FC;border:1px solid #E3E9F1;font-size:14px;color:#5B6B80;width:38%">${esc(k)}</td><td style="padding:8px 10px;border:1px solid #E3E9F1;font-size:15px;font-weight:600;white-space:pre-wrap">${esc(v)}</td></tr>`).join('')}
</table>
${paragraphs.filter((p) => p && !p.before).map((p) => `<p style="margin:0 0 12px;line-height:1.5;white-space:pre-wrap">${esc(p.text)}</p>`).join('')}
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #D6DFEA;font-size:13px;color:#5B6B80;line-height:1.5">
${esc(st.fromName)}${st.clinicAddress ? `<br>${esc(st.clinicAddress)}` : ''}${st.clinicPhone ? `<br>Telefone: ${esc(st.clinicPhone)}` : ''}
<br><br>Este é um e-mail automático. Para não receber mais avisos, entre em contato com a clínica.</td></tr>
</table></td></tr></table></body></html>`;
  return { text, html };
}

/** E-mail para o paciente: sem detalhes clínicos além do necessário. */
function patientMessage(st, kind, s, patient, extra) {
  const when = `${longDate(s)}, às ${s.startTime}`;
  const contact = st.clinicPhone ? ` pelo telefone ${st.clinicPhone}` : '';
  const rows = [['Data', longDate(s)], ['Horário', s.startTime]];
  if (st.clinicAddress) rows.push(['Local', st.clinicAddress]);
  if (st.includeProcedureForPatient) rows.push(['Procedimento', s.procedureName]);
  const preOp = s.preOpNotes ? { text: `Orientações da equipe:\n${s.preOpNotes}` } : null;
  const link = s.confirmToken && ['agendada', 'alterada', 'lembrete'].includes(kind)
    ? { text: `Para confirmar ou cancelar sua presença, acesse: ${confirmLink(s)}` } : null;
  const hello = { before: true, text: `Olá, ${firstName(patient.socialName || patient.name)}.` };
  const map = {
    agendada: {
      subject: `Seu agendamento na ${st.fromName}`,
      title: 'Seu agendamento foi registrado',
      paras: [hello, { before: true, text: `Registramos ${s.type === 'consulta' ? 'a sua consulta' : 'o seu atendimento cirúrgico'}. Confira os dados abaixo:` }, preOp, link,
        { text: `Se não puder comparecer ou tiver dúvidas, entre em contato com a clínica${contact}.` }],
    },
    alterada: {
      subject: `Alteração no seu agendamento na ${st.fromName}`,
      title: 'Seu agendamento foi alterado',
      paras: [hello, { before: true, text: 'A data, o horário ou o local do seu atendimento mudou. Os dados atualizados são:' }, preOp, link,
        { text: `Em caso de dúvidas, entre em contato com a clínica${contact}.` }],
    },
    adiada: {
      subject: `Seu agendamento na ${st.fromName} foi adiado`,
      title: 'Seu agendamento foi adiado',
      paras: [hello, { before: true, text: `O atendimento previsto para ${when} foi adiado. A clínica entrará em contato para combinar a nova data.` },
        { text: `Se preferir, ligue para a clínica${contact}.` }],
      rows: [],
    },
    cancelada: {
      subject: `Seu agendamento na ${st.fromName} foi cancelado`,
      title: 'Seu agendamento foi cancelado',
      paras: [hello, { before: true, text: `O atendimento previsto para ${when} foi cancelado.` },
        { text: `Para mais informações, entre em contato com a clínica${contact}.` }],
      rows: [],
    },
    lembrete: {
      subject: `Lembrete: seu atendimento em ${shortDate(s)} às ${s.startTime}`,
      title: extra.hours <= 24 ? 'Seu atendimento é amanhã' : `Faltam ${Math.round(extra.hours / 24)} dias para o seu atendimento`,
      paras: [hello, { before: true, text: `Este é um lembrete ${s.type === 'consulta' ? 'da sua consulta' : 'do seu atendimento cirúrgico'}:` }, preOp, link,
        { text: s.type === 'consulta' ? 'Chegue com alguns minutos de antecedência e leve um documento com foto e a carteirinha do convênio, se tiver.'
          : 'Siga as orientações de jejum e de medicamentos passadas pela equipe médica e leve um documento com foto.' },
        { text: `Se não puder comparecer, avise a clínica o quanto antes${contact}.` }],
    },
  };
  const m = map[kind];
  const body = layout(st, m.title, m.rows || rows, m.paras);
  return { subject: m.subject, ...body };
}

/** E-mail para a equipe: dados operacionais da cirurgia. */
function teamMessage(st, kind, s, ctx, pro, extra) {
  const label = kind === 'lembrete' ? `Lembrete (${extra.hours} h)` : KIND_LABELS[kind];
  const isConsulta = s.type === 'consulta';
  const role = s.surgeonId === pro.id ? 'Médico(a) responsável' : s.anesthetistId === pro.id ? 'Anestesista' : 'Equipe';
  const rows = [
    ['Tipo', isConsulta ? 'Consulta' : 'Cirurgia'],
    ['Data', longDate(s)],
    ['Horário', `${s.startTime} (${s.durationMin} min)`],
  ];
  if (s.roomId) rows.push(['Sala', ctx.roomName]);
  rows.push(['Paciente', ctx.patientName]);
  if (isConsulta) rows.push(['Motivo', s.procedureName]);
  else rows.push(['Procedimento', `${s.procedureName} — lado: ${S.LATERALITY[s.laterality].toLowerCase()}`], ['Anestesia', S.ANESTHESIA[s.anesthesiaType]]);
  rows.push(['Médico(a)', ctx.surgeonName], ['Sua função', role]);
  if (ctx.missingDocs.length && kind !== 'cancelada') rows.push(['Termos pendentes', ctx.missingDocs.map((d) => S.DOC_TYPES[d]).join(', ')]);
  const what = isConsulta ? 'consulta' : 'cirurgia';
  const intro = {
    agendada: `Uma ${what} com a sua participação foi agendada.`,
    alterada: `A data, o horário ou a sala desta ${what} foi alterada.`,
    adiada: `Esta ${what} foi adiada. Uma nova data será definida.`,
    cancelada: `Esta ${what} foi cancelada.`,
    lembrete: `Lembrete de ${what} com a sua participação.`,
  }[kind];
  const body = layout(st, `${label}: ${shortDate(s)} às ${s.startTime}`, rows,
    [{ before: true, text: `Olá, ${pro.name}.` }, { before: true, text: intro }]);
  return { subject: `[Agenda] ${label}: ${shortDate(s)} ${s.startTime} — ${ctx.patientName.split(' ')[0]}${s.roomId ? ` — ${ctx.roomName}` : ''}`, ...body };
}

// ---------------- Fila e agendador ----------------
function createNotifier(store, { send = sendMail, sendWa = sendWhatsApp } = {}) {
  let running = null;
  let timer = null;

  /** Executa fn para cada clínica ativa, cada uma no próprio contexto isolado. */
  async function forEachClinic(fn) {
    if (!store.base) return fn(); // armazenamento simples (sem multi-clínica)
    const clinics = await store.base.list('clinics', (c) => c.status === 'ativa');
    let total = 0;
    for (const c of clinics) total += (await store.run({ clinicId: c.id, user: null }, fn)) || 0;
    return total;
  }

  async function enqueue(email) {
    if (email.dedupeKey && await store.findOne('emails', (e) => e.dedupeKey === email.dedupeKey)) return null;
    return store.insert('emails', {
      ...email, status: 'pendente', attempts: 0, lastError: null, sentAt: null,
      nextAttemptAt: new Date().toISOString(),
    });
  }

  async function context(s) {
    const [patient, room, surgeon, sigs] = await Promise.all([
      store.get('patients', s.patientId), store.get('rooms', s.roomId), store.get('professionals', s.surgeonId),
      store.list('signatures', (x) => x.surgeryId === s.id),
    ]);
    const valid = sigs.filter((x) => patient && x.patientId === patient.id && (!s.patientChangedAt || x.signedAt > s.patientChangedAt));
    return {
      patient,
      patientName: patient ? patient.name : '(paciente)',
      roomName: room ? room.name : '(sala)',
      surgeonName: surgeon ? surgeon.name : '(cirurgião)',
      missingDocs: S.requiredDocsMissing(s, valid),
    };
  }

  /** Cria os e-mails de um evento da cirurgia. Nunca lança erro para quem chamou. */
  async function surgeryEvent(kind, s, extra = {}) {
    try {
      const st = await getSettings(store);
      const wa = await getWaSettings(store);
      if (!isReady(st) && !isWaReady(wa)) return 0;
      // Código secreto do link de confirmação (criado uma vez por atendimento)
      if (!s.confirmToken) {
        s = await store.update('surgeries', s.id, { confirmToken: crypto.randomBytes(24).toString('base64url') });
      }
      const ctx = await context(s);
      let n = 0;
      const key = (to) => {
        if (kind === 'lembrete') return `${s.id}|lembrete|${extra.hours}|${s.date}T${s.startTime}|${to}`;
        if (kind === 'agendada' || kind === 'cancelada') return `${s.id}|${kind}|${to}`;
        return `${s.id}|${kind}|${s.updatedAt}|${to}`;
      };
      const p = ctx.patient;
      if (isWaReady(wa) && p && p.active !== false && p.whatsappReminders && ['agendada', 'alterada', 'lembrete'].includes(kind)) {
        const phone = toE164(p.phone);
        if (phone) {
          const params = [firstName(p.socialName || p.name), longDate(s), s.startTime, st.fromName, confirmLink(s)];
          if (await enqueue({ channel: 'whatsapp', to: phone, toName: p.name, audience: 'paciente', kind, surgeryId: s.id,
            dedupeKey: `wa|${key(phone)}`, subject: `WhatsApp — ${KIND_LABELS[kind]}`, params, text: params.join(' | '), html: null })) n++;
        }
      }
      if (isReady(st) && p && p.active !== false && p.email && p.emailReminders) {
        const msg = patientMessage(st, kind, s, p, extra);
        if (await enqueue({ to: p.email, toName: p.name, audience: 'paciente', kind, surgeryId: s.id, dedupeKey: key(p.email), ...msg })) n++;
      }
      if (isReady(st) && st.notifyTeam) {
        const ids = [...new Set([s.surgeonId, s.anesthetistId, ...(s.teamIds || [])].filter(Boolean))];
        for (const id of ids) {
          const pro = await store.get('professionals', id);
          if (!pro || pro.active === false || !pro.email || !pro.emailReminders) continue;
          const msg = teamMessage(st, kind, s, ctx, pro, extra);
          if (await enqueue({ to: pro.email, toName: pro.name, audience: 'equipe', kind, surgeryId: s.id, dedupeKey: key(pro.email), ...msg })) n++;
        }
      }
      if (n) kick();
      return n;
    } catch (e) {
      console.error(new Date().toISOString(), 'Falha ao preparar avisos por e-mail:', e);
      return 0;
    }
  }

  /** Verifica quais lembretes estão no prazo. Para cada cirurgia, envia só o lembrete mais próximo vencido. */
  function tick(now = new Date()) {
    return forEachClinic(() => tickClinic(now));
  }

  async function tickClinic(now) {
    const st = await getSettings(store);
    if (!isReady(st) && !isWaReady(await getWaSettings(store))) return 0;
    const hours = [...new Set(st.reminderHours)].filter((h) => h > 0).sort((a, b) => a - b);
    if (!hours.length) return 0;
    const list = await store.list('surgeries', (s) => s.status === 'agendada' || s.status === 'confirmada');
    let n = 0;
    for (const s of list) {
      const start = localStart(s).getTime();
      if (now.getTime() >= start) continue;
      const ref = new Date(s.scheduleChangedAt || s.createdAt).getTime();
      const due = hours.find((h) => now.getTime() >= start - h * 3600000);
      if (due === undefined) continue;
      // Se a cirurgia foi marcada depois do momento do lembrete, o aviso de agendamento já basta
      if (start - due * 3600000 < ref) continue;
      n += await surgeryEvent('lembrete', s, { hours: due });
    }
    return n;
  }

  /** Envia os e-mails pendentes. Chamadas simultâneas aguardam o mesmo processamento. */
  function flush(now = () => new Date()) {
    if (running) return running;
    running = (async () => {
      try {
        await forEachClinic(() => flushClinic(now));
      } finally { running = null; }
    })();
    return running;
  }

  async function flushClinic(now) {
    for (;;) {
      const st = await getSettings(store);
      const wa = await getWaSettings(store);
      const okEmail = isReady(st); const okWa = isWaReady(wa);
      if (!okEmail && !okWa) return;
      const t = now().toISOString();
      const due = (await store.list('emails', (e) => e.status === 'pendente' && e.nextAttemptAt <= t &&
        (e.channel === 'whatsapp' ? okWa : okEmail)))
        .sort((x, y) => x.createdAt.localeCompare(y.createdAt));
      if (!due.length) return;
      for (const e of due) {
        try {
          if (e.channel === 'whatsapp') await sendWa(wa, { to: e.to, params: e.params });
          else await send(st, { to: e.to, subject: e.subject, text: e.text, html: e.html });
          await store.update('emails', e.id, { status: 'enviado', sentAt: new Date().toISOString(), attempts: e.attempts + 1, lastError: null });
        } catch (err) {
          const attempts = e.attempts + 1;
          await store.update('emails', e.id, {
            attempts,
            lastError: String(err.message || err).slice(0, 500),
            status: attempts >= MAX_ATTEMPTS ? 'falhou' : 'pendente',
            nextAttemptAt: new Date(now().getTime() + attempts * 5 * 60000).toISOString(),
          });
        }
      }
    }
  }

  function kick() { setImmediate(() => { flush().catch((e) => console.error('Falha no envio de e-mails:', e)); }); }

  async function sendTest(to) {
    const st = await getSettings(store);
    if (!st.host || !st.fromAddr) throw new Error('Preencha o servidor e o e-mail remetente antes de testar.');
    const body = layout(st, 'E-mail de teste', [['Enviado em', new Date().toLocaleString('pt-BR')]],
      [{ before: true, text: 'Se você recebeu esta mensagem, o envio de avisos do sistema está funcionando.' }]);
    await send(st, { to, subject: `Teste de envio — ${st.fromName}`, ...body });
  }

  /** Mensagem livre para o paciente, enviada por médico, funcionário ou recepção. */
  async function sendMessage(patient, subject, message, sender) {
    const st = await getSettings(store);
    const body = layout(st, subject, [], [
      { before: true, text: `Olá, ${firstName(patient.socialName || patient.name)}.` },
      { before: true, text: message },
      { text: `Enviado por ${sender.name}.` },
    ]);
    const e = await enqueue({ to: patient.email, toName: patient.name, audience: 'paciente', kind: 'mensagem', surgeryId: null,
      dedupeKey: null, subject: `${subject} — ${st.fromName}`, ...body });
    kick();
    return e;
  }

  function start(intervalMs = 60000) {
    const run = async () => {
      try { await tick(); await flush(); } catch (e) { console.error(new Date().toISOString(), 'Falha no agendador de e-mails:', e); }
    };
    setTimeout(run, 5000).unref();
    timer = setInterval(run, intervalMs);
    timer.unref();
  }
  const stop = () => { if (timer) clearInterval(timer); };

  return { surgeryEvent, tick, flush, kick, sendTest, sendMessage, start, stop };
}

module.exports = {
  createNotifier, getSettings, saveSettings, isReady, DEFAULTS, KIND_LABELS, localStart,
  getWaSettings, saveWaSettings, isWaReady, toE164,
};

'use strict';

/**
 * Assistente de IA do ClinPay.
 * - Disponível só se a plataforma tiver a chave da Anthropic E a clínica ativar.
 * - Contextos: "geral" (sem dados), "indicadores" (números agregados da clínica) e
 *   "paciente" (prontuário SEM nome, CPF ou contatos), este último só se a clínica autorizar.
 * - Limite diário por clínica e limite por minuto por usuário, para controlar custo.
 */

const { HttpError, sendJson } = require('../http/core');
const { validate } = require('../validation');
const auth = require('../auth');
const { audit } = require('../audit');
const { callClaude } = require('../ai');

const AI_KEY = 'ai';
const USAGE_KEY = 'ai_usage';
const DEFAULTS = { enabled: false, allowPatientData: false, dailyLimit: 200 };

const SYSTEM = `Você é o assistente do ClinPay, sistema de gestão para clínicas odontológicas no Brasil.
Responda sempre em português do Brasil, de forma clara, prática e curta (use listas só quando ajudar).
Você ajuda a equipe da clínica a: entender os indicadores e o financeiro, sugerir ações para reduzir faltas e aumentar a conversão de orçamentos, redigir mensagens para pacientes (lembretes, orçamentos, pós-atendimento), organizar a agenda, explicar como usar o sistema e resumir informações do prontuário quando fornecidas.
Regras:
- Você NÃO faz diagnóstico, NÃO prescreve medicamentos e NÃO substitui a avaliação do cirurgião-dentista. Ao falar de temas clínicos, apresente como apoio e lembre que a decisão é do profissional.
- Use somente os dados fornecidos no contexto. Se faltar informação, diga o que falta; nunca invente números, nomes ou resultados.
- Valores estão em reais. Não peça nem repita dados pessoais sensíveis (CPF, endereço, telefone).
- Em mensagens para pacientes, seja cordial e não inclua dados clínicos desnecessários.`;

function registerAi(r, store, { requirePerm, readJsonBody, analytics, ai = {} }) {
  const apiKey = ai.apiKey !== undefined ? ai.apiKey : process.env.ANTHROPIC_API_KEY || '';
  const model = ai.model || process.env.AI_MODEL || 'claude-sonnet-5-5';
  const call = ai.call || callClaude;
  const perMinute = new Map(); // userId -> [timestamps]

  const getDoc = (key) => store.findOne('settings', (s) => s.key === key);
  async function getSettings() { const d = await getDoc(AI_KEY); return { ...DEFAULTS, ...(d ? d.value : {}) }; }
  async function setDoc(key, value) { const d = await getDoc(key); return d ? store.update('settings', d.id, { value }) : store.insert('settings', { key, value }); }
  const today = () => new Date().toISOString().slice(0, 10);
  async function usedToday() { const d = await getDoc(USAGE_KEY); return d && d.value.date === today() ? d.value.count : 0; }

  r.get('/api/settings/ai', async (req, res) => {
    requirePerm(req, 'settings:manage');
    sendJson(res, 200, { ...(await getSettings()), available: !!apiKey, usedToday: await usedToday() });
  });

  r.put('/api/settings/ai', async (req, res) => {
    const u = requirePerm(req, 'settings:manage');
    const body = await readJsonBody(req);
    const data = validate(body, {
      enabled: { type: 'bool', label: 'Ativar' },
      allowPatientData: { type: 'bool', label: 'Permitir dados de pacientes' },
      dailyLimit: { type: 'int', label: 'Limite diário', min: 1, max: 5000 },
    });
    if (data.enabled && !apiKey) throw new HttpError(409, 'A IA ainda não está disponível nesta plataforma. Fale com o suporte ClinPay.');
    const current = await getSettings();
    if (data.allowPatientData && !current.allowPatientData && body.acceptPatientDataTerms !== true) {
      throw new HttpError(422, 'Para enviar dados de prontuário à IA, confirme o termo de responsabilidade (LGPD).', { allowPatientData: 'Confirme o termo.' });
    }
    const value = { ...current, ...data, dailyLimit: data.dailyLimit || current.dailyLimit };
    await setDoc(AI_KEY, value);
    await audit(store, req, u, 'update', 'settings', null,
      `Assistente de IA ${value.enabled ? 'ativado' : 'desativado'}; dados de pacientes ${value.allowPatientData ? 'PERMITIDOS' : 'bloqueados'}`);
    sendJson(res, 200, { ...value, available: !!apiKey, usedToday: await usedToday() });
  });

  r.get('/api/ai/status', async (req, res) => {
    const u = requirePerm(req, 'ai:use');
    const st = await getSettings();
    sendJson(res, 200, {
      available: !!apiKey, enabled: !!(apiKey && st.enabled),
      allowPatientData: st.allowPatientData && auth.can(u, 'records:read'),
    });
  });

  async function patientContext(u, patientId) {
    if (!auth.can(u, 'records:read')) throw new HttpError(403, 'Seu perfil não acessa o prontuário.');
    const p = await store.get('patients', String(patientId || ''));
    if (!p) throw new HttpError(404, 'Paciente não encontrado.');
    const [notes, exams, odo] = await Promise.all([
      store.list('record_notes', (n) => n.patientId === p.id),
      store.list('exams', (e) => e.patientId === p.id),
      store.findOne('odontograms', (o) => o.patientId === p.id),
    ]);
    const age = (() => { const [y, m, d] = p.birthDate.split('-').map(Number); const n = new Date(); let a = n.getFullYear() - y; if (n.getMonth() + 1 < m || (n.getMonth() + 1 === m && n.getDate() < d)) a--; return a; })();
    const cut = (t, n) => (t && t.length > n ? `${t.slice(0, n)}…` : t || '');
    // Minimização (LGPD): sem nome, CPF, contatos, endereço ou convênio
    const lines = [
      `Paciente: ${age} anos, sexo ${({ F: 'feminino', M: 'masculino', I: 'não informado' })[p.sex]}.`,
      `Alergias: ${p.noKnownAllergies ? 'nega alergias' : cut(p.allergies, 300)}.`,
      p.comorbidities ? `Comorbidades: ${cut(p.comorbidities, 300)}.` : '',
      p.medications ? `Medicamentos em uso: ${cut(p.medications, 300)}.` : '',
      odo && Object.keys(odo.teeth).length ? `Odontograma: ${Object.entries(odo.teeth).filter(([, t]) => t.status !== 'higido').map(([n, t]) => `dente ${n} ${t.status}${t.notes ? ` (${cut(t.notes, 60)})` : ''}`).join('; ')}.` : '',
      notes.length ? `Evoluções (mais recentes primeiro):\n${notes.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 15).map((n) => `- ${n.at.slice(0, 10)}: ${cut(n.text, 600)}`).join('\n')}` : 'Sem evoluções registradas.',
      exams.length ? `Exames:\n${exams.sort((a, b) => b.examDate.localeCompare(a.examDate)).slice(0, 10).map((e) => `- ${e.examDate} ${e.title}: ${cut(e.resultText, 400) || 'sem resultado lançado'}`).join('\n')}` : '',
    ].filter(Boolean);
    return { text: lines.join('\n'), patient: p };
  }

  r.post('/api/ai/chat', async (req, res) => {
    const u = requirePerm(req, 'ai:use');
    if (!apiKey) throw new HttpError(409, 'A IA ainda não está disponível nesta plataforma.');
    const st = await getSettings();
    if (!st.enabled) throw new HttpError(409, 'O assistente de IA está desativado nesta clínica. O médico responsável pode ativar em "Integrações".');
    const body = await readJsonBody(req);
    const msgs = body.messages;
    if (!Array.isArray(msgs) || !msgs.length || msgs.length > 20) throw new HttpError(422, 'Conversa inválida.');
    const messages = msgs.map((m, i) => {
      const role = m && m.role; const content = String((m && m.content) || '').trim();
      if (!['user', 'assistant'].includes(role) || !content || content.length > 4000) throw new HttpError(422, 'Mensagem inválida ou longa demais (máx. 4.000 caracteres).');
      if ((i % 2 === 0) !== (role === 'user')) throw new HttpError(422, 'Conversa fora de ordem.');
      return { role, content };
    });
    if (messages[messages.length - 1].role !== 'user') throw new HttpError(422, 'A última mensagem deve ser sua.');

    // Limites de uso
    const now = Date.now();
    const recent = (perMinute.get(u.id) || []).filter((t) => now - t < 60000);
    if (recent.length >= 10) throw new HttpError(429, 'Muitas perguntas em sequência. Aguarde um minuto.');
    const used = await usedToday();
    if (used >= st.dailyLimit) throw new HttpError(429, `A clínica atingiu o limite diário de ${st.dailyLimit} perguntas à IA. Ele renova amanhã.`);

    // Contexto (montado no servidor, nunca vindo do navegador)
    const kind = ['indicadores', 'paciente'].includes(body.context) ? body.context : 'geral';
    const clinic = store.base && store.clinicId() ? await store.base.get('clinics', store.clinicId()) : null;
    let context = `Clínica: ${clinic ? clinic.name : ''}. Usuário: ${u.name} (${auth.ROLE_LABELS[u.role]}). Data de hoje: ${today()}.`;
    if (kind === 'indicadores') {
      const q = new URLSearchParams();
      if (/^\d{4}-\d{2}-\d{2}$/.test(body.from || '')) q.set('from', body.from);
      if (/^\d{4}-\d{2}-\d{2}$/.test(body.to || '')) q.set('to', body.to);
      if (!auth.can(u, 'analytics:read')) throw new HttpError(403, 'Seu perfil não acessa os indicadores.');
      const a = await analytics.compute(u, q);
      const brl = (c) => (c == null ? '—' : (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
      context += `\nIndicadores de ${a.from} a ${a.to}${a.scoped ? ' (só do médico do usuário)' : ''}:
- Recebido: ${brl(a.kpis.receivedCents)}; despesas pagas: ${brl(a.kpis.expensesPaidCents)}; lucro: ${brl(a.kpis.profitCents)}; margem: ${a.kpis.marginPct ?? '—'}%.
- Atendimentos: ${a.kpis.appointments} agendados, ${a.kpis.completed} concluídos; ticket médio ${brl(a.kpis.avgTicketCents)}; faltas ${a.kpis.noShowRate ?? '—'}%; cancelamentos ${a.kpis.cancelRate ?? '—'}%; pacientes novos ${a.kpis.newPatients}.
- Orçamentos: conversão ${a.kpis.quoteConversion ?? '—'}%, aprovados ${brl(a.kpis.quotesApprovedCents)}. A receber ${brl(a.kpis.openCents)}, em atraso ${brl(a.kpis.overdueCents)}.
- Meta do mês: ${a.goal.monthCents ? `${brl(a.goal.receivedMonthCents)} de ${brl(a.goal.monthCents)} (${a.goal.progress}%; esperado hoje ${a.goal.expectedProgress}%)` : 'não definida'}.
- Receita por especialidade: ${a.revenueByCategory.map((x) => `${x.label} ${brl(x.cents)}`).join('; ') || 'sem dados'}.
- Receita por procedimento: ${a.revenueByProcedure.map((x) => `${x.label} ${brl(x.cents)}`).join('; ') || 'sem dados'}.
- Despesas por categoria: ${a.expensesByCategory.map((x) => `${x.label} ${brl(x.cents)}`).join('; ') || 'sem dados'}.
- Formas de pagamento: ${a.byMethod.map((x) => `${x.label} ${brl(x.cents)}`).join('; ') || 'sem dados'}.
- Funil de oportunidades: ${Object.entries(a.leadsByStage).map(([k, v]) => `${k} ${v}`).join('; ') || 'vazio'}.`;
    }
    let patientId = null;
    if (kind === 'paciente') {
      if (!st.allowPatientData) throw new HttpError(403, 'Esta clínica não autorizou o envio de dados de prontuário para a IA.');
      const pc = await patientContext(u, body.patientId);
      patientId = pc.patient.id;
      context += `\nResumo do prontuário (dados identificadores removidos):\n${pc.text}`;
    }

    recent.push(now); perMinute.set(u.id, recent);
    await setDoc(USAGE_KEY, { date: today(), count: used + 1 });
    let reply;
    try {
      reply = await call({ apiKey, model, system: `${SYSTEM}\n\nCONTEXTO:\n${context}`, messages });
    } catch (e) {
      throw new HttpError(502, e.message);
    }
    await audit(store, req, u, 'ai', kind === 'paciente' ? 'records' : 'ai', patientId,
      kind === 'paciente' ? 'Prontuário (sem identificação) enviado ao assistente de IA' : `Pergunta ao assistente de IA (${kind})`);
    sendJson(res, 200, { reply, usedToday: used + 1, dailyLimit: st.dailyLimit });
  });
}

module.exports = { registerAi };

// Assistente de IA: botão flutuante e painel de conversa
import { api, state, esc, $ } from './core.js';

let panel = null;
let convo = { key: '', messages: [] };

/** Formata a resposta: texto escapado, com **negrito** e quebras de linha. */
const fmt = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');

/** Descobre o contexto pela página atual. */
function pageContext() {
  const h = location.hash;
  const m = /^#\/paciente\/([^?]+)/.exec(h);
  if (m && state.ai.allowPatientData) return { context: 'paciente', patientId: decodeURIComponent(m[1]), label: 'Prontuário deste paciente (sem nome, CPF ou contatos)' };
  if (h.startsWith('#/indicadores') || h.startsWith('#/financeiro')) return { context: 'indicadores', label: 'Indicadores do mês' };
  return { context: 'geral', label: 'Conversa geral (sem dados de pacientes)' };
}

const SUGGESTIONS = {
  geral: ['Escreva uma mensagem de lembrete de consulta para WhatsApp', 'Escreva uma mensagem pós-atendimento perguntando como o paciente está', 'Como reduzir faltas nas consultas?', 'Escreva um texto para enviar junto com um orçamento de implante'],
  indicadores: ['Analise os indicadores: o que está bom e o que preocupa?', 'Como aumentar a conversão de orçamentos?', 'Onde posso reduzir despesas?', 'Estou no ritmo da meta do mês?'],
  paciente: ['Resuma o histórico clínico deste paciente', 'Liste pontos de atenção (alergias, medicamentos) antes do procedimento', 'Escreva orientações pós-procedimento em linguagem simples'],
};

export function mountAssistant() {
  if (!state.ai || !state.ai.enabled || $('#aiFab')) return;
  const fab = document.createElement('button');
  fab.id = 'aiFab'; fab.className = 'ai-fab no-print'; fab.type = 'button';
  fab.innerHTML = '<span aria-hidden="true">✦</span> Assistente';
  fab.onclick = () => (panel ? closeAssistant() : openAssistant({}));
  document.body.appendChild(fab);
}

export function closeAssistant() { if (panel) { panel.remove(); panel = null; } }

export function openAssistant({ context, patientId, from, to, prompt } = {}) {
  if (!state.ai || !state.ai.enabled) return;
  const pc = context ? { context, patientId, label: context === 'indicadores' ? 'Indicadores do período' : pageContext().label } : pageContext();
  const key = `${pc.context}|${pc.patientId || ''}`;
  if (convo.key !== key) convo = { key, messages: [] };
  closeAssistant();
  panel = document.createElement('aside');
  panel.className = 'ai-panel no-print';
  panel.setAttribute('aria-label', 'Assistente de IA');
  panel.innerHTML = `
    <div class="ai-head"><div><strong>✦ Assistente ClinPay</strong><div class="small">${esc(pc.label)}</div></div>
      <button class="close-x" aria-label="Fechar assistente">×</button></div>
    <div class="ai-msgs" id="aiMsgs" aria-live="polite"></div>
    <div class="ai-sugs" id="aiSugs"></div>
    <form class="ai-input" id="aiForm"><textarea id="aiText" rows="2" placeholder="Pergunte ou peça um texto…" maxlength="4000"></textarea>
      <button class="btn primary" type="submit">Enviar</button></form>
    <p class="ai-note">A IA pode errar. Ela não faz diagnóstico nem prescrição: revise tudo antes de usar com pacientes.</p>`;
  document.body.appendChild(panel);
  panel.querySelector('.close-x').onclick = closeAssistant;
  const msgs = panel.querySelector('#aiMsgs');
  const draw = () => {
    msgs.innerHTML = convo.messages.length ? convo.messages.map((m) => `<div class="ai-msg ${m.role}">${fmt(m.content)}</div>`).join('')
      : '<p class="muted small">Olá! Posso analisar números da clínica, escrever mensagens para pacientes e explicar como usar o sistema.</p>';
    msgs.scrollTop = msgs.scrollHeight;
    const sugs = panel.querySelector('#aiSugs');
    sugs.innerHTML = convo.messages.length ? '' : SUGGESTIONS[pc.context].map((t) => `<button type="button">${esc(t)}</button>`).join('');
    sugs.querySelectorAll('button').forEach((b) => { b.onclick = () => send(b.textContent); });
  };
  let busy = false;
  async function send(text) {
    text = String(text || '').trim();
    if (!text || busy) return;
    busy = true;
    convo.messages.push({ role: 'user', content: text });
    draw();
    msgs.insertAdjacentHTML('beforeend', '<div class="ai-msg assistant typing">Pensando…</div>');
    msgs.scrollTop = msgs.scrollHeight;
    try {
      const r = await api('POST', '/api/ai/chat', { context: pc.context, patientId: pc.patientId, from, to, messages: convo.messages.slice(-20) });
      convo.messages.push({ role: 'assistant', content: r.reply });
    } catch (e) {
      convo.messages.pop(); // a pergunta não respondida sai da conversa, para poder tentar de novo
      draw();
      msgs.insertAdjacentHTML('beforeend', `<div class="alert danger small">${esc(e.message)}</div>`);
      panel.querySelector('#aiText').value = text;
      busy = false;
      return;
    }
    busy = false;
    draw();
  }
  panel.querySelector('#aiForm').onsubmit = (e) => { e.preventDefault(); const t = panel.querySelector('#aiText'); const v = t.value; t.value = ''; send(v); };
  panel.querySelector('#aiText').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); panel.querySelector('#aiForm').requestSubmit(); } };
  draw();
  setTimeout(() => panel && panel.querySelector('#aiText').focus(), 30);
  if (prompt && !convo.messages.length) send(prompt);
}

/** Carrega o estado da IA para o usuário (chamado ao entrar no sistema). */
export async function loadAi() {
  state.ai = { enabled: false };
  if (!state.perms.has('ai:use')) return;
  try { state.ai = await api('GET', '/api/ai/status'); } catch { /* sem IA */ }
  mountAssistant();
}

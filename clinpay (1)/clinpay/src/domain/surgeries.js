'use strict';

const config = require('../config');
const { HttpError } = require('../http/core');

// Tipos de agendamento. Cirurgia exige termos assinados e checklist de segurança.
const TYPES = { consulta: 'Consulta', cirurgia: 'Cirurgia' };

const STATUS = {
  agendada: 'Agendada',
  confirmada: 'Confirmada',
  em_andamento: 'Em atendimento',
  concluida: 'Concluída',
  adiada: 'Adiada',
  cancelada: 'Cancelada',
  faltou: 'Paciente faltou',
};

// Transições permitidas. Concluída e cancelada são finais.
const TRANSITIONS = {
  agendada: ['confirmada', 'adiada', 'cancelada', 'faltou'],
  confirmada: ['agendada', 'em_andamento', 'adiada', 'cancelada', 'faltou'],
  em_andamento: ['concluida'],
  adiada: ['agendada', 'cancelada'],
  concluida: [],
  cancelada: [],
  faltou: [],
};

// Status que ainda ocupam sala e equipe na agenda
const OCCUPYING = ['agendada', 'confirmada', 'em_andamento', 'concluida'];

const ANESTHESIA = {
  geral: 'Geral',
  raquidiana: 'Raquidiana',
  peridural: 'Peridural',
  bloqueio: 'Bloqueio periférico',
  sedacao: 'Sedação',
  local: 'Local',
  nenhuma: 'Sem anestesia',
};
const NEEDS_ANESTHETIST = ['geral', 'raquidiana', 'peridural', 'bloqueio', 'sedacao'];

const LATERALITY = {
  direito: 'Direito',
  esquerdo: 'Esquerdo',
  bilateral: 'Bilateral',
  nao_se_aplica: 'Não se aplica',
};

const PRIORITY = { eletiva: 'Eletiva', urgencia: 'Urgência', emergencia: 'Emergência' };

// Documentos que precisam estar assinados antes de iniciar a cirurgia
const DOC_TYPES = {
  termo_cirurgico: 'Termo de consentimento cirúrgico',
  termo_anestesico: 'Termo de consentimento anestésico',
  termo_hemotransfusao: 'Termo de consentimento para hemotransfusão',
  termo_imagem: 'Autorização de uso de imagem',
  anamnese: 'Anamnese',
  outro: 'Outro documento',
};

/** Lista de Verificação de Segurança Cirúrgica (baseada no modelo da OMS). */
const CHECKLIST = {
  entrada: {
    label: 'Entrada — antes da indução anestésica',
    items: {
      identidade: 'Paciente confirmou identidade, sítio cirúrgico, procedimento e consentimento',
      sitio_demarcado: 'Sítio cirúrgico demarcado (ou não se aplica)',
      anestesia_verificada: 'Verificação de segurança anestésica concluída (equipamentos e medicações)',
      oximetro: 'Oxímetro de pulso instalado e funcionando',
      alergias: 'Alergias conhecidas verificadas',
      via_aerea: 'Risco de via aérea difícil ou aspiração avaliado',
      sangramento: 'Risco de perda sanguínea > 500 ml (7 ml/kg em crianças) avaliado e acesso planejado',
    },
  },
  pausa: {
    label: 'Pausa cirúrgica — antes da incisão',
    items: {
      equipe: 'Todos os membros da equipe se apresentaram por nome e função',
      confirmacao: 'Cirurgião, anestesista e enfermagem confirmam paciente, sítio e procedimento',
      eventos_criticos: 'Eventos críticos previstos revisados por cirurgião, anestesia e enfermagem',
      antibiotico: 'Antibiótico profilático administrado nos últimos 60 minutos (ou não se aplica)',
      esterilizacao: 'Esterilização dos materiais confirmada, incluindo indicadores',
      imagens: 'Imagens essenciais disponíveis na sala (ou não se aplica)',
    },
  },
  saida: {
    label: 'Saída — antes de o paciente deixar a sala',
    items: {
      procedimento: 'Nome do procedimento realizado registrado',
      contagem: 'Contagem de instrumentais, compressas e agulhas conferida e correta',
      amostras: 'Amostras identificadas com o nome do paciente',
      equipamentos: 'Problemas com equipamentos registrados (ou nenhum)',
      recuperacao: 'Cuidados para a recuperação pós-operatória revisados',
    },
  },
};
const PHASE_ORDER = ['entrada', 'pausa', 'saida'];

function emptyChecklist() {
  const c = {};
  for (const [phase, def] of Object.entries(CHECKLIST)) {
    c[phase] = {
      items: Object.fromEntries(Object.keys(def.items).map((k) => [k, false])),
      completedAt: null,
      completedBy: null,
      completedByName: null,
    };
  }
  return c;
}

const isPhaseComplete = (s, phase) => !!(s.checklist && s.checklist[phase] && s.checklist[phase].completedAt);

/** Minuto absoluto (desde 1970, em horário local "de parede") — evita erros de fuso. */
function absMinutes(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return Date.UTC(y, m - 1, d) / 60000 + hh * 60 + mm;
}

function interval(s) {
  const start = absMinutes(s.date, s.startTime);
  return { start, end: start + s.durationMin };
}

const overlaps = (a, b, gap = 0) => a.start < b.end + gap && b.start < a.end + gap;

function teamOf(s) {
  return new Set([s.surgeonId, s.anesthetistId, ...(s.teamIds || [])].filter(Boolean));
}

/**
 * Procura conflitos de sala, equipe e paciente.
 * Na sala, respeita o tempo de limpeza/preparo entre cirurgias.
 */
function findConflicts(candidate, others, lookup) {
  const conflicts = [];
  const c = interval(candidate);
  const cTeam = teamOf(candidate);
  for (const o of others) {
    if (o.id === candidate.id || !OCCUPYING.includes(o.status)) continue;
    const oi = interval(o);
    const when = `${o.date.split('-').reverse().join('/')} às ${o.startTime}`;
    // Limpeza entre atendimentos só é exigida quando um deles é cirurgia
    const gap = (o.type === 'cirurgia' || candidate.type === 'cirurgia') ? config.roomTurnoverMin : 0;
    if (o.roomId && candidate.roomId && o.roomId === candidate.roomId && overlaps(c, oi, gap)) {
      conflicts.push({
        type: 'sala',
        surgeryId: o.id,
        message: `A sala ${lookup.room(o.roomId)} está ocupada por outro atendimento (${when})${gap ? `, considerando ${gap} min de limpeza` : ''}.`,
      });
    }
    if (overlaps(c, oi)) {
      if (o.patientId === candidate.patientId) {
        conflicts.push({ type: 'paciente', surgeryId: o.id, message: `O paciente já tem outro atendimento neste horário (${when}).` });
      }
      for (const pid of teamOf(o)) {
        if (cTeam.has(pid)) {
          conflicts.push({ type: 'profissional', surgeryId: o.id, message: `${lookup.professional(pid)} já tem outro atendimento neste horário (${when}).` });
        }
      }
    }
  }
  return conflicts;
}

/** Verifica os pré-requisitos de segurança antes de mudar o status. */
function assertTransition(surgery, next, { signatures, reason }) {
  const allowed = TRANSITIONS[surgery.status] || [];
  if (!allowed.includes(next)) {
    throw new HttpError(409, `Não é possível mudar de "${STATUS[surgery.status]}" para "${STATUS[next] || next}".`);
  }
  if ((next === 'cancelada' || next === 'adiada') && !reason) {
    throw new HttpError(422, 'Informe o motivo do cancelamento ou adiamento.', { reason: 'Motivo é obrigatório.' });
  }
  if (surgery.type === 'consulta') return; // consultas não exigem termos nem checklist
  if (next === 'em_andamento') {
    const missing = requiredDocsMissing(surgery, signatures);
    const problems = [];
    if (missing.length) problems.push(`Assinatura pendente: ${missing.map((d) => DOC_TYPES[d]).join(', ')}.`);
    if (!isPhaseComplete(surgery, 'entrada')) problems.push('Checklist de Entrada não concluído.');
    if (problems.length) throw new HttpError(409, 'A cirurgia não pode ser iniciada. ' + problems.join(' '));
  }
  if (next === 'concluida') {
    const problems = [];
    if (!isPhaseComplete(surgery, 'pausa')) problems.push('Checklist de Pausa cirúrgica não concluído.');
    if (!isPhaseComplete(surgery, 'saida')) problems.push('Checklist de Saída não concluído.');
    if (problems.length) throw new HttpError(409, 'A cirurgia não pode ser concluída. ' + problems.join(' '));
  }
}

/** Termos obrigatórios: cirúrgico sempre; anestésico quando há anestesista. */
function requiredDocs(surgery) {
  if (surgery.type === 'consulta') return [];
  const docs = ['termo_cirurgico'];
  if (NEEDS_ANESTHETIST.includes(surgery.anesthesiaType)) docs.push('termo_anestesico');
  if (surgery.needsBloodReserve) docs.push('termo_hemotransfusao');
  return docs;
}

function requiredDocsMissing(surgery, signatures) {
  const signed = new Set(
    signatures
      .filter((s) => s.surgeryId === surgery.id && ['paciente', 'responsavel'].includes(s.signerRole))
      .map((s) => s.docType)
  );
  return requiredDocs(surgery).filter((d) => !signed.has(d));
}

module.exports = {
  TYPES, STATUS, TRANSITIONS, OCCUPYING, ANESTHESIA, NEEDS_ANESTHETIST, LATERALITY, PRIORITY, DOC_TYPES,
  CHECKLIST, PHASE_ORDER, emptyChecklist, isPhaseComplete, absMinutes, interval, findConflicts,
  assertTransition, requiredDocs, requiredDocsMissing,
};

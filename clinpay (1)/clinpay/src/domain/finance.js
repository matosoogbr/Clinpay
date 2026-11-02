'use strict';

/**
 * Financeiro: cobranças e pagamentos.
 * Todos os valores são inteiros em CENTAVOS (ex.: R$ 150,00 = 15000) para evitar
 * erros de arredondamento.
 */

const METHODS = {
  pix: 'PIX',
  dinheiro: 'Dinheiro',
  cartao_credito: 'Cartão de crédito',
  cartao_debito: 'Cartão de débito',
  boleto: 'Boleto',
  transferencia: 'Transferência bancária',
  convenio: 'Convênio',
  outro: 'Outro',
};

const CHARGE_STATUS = {
  aberto: 'Em aberto',
  parcial: 'Pago em parte',
  pago: 'Pago',
  cancelado: 'Cancelado',
};

const activePayments = (c) => (c.payments || []).filter((p) => !p.reversedAt);
const paidCents = (c) => activePayments(c).reduce((s, p) => s + p.amountCents, 0);
const balanceCents = (c) => (c.status === 'cancelado' ? 0 : Math.max(c.amountCents - paidCents(c), 0));

function computeStatus(c) {
  if (c.canceledAt) return 'cancelado';
  const paid = paidCents(c);
  if (paid >= c.amountCents) return 'pago';
  return paid > 0 ? 'parcial' : 'aberto';
}

const EXPENSE_CATEGORIES = {
  laboratorio: 'Laboratório de prótese', materiais: 'Materiais odontológicos', aluguel: 'Aluguel e condomínio',
  salarios: 'Salários e pró-labore', comissoes: 'Comissões e repasses', impostos: 'Impostos e taxas',
  contas: 'Água, luz, telefone e internet', marketing: 'Marketing e anúncios', equipamentos: 'Equipamentos',
  manutencao: 'Manutenção', software: 'Sistemas e software', esterilizacao: 'Esterilização e descartáveis',
  contabilidade: 'Contabilidade', taxas_bancarias: 'Taxas de cartão e bancárias', outros: 'Outras despesas',
};

const brl = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

module.exports = { EXPENSE_CATEGORIES, METHODS, CHARGE_STATUS, activePayments, paidCents, balanceCents, computeStatus, brl };

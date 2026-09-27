'use strict';

// Não chama fraude e não bloqueia. Apenas identifica uma primeira compra por
// cartão que não deixa dados mínimos para rastrear ou defender a entrega.
const CONECTIVOS = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);

function normalizar(v) {
  return String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function tokensNome(tx) {
  return [...new Set([tx?.nomeCliente, tx?.cardHolder]
    .filter(Boolean)
    .flatMap((nome) => normalizar(nome).split(/[^a-z0-9]+/))
    .filter((token) => token.length >= 3 && !CONECTIVOS.has(token)))];
}

function pedidoKey(tx) {
  return String(tx?.merchantReference || tx?.originalReference || tx?.pspReference || '');
}

function ehPrimeiraCompraDesteCartao(tx, transacoes) {
  const final = String(tx?.last4 || '').trim();
  if (!final) return false;
  const pedidos = new Set((transacoes || [])
    .filter((outra) => String(outra?.unidade || '') === String(tx?.unidade || ''))
    .filter((outra) => String(outra?.last4 || '').trim() === final)
    .map(pedidoKey)
    .filter(Boolean));
  return pedidos.size <= 1;
}

function avaliar(tx, transacoes) {
  const metodo = normalizar(tx?.metodo);
  if (tx?.status !== 'APROVADO' || metodo === 'pix' || !tx?.last4) return null;
  const semRastro = !tx.shopperIp && !tx.emailCliente && !tx.telefoneCliente && !tx.enderecoCliente;
  const nomeCurto = tokensNome(tx).length < 2;
  const primeiraCompra = ehPrimeiraCompraDesteCartao(tx, transacoes);
  if (!semRastro || !nomeCurto || !primeiraCompra) return null;
  return { motivo: 'Primeira compra no cartão sem dados mínimos de rastreabilidade (nome incompleto e sem IP, e-mail, telefone ou endereço).' };
}

module.exports = { avaliar, tokensNome, ehPrimeiraCompraDesteCartao };

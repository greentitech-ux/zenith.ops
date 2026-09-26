// Bloqueio operacional para reincidencia aprovada com o MESMO cartao dentro
// de uma identidade que esta trocando nomes. O cardHopping pega o inverso
// (uma pessoa testando varios cartoes); este modulo cobre o caso real da Tirol:
// o mesmo cartao aprovou mais de um pedido, mas comprador/titular apareceram
// com variacoes de nome.
//
// Last4 sozinho nunca basta: quatro digitos colidem. A regra so vale quando a
// malha forte de fraudIdentity ligou os pedidos na MESMA unidade, existem ao
// menos dois pedidos distintos, e o conjunto ja contem tres nomes diferentes.
// Quando a Adyen manda `aliasCartao`, ele e preferido por ser um identificador
// muito melhor que o final do cartao.
// Os dois pedidos confirmados da Tirol ficaram separados por 33 minutos. A
// janela anterior de 30 min deixava exatamente esse caso passar.
const JANELA_MS = 60 * 60 * 1000;
const fraudIdentity = require('./fraudIdentity');

const ocorrencias = new Map(); // chave -> [{ pedidoId, ts }]

function chaveCartao(tx) {
  const alias = String(tx.aliasCartao || '').trim();
  if (alias) return `alias:${alias}`;
  const last4 = String(tx.last4 || '').trim();
  const metodo = String(tx.metodo || '').trim().toLowerCase();
  return last4 ? `${metodo || 'cartao'}:${last4}` : null;
}

function pedidoIdDe(tx) {
  return tx && (tx.merchantReference || tx.originalReference || tx.pspReference);
}

function nomesDistintos(tx) {
  return new Set([tx && tx.nomeCliente, tx && tx.cardHolder]
    .filter(Boolean).map((n) => String(n).trim().toLowerCase()));
}

function nomesRelacionados(a, b) {
  const ta = new Set([
    ...fraudIdentity.tokensSignificativos(a && a.nomeCliente),
    ...fraudIdentity.tokensSignificativos(a && a.cardHolder),
  ]);
  const tb = new Set([
    ...fraudIdentity.tokensSignificativos(b && b.nomeCliente),
    ...fraudIdentity.tokensSignificativos(b && b.cardHolder),
  ]);
  const comuns = [...ta].filter((t) => tb.has(t));
  const uniao = new Set([...ta, ...tb]).size;
  return !!uniao
    && comuns.length / uniao >= fraudIdentity.LIMIAR_SIMILARIDADE
    && comuns.some((t) => !fraudIdentity.TERMOS_COMUNS.has(t));
}

function mesmoCartao(a, b) {
  const aliasA = String((a && a.aliasCartao) || '').trim();
  const aliasB = String((b && b.aliasCartao) || '').trim();
  if (aliasA && aliasB) return aliasA === aliasB;
  return !!(a && b && a.last4 && b.last4)
    && String(a.last4) === String(b.last4)
    && String(a.metodo || '').toLowerCase() === String(b.metodo || '').toLowerCase();
}

function repeticoesNoHistorico(tx, pedidoId, historico, agora) {
  const porPedido = new Map();
  for (const anterior of historico || []) {
    const id = pedidoIdDe(anterior);
    if (!id || id === pedidoId || anterior.status !== 'APROVADO') continue;
    if (String(anterior.unidade || '') !== String(tx.unidade || '')) continue;
    if (!mesmoCartao(tx, anterior) || !nomesRelacionados(tx, anterior)) continue;
    const ts = Date.parse(anterior.dataHora || '');
    if (!Number.isFinite(ts) || Math.abs(agora - ts) >= JANELA_MS) continue;
    porPedido.set(id, anterior);
  }
  return [...porPedido.values()];
}

function registrar(tx, clusterInfo, pedidoId, agora = Date.now(), historico = []) {
  if (!tx || tx.status !== 'APROVADO' || !clusterInfo) return null;
  const cartao = chaveCartao(tx);
  if (!cartao || !pedidoId) return null;

  const chave = `${tx.unidade || ''}:cluster:${clusterInfo.clusterId}:${cartao}`;
  const recentes = (ocorrencias.get(chave) || []).filter((o) => agora - o.ts < JANELA_MS);
  const novoPedido = !recentes.some((o) => o.pedidoId === pedidoId);
  if (novoPedido) recentes.push({ pedidoId, ts: agora });
  ocorrencias.set(chave, recentes);

  if (!novoPedido) return null;

  const anterioresPersistidos = repeticoesNoHistorico(tx, pedidoId, historico, agora);
  const nomes = nomesDistintos(tx);
  anterioresPersistidos.forEach((p) => nomesDistintos(p).forEach((n) => nomes.add(n)));
  const totalPedidos = new Set([...recentes.map((o) => o.pedidoId), ...anterioresPersistidos.map(pedidoIdDe)]).size;
  const clusterForte = clusterInfo.totalPedidos >= 2 && clusterInfo.nomesDistintos >= 3 && recentes.length >= 2;
  const historicoForte = anterioresPersistidos.length >= 1 && nomes.size >= 3;
  if (!clusterForte && !historicoForte) return null;
  return { pedidos: totalPedidos, janelaMinutos: JANELA_MS / 60000, identificadorCartao: cartao };
}

function limparAntigos(agora = Date.now()) {
  for (const [chave, lista] of ocorrencias) {
    const recentes = lista.filter((o) => agora - o.ts < JANELA_MS);
    if (recentes.length) ocorrencias.set(chave, recentes);
    else ocorrencias.delete(chave);
  }
}

const limpeza = setInterval(limparAntigos, 5 * 60 * 1000);
limpeza.unref();

module.exports = { registrar, chaveCartao, nomesRelacionados, mesmoCartao, limparAntigos, JANELA_MS };

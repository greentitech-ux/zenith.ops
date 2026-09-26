// Detecta rajadas de recusas AMEX por unidade. O ataque observado em Tirol
// não repetia o mesmo cartão: eram muitos cartões, o mesmo pedido/preço e
// segundos entre as tentativas. Por isso cardTesting (mesmo cartão) não o
// enxergava.
//
// A regra curta exige o MESMO valor para não confundir três clientes reais
// falhando ao pagar. A regra longa cobre uma automação que varie o valor.
const JANELA_CURTA_MS = 2 * 60 * 1000;
const JANELA_LONGA_MS = 15 * 60 * 1000;
const LIMIAR_CURTO = 3;
const LIMIAR_LONGO = 8;
const RETENCAO_ATAQUE_MS = 30 * 60 * 1000;

const porUnidade = new Map(); // unidade -> [{ ts, valor }]
const ataquesAtivos = new Map(); // unidade -> { ts, tentativas, tipo }

function ehAmex(tx) {
  return /^(amex|american express)$/i.test(String(tx && tx.metodo || '').trim());
}

function chaveUnidade(tx) { return String(tx && tx.unidade || '').trim().toLowerCase(); }
function valorKey(tx) { return Number(tx && tx.valor || 0).toFixed(2); }

function registrarRecusa(tx, agora = Date.now()) {
  if (!tx || tx.status !== 'RECUSADO' || !ehAmex(tx)) return null;
  const unidade = chaveUnidade(tx);
  if (!unidade) return null;

  const eventos = (porUnidade.get(unidade) || []).filter((e) => agora - e.ts < JANELA_LONGA_MS);
  eventos.push({ ts: agora, valor: valorKey(tx) });
  porUnidade.set(unidade, eventos);

  const mesmoValor = eventos.filter((e) => e.valor === valorKey(tx) && agora - e.ts < JANELA_CURTA_MS);
  const tipo = mesmoValor.length === LIMIAR_CURTO ? 'mesmo-valor' : (eventos.length === LIMIAR_LONGO ? 'volume' : null);
  if (!tipo) return null;

  const alerta = {
    tipo,
    tentativas: tipo === 'mesmo-valor' ? mesmoValor.length : eventos.length,
    janelaMinutos: tipo === 'mesmo-valor' ? JANELA_CURTA_MS / 60000 : JANELA_LONGA_MS / 60000,
    valor: Number(tx.valor || 0),
  };
  ataquesAtivos.set(unidade, { ...alerta, ts: agora });
  return alerta;
}

function ataqueAtivo(tx, agora = Date.now()) {
  if (!ehAmex(tx)) return null;
  const atual = ataquesAtivos.get(chaveUnidade(tx));
  if (!atual || agora - atual.ts >= RETENCAO_ATAQUE_MS) return null;
  return { ...atual, retencaoMinutos: RETENCAO_ATAQUE_MS / 60000 };
}

function limparAntigos(agora = Date.now()) {
  for (const [unidade, eventos] of porUnidade) {
    const recentes = eventos.filter((e) => agora - e.ts < JANELA_LONGA_MS);
    if (recentes.length) porUnidade.set(unidade, recentes); else porUnidade.delete(unidade);
  }
  for (const [unidade, ataque] of ataquesAtivos) {
    if (agora - ataque.ts >= RETENCAO_ATAQUE_MS) ataquesAtivos.delete(unidade);
  }
}

const limpeza = setInterval(limparAntigos, 5 * 60 * 1000);
limpeza.unref();

module.exports = {
  registrarRecusa, ataqueAtivo, limparAntigos, ehAmex,
  JANELA_CURTA_MS, JANELA_LONGA_MS, RETENCAO_ATAQUE_MS,
};

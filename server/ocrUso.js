// ocrUso.js
// Quanto custa cada leitura por imagem, medido - nao estimado.
//
// Motivo: o app tem 3 leitores de imagem (relatorio do PDV, nota fiscal do
// Estoque, documento de identidade do RH) e NENHUM deles registrava nada.
// Dava pra ver o total gasto no painel da Anthropic, mas nao QUEM gastou,
// em QUE unidade, nem quantas vezes a mesma pessoa refez a mesma leitura.
// Sem isso, "economizar" vira chute - e chute na leitura do fechamento tem
// o custo de errar um numero que a rede cobra.
//
// O que este modulo faz, e so isso:
//   1. recebe o `usage` que a propria API devolve em cada chamada;
//   2. converte em R$ por uma tabela de preco local;
//   3. acumula por dia (em memoria) e imprime uma linha estruturada no log;
//   4. conta leituras por usuario/dia, pro limite da rota.
//
// NAO grava no Firestore de proposito: seria escrita por leitura de imagem,
// e o §3 do CLAUDE.md e' claro sobre pagar leitura/escrita a toa. O log do
// Render e o resumo em memoria resolvem a pergunta ("onde esta indo o
// dinheiro") sem criar custo novo pra responder.

// Preco por 1 milhao de tokens, em DOLAR, da tabela publica da Anthropic.
// Fica aqui porque a API nao devolve preco - so token. Precisa ser conferida
// quando trocar de modelo (o desempate ja usa Opus 5, que custa 2,5x o
// Sonnet 5 na entrada e 2,5x na saida).
const PRECO_USD_POR_MTOK = {
  'claude-opus-5': { entrada: 5, saida: 25 },
  'claude-sonnet-5': { entrada: 2, saida: 10 },
  'claude-haiku-4-5': { entrada: 1, saida: 5 },
};
// leitura de cache custa ~0,1x a entrada; escrita ~1,25x (TTL de 5 min).
const FATOR_CACHE_LEITURA = 0.1;
const FATOR_CACHE_ESCRITA = 1.25;

// cotacao so pra deixar o numero legivel pra quem decide - o custo real e'
// cobrado em dolar. Configuravel porque o cambio muda e ninguem vai querer
// deploy de codigo pra corrigir isso.
const USD_BRL = Number(process.env.OCR_COTACAO_USD) > 0 ? Number(process.env.OCR_COTACAO_USD) : 5.4;

// Teto de leituras por pessoa por dia. Pedido do Master: "as pessoas ainda
// nao sabem realizar leitura, entao vamos limitar". O numero e' generoso de
// proposito - o proprio sistema manda fazer LEITURAS SEPARADAS quando o
// relatorio e' grande (ver canaisVendaOcr.js), entao 4 ou 5 leituras num dia
// e' uso normal, nao desperdicio. O que este teto pega e' o caso do dedo
// preso: a mesma foto ruim reenviada 20 vezes seguidas.
const LIMITE_DIA_USUARIO = Number(process.env.OCR_LIMITE_DIA_USUARIO) >= 0
  ? Number(process.env.OCR_LIMITE_DIA_USUARIO) : 12;

// { '2026-08-26': { chamadas, tokensEntrada, tokensSaida, custoUsd,
//                   porUsuario: {id: {leituras, chamadas, custoUsd, nome}},
//                   porUnidade: {...}, porFluxo: {...} } }
// So o dia de hoje e o de ontem ficam guardados: o objetivo e' responder
// "quanto gastei hoje", nao virar um banco de series temporais na memoria de
// um processo que o Render reinicia sozinho.
const dias = new Map();

function hojeISO() {
  // Brasilia - o dia operacional da loja, nao o UTC. Um fechamento lancado
  // 22h de sexta nao pode cair no sabado do relatorio.
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function doDia(dia) {
  if (!dias.has(dia)) {
    dias.set(dia, {
      dia, chamadas: 0, leituras: 0, tokensEntrada: 0, tokensSaida: 0, custoUsd: 0,
      porUsuario: {}, porUnidade: {}, porFluxo: {},
    });
    // segura hoje + ontem e descarta o resto
    [...dias.keys()].sort().slice(0, -2).forEach((k) => dias.delete(k));
  }
  return dias.get(dia);
}

function custoDaChamada(modelo, usage) {
  const p = PRECO_USD_POR_MTOK[modelo];
  const u = usage || {};
  const entrada = Number(u.input_tokens) || 0;
  const saida = Number(u.output_tokens) || 0;
  const cacheEscrita = Number(u.cache_creation_input_tokens) || 0;
  const cacheLeitura = Number(u.cache_read_input_tokens) || 0;
  // modelo fora da tabela: conta os tokens, nao inventa preco. Um custo
  // inventado e' pior que custo nenhum - alguem decidiria em cima dele.
  if (!p) return { custoUsd: null, entrada: entrada + cacheEscrita + cacheLeitura, saida };
  const custoUsd = (
    entrada * p.entrada
    + cacheEscrita * p.entrada * FATOR_CACHE_ESCRITA
    + cacheLeitura * p.entrada * FATOR_CACHE_LEITURA
    + saida * p.saida
  ) / 1e6;
  return { custoUsd, entrada: entrada + cacheEscrita + cacheLeitura, saida };
}

// Uma CHAMADA de modelo. A leitura do fechamento faz 2 (ou 3, com desempate)
// por clique, entao chamada != leitura - por isso os dois contadores.
function registrarChamada({ fluxo, modelo, usage, unidade, usuarioId, usuarioEmail, fotos, bytes }) {
  const { custoUsd, entrada, saida } = custoDaChamada(modelo, usage);
  const d = doDia(hojeISO());
  d.chamadas += 1;
  d.tokensEntrada += entrada;
  d.tokensSaida += saida;
  if (custoUsd != null) d.custoUsd += custoUsd;

  const acumular = (mapa, chave, extra) => {
    if (!chave) return;
    const alvo = mapa[chave] || (mapa[chave] = { chamadas: 0, leituras: 0, tokensEntrada: 0, custoUsd: 0, ...extra });
    alvo.chamadas += 1;
    alvo.tokensEntrada += entrada;
    if (custoUsd != null) alvo.custoUsd += custoUsd;
  };
  acumular(d.porUsuario, usuarioId, { email: usuarioEmail || null });
  acumular(d.porUnidade, unidade);
  acumular(d.porFluxo, fluxo);

  // linha estruturada: da pra grepar no log do Render sem abrir nada.
  // Os campos que explicam o custo vem juntos de proposito - "custou caro"
  // sem o tamanho da foto ao lado nao diz o que fazer a respeito.
  console.log(
    '[ocr-uso] fluxo=%s modelo=%s unidade=%s usuario=%s fotos=%s kb=%s tokens_entrada=%s tokens_saida=%s usd=%s brl=%s',
    fluxo, modelo, unidade || '-', usuarioEmail || usuarioId || '-',
    fotos != null ? fotos : '-', bytes != null ? Math.round(bytes / 1024) : '-',
    entrada, saida,
    custoUsd == null ? '?' : custoUsd.toFixed(4),
    custoUsd == null ? '?' : (custoUsd * USD_BRL).toFixed(3),
  );
  return { custoUsd, entrada, saida };
}

// Um CLIQUE do usuario (a leitura inteira, com as chamadas que ela precisar).
// E' isso que o limite conta - limitar por chamada puniria a loja pela
// leitura dupla, que e' decisao nossa, nao dela.
function registrarLeitura({ usuarioId, unidade }) {
  const d = doDia(hojeISO());
  d.leituras += 1;
  if (usuarioId) {
    const alvo = d.porUsuario[usuarioId] || (d.porUsuario[usuarioId] = { chamadas: 0, leituras: 0, tokensEntrada: 0, custoUsd: 0 });
    alvo.leituras += 1;
  }
  if (unidade) {
    const alvo = d.porUnidade[unidade] || (d.porUnidade[unidade] = { chamadas: 0, leituras: 0, tokensEntrada: 0, custoUsd: 0 });
    alvo.leituras += 1;
  }
}

function leiturasDoUsuarioHoje(usuarioId) {
  const d = dias.get(hojeISO());
  return (d && d.porUsuario[usuarioId] && d.porUsuario[usuarioId].leituras) || 0;
}

// Devolve null quando pode seguir, ou a mensagem de recusa. Mensagem no tom
// do §5: o fato e o numero, e o que fazer agora - "limite atingido" sozinho
// deixaria a loja sem fechamento e sem saida.
function motivoDeBloqueio(usuarioId) {
  if (!LIMITE_DIA_USUARIO) return null; // 0 = desligado
  const usadas = leiturasDoUsuarioHoje(usuarioId);
  if (usadas < LIMITE_DIA_USUARIO) return null;
  return `Você já fez ${usadas} leituras por foto hoje (limite ${LIMITE_DIA_USUARIO}). Digite os valores à mão neste lançamento e chame o suporte — repetir a leitura com a mesma foto não muda o resultado.`;
}

function resumoDoDia(dia) {
  const d = dias.get(dia || hojeISO());
  if (!d) return { dia: dia || hojeISO(), chamadas: 0, leituras: 0, tokensEntrada: 0, tokensSaida: 0, custoUsd: 0, custoBrl: 0, porUsuario: {}, porUnidade: {}, porFluxo: {} };
  return { ...d, custoBrl: d.custoUsd * USD_BRL, cotacao: USD_BRL, limiteDiaUsuario: LIMITE_DIA_USUARIO };
}

module.exports = {
  registrarChamada,
  registrarLeitura,
  leiturasDoUsuarioHoje,
  motivoDeBloqueio,
  resumoDoDia,
  custoDaChamada,
  LIMITE_DIA_USUARIO,
  PRECO_USD_POR_MTOK,
};

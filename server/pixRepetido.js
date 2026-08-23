// pixRepetido.js
// Regra do Master pro Pix no Monitor de Transacoes.
//
// Pix NAO leva tag de FRAUDE nem de SUSPEITO pelas regras de cartao. O
// motivo e concreto: as duas deteccoes de cartao nao fazem sentido aqui.
// cardTesting conta recusas do MESMO cartao e cardHopping conta finais de
// cartao DISTINTOS - Pix nao tem cartao, nao tem final, e nao tem
// chargeback pra reverter. O que sobrava marcando Pix era a malha de
// identidade por nome, que so olha nome e por isso nao distingue Pix de
// cartao nenhum - e era ela que enchia o Monitor de tag em cima de Pix.
//
// A UNICA marca que Pix pode receber e SUSPEITO com o motivo "Repetido":
// o mesmo cliente pagando por Pix varias vezes na mesma janela curta. Isso
// e o que a operacao de fato quer olhar num Pix (cobranca duplicada,
// pedido em duplicidade), e reaproveita o criterio que o Monitor ja usa na
// secao "Pedidos repetidos" (monitorReport.js: mesma chave de cliente,
// LIMIAR_REPETIDOS pedidos dentro de JANELA_REPETIDOS_MS).
const JANELA_MS = 30 * 60 * 1000; // = JANELA_REPETIDOS_MS do monitorReport.js
const LIMIAR = 2;                 // = LIMIAR_REPETIDOS do monitorReport.js

// nome que aparece na tag - vocabulario do proprio Monitor, nao inventado
const MOTIVO_REPETIDO = 'Repetido';

const porCliente = new Map(); // chave -> [timestamps]

// Pix chega da Adyen no campo paymentMethod (ver normalize.js -> tx.metodo).
// Cobre tambem as variantes que aparecem no relatorio ("pix", "pix_credit").
function ehPix(tx) {
  return /pix/i.test(String((tx && tx.metodo) || ''));
}

// mesma ideia de chaveClienteIdentificavel() do monitorReport.js, mas sem o
// ramo de cartao: em Pix nao existe last4
function clienteKey(tx) {
  const nome = String(tx.nomeCliente || tx.cardHolder || '').trim().toLowerCase();
  if (!nome) return null;
  return `${tx.unidade || ''}:${nome}`;
}

// registra um Pix aprovado e devolve {repeticoes, janelaMinutos} apenas na
// tentativa EXATA que cruza o limiar - igual cardTesting/cardHopping, pra
// nao repetir a mesma tag a cada Pix seguinte do mesmo cliente
function registrarPix(tx) {
  if (!ehPix(tx)) return null;
  if (tx.status !== 'APROVADO') return null; // "repetido" so faz sentido em pagamento que passou
  const key = clienteKey(tx);
  if (!key) return null;

  const now = Date.now();
  const anteriores = (porCliente.get(key) || []).filter((t) => now - t < JANELA_MS);
  anteriores.push(now);
  porCliente.set(key, anteriores);

  if (anteriores.length === LIMIAR) {
    return { repeticoes: anteriores.length, janelaMinutos: JANELA_MS / 60000 };
  }
  return null;
}

const limpeza = setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of porCliente) {
    const restantes = ts.filter((t) => now - t < JANELA_MS);
    if (restantes.length) porCliente.set(key, restantes);
    else porCliente.delete(key);
  }
}, 5 * 60 * 1000);
limpeza.unref();

module.exports = { ehPix, registrarPix, MOTIVO_REPETIDO, LIMIAR, JANELA_MS };

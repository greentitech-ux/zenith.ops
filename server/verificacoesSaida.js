// verificacoesSaida.js
// Estado de "verificada" (Painel de Saídas) pros itens de detalhesSaidas -
// as "outras saídas" avulsas lançadas dentro do Fechamento (ver
// fechamentosLive.js/sanitizarItens), que NÃO têm id próprio: são um array
// informativo, só {descricao, valor}. Sangria/Depósito já tem id próprio
// (coleção sangrias) e guarda a própria verificação (ver
// sangrias.js/marcarVerificada) - este módulo é só pro outro tipo.
//
// Cada item e referenciado por uma "chave" = `${fechamentoId}::${indice}`.
// Isso e estavel porque detalhesSaidas so recebe item novo no FIM (pedido de
// correcao aprovado, ver fechamentosLive.js/decidirEdicao) e nunca reordena
// nem remove um item existente - o indice de um item ja gravado nao muda.
//
// Colecao separada em vez de gravar dentro do proprio fechamento: o
// documento do fechamento fica imutavel (mesma razao de sangrias.js viver
// em colecao propria), e o estado de conferencia mora ao lado.
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('verificacoesSaidasFechamento');

async function listAllUncached() {
  const snap = await COLLECTION.get();
  return snap.docs.map((d) => d.data());
}
const cache = createCache(listAllUncached, 5 * 60 * 1000);
const listAll = cache.cached;

// mapa {chave: registro} - usado pelo saidasPainel.js pra anexar o estado
// de verificacao em cima da lista de saidas montada a partir dos
// fechamentos (que nao sabem nada sobre verificacao)
async function mapaDeChaves() {
  const out = {};
  (await listAll()).forEach((r) => { out[r.chave] = r; });
  return out;
}

// merge:true nos dois writes de proposito: verificacao e reclassificacao sao
// dois estados INDEPENDENTES do mesmo item, e cada um mexe so no que e' dele.
// Com set() cheio, verificar apagaria a reclassificacao (e vice-versa).
async function marcar(chave, { verificada, porId, porEmail }) {
  if (!chave || typeof chave !== 'string') throw new Error('Chave inválida.');
  const registro = {
    chave,
    verificada: !!verificada,
    verificadaPorId: verificada ? porId : null,
    verificadaPorEmail: verificada ? porEmail : null,
    verificadaEm: verificada ? new Date().toISOString() : null,
  };
  await COLLECTION.doc(chave).set(registro, { merge: true });
  cache.invalidar();
  return registro;
}

// Pedido do Master: a planilha antiga lancava a sangria como uma "outra
// saida" qualquer (descricao com "Sangria"), entao ela cai na coluna errada
// do painel. Em vez de reescrever o fechamento historico (o dado antigo tem
// que continuar legivel exatamente como esta), a reclassificacao mora AQUI,
// ao lado da verificacao: o item continua sendo uma linha do fechamento e so
// a LEITURA do painel passa a trata-lo como Sangria/Deposito.
//
// origem: 'sangria' pra mover, null pra desfazer.
const ORIGENS_MANUAIS = ['sangria'];
async function reclassificar(chave, { origem, porId, porEmail }) {
  if (!chave || typeof chave !== 'string') throw new Error('Chave inválida.');
  if (origem !== null && !ORIGENS_MANUAIS.includes(origem)) throw new Error('Origem inválida.');
  const registro = {
    chave,
    origemManual: origem,
    origemManualPorId: origem ? porId : null,
    origemManualPorEmail: origem ? porEmail : null,
    origemManualEm: origem ? new Date().toISOString() : null,
  };
  await COLLECTION.doc(chave).set(registro, { merge: true });
  cache.invalidar();
  return registro;
}

module.exports = { listAll, mapaDeChaves, marcar, reclassificar, ORIGENS_MANUAIS };

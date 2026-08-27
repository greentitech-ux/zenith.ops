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

// CORRECAO de uma saida que veio da PLANILHA. O fechamento importado vive so
// em memoria (fechamentosData, ver sheetsSync.js) - nao da pra editar o
// documento porque nao existe documento. Em vez de mandar a pessoa corrigir
// na planilha (era o que a rota fazia, e o Master pediu pra funcionar aqui),
// a correcao fica AQUI, ao lado da verificacao e da reclassificacao, e a
// leitura do painel aplica por cima do que veio da planilha.
//
// A planilha continua intacta: ela e' a origem do historico e nao pode ser
// reescrita por nos (CLAUDE.md §1). Se a linha da planilha mudar depois, a
// correcao continua valendo por cima dela - e' o que o Master decidiu que
// vale.
async function corrigirItem(chave, { descricao, valor, porId, porEmail }) {
  if (!chave || typeof chave !== 'string') throw new Error('Chave inválida.');
  const v = Number(valor);
  if (!Number.isFinite(v) || v < 0) throw new Error('Informe um valor válido para a saída.');
  const desc = String(descricao || '').trim().slice(0, 300);
  if (!desc) throw new Error('Descreva a saída.');
  const registro = {
    chave,
    correcao: { descricao: desc, valor: +v.toFixed(2) },
    corrigidoPorId: porId,
    corrigidoPorEmail: porEmail,
    corrigidoEm: new Date().toISOString(),
  };
  await COLLECTION.doc(chave).set(registro, { merge: true });
  cache.invalidar();
  return registro;
}

// ENTRADA em dinheiro corrigida a mao pelo Master/Admin, para o fechamento
// que veio da PLANILHA e por isso nao tem documento no Firestore pra editar
// (mesmo caminho de corrigirItem acima: a planilha fica intacta, a leitura do
// painel passa a mostrar o valor corrigido). Chave: `entrada::${fechamentoId}`.
//
// valor 0 e' o "excluir" da tela - a entrada do dia deixa de existir na
// leitura (listarEntradas descarta valor zero) sem apagar o fechamento, que
// continua com faturamento, saidas e o resto. Por isso 0 e' aceito aqui e
// negativo nao: entrada negativa nao existe na operacao.
async function corrigirEntrada(chave, { valor, porId, porEmail }) {
  if (!chave || typeof chave !== 'string') throw new Error('Chave inválida.');
  const v = Number(valor);
  if (!Number.isFinite(v) || v < 0) throw new Error('Informe um valor válido para a entrada.');
  const registro = {
    chave,
    correcaoEntrada: { valor: +v.toFixed(2) },
    corrigidoPorId: porId,
    corrigidoPorEmail: porEmail,
    corrigidoEm: new Date().toISOString(),
  };
  await COLLECTION.doc(chave).set(registro, { merge: true });
  cache.invalidar();
  return registro;
}

module.exports = { listAll, mapaDeChaves, marcar, reclassificar, corrigirItem, corrigirEntrada, ORIGENS_MANUAIS };

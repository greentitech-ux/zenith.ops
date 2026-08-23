// pedidoWatch.js
// "Vigias" de pedido do Beniboy (suporteBot.js): toda vez que ele responde
// consultar_pedido pra alguem logado, grava aqui qual status a pessoa VIU.
// O webhook da Adyen (index.js) confere esse retrato a cada evento novo do
// mesmo pedido - se o status mudou depois da resposta, a pessoa recebe um
// alerta (SSE se estiver com o NoPulso aberto, push se nao estiver - ver
// verificarAlertaPedido em index.js). Usa o mesmo padrao de cache em memoria
// (createCache) dos outros modulos "live", pra nao adicionar uma leitura de
// Firestore por webhook - foi exatamente esse tipo de leitura repetida que
// causou o RESOURCE_EXHAUSTED que ja derrubou o app uma vez.
const crypto = require('crypto');
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('pedidoWatches');
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias - depois disso o vigia expira sozinho

function docId(pedidoId, userId) {
  return crypto.createHash('sha1').update(`${pedidoId}::${userId}`).digest('hex');
}

// grava (ou atualiza) o retrato "essa pessoa viu o pedido X no status Y" -
// idempotente: uma nova pergunta sobre o mesmo pedido pela mesma pessoa so
// atualiza o statusVisto, nao duplica o vigia
async function registrar({ pedidoId, userId, unidade, statusVisto, chatId }) {
  if (!pedidoId || !userId) return;
  const id = docId(pedidoId, userId);
  await COLLECTION.doc(id).set({
    id,
    pedidoId,
    userId,
    unidade: unidade || null,
    statusVisto: statusVisto || null,
    chatId: chatId || null,
    criadoEm: new Date().toISOString(),
    expiraEm: Date.now() + TTL_MS,
  });
  watchCache.invalidar();
}

// dispara depois do alerta (alerta e "de uso unico" - nao fica repetindo pra
// cada evento seguinte do mesmo pedido)
async function remover(pedidoId, userId) {
  await COLLECTION.doc(docId(pedidoId, userId)).delete();
  watchCache.invalidar();
}

async function listAllUncached() {
  const snap = await COLLECTION.get();
  return snap.docs.map((d) => d.data());
}
const watchCache = createCache(listAllUncached, 30 * 1000);

// quem esta de olho num pedido especifico (ja filtrando vigias vencidos) -
// chamado pelo webhook da Adyen a cada evento processado
async function listarPorPedido(pedidoId) {
  const todos = await watchCache.cached();
  const agora = Date.now();
  return todos.filter((w) => w.pedidoId === pedidoId && w.expiraEm > agora);
}

module.exports = { registrar, remover, listarPorPedido };

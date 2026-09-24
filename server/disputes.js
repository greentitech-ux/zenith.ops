// disputes.js
// Historico de registros por pedido: tanto pedidos que ja viraram chargeback
// (disputa formal com a Adyen) quanto pedidos que ainda nao viraram, mas o
// time quer monitorar de perto (observacoes + evidencias, pra decidir se e
// preciso recorrer caso vire chargeback depois). Cada registro guarda nome e
// telefone de quem foi contatado, observacoes e anexos (foto, print, video,
// audio da ligacao etc.) e um status de acompanhamento. Persistido no
// Firestore, igual ao resto do app.
const db = require('./firestore');
const storage = require('./storage');
const { createCache } = require('./liveCache');
const COLLECTION = db.collection('disputes');


// MONITORANDO: pedido ainda nao e chargeback, so esta sendo acompanhado.
// ABERTA -> ENVIADA -> GANHA/PERDIDA: fluxo da disputa formal do chargeback.
// ERRO_SISTEMA: problema tecnico do nosso lado (ex: cliente tentando comprar
// na loja e o sistema estornando sozinho) - nao e disputa com a bandeira.
// Exibido como "ERRO SISTEMA" (o underscore e so pra classe CSS/valor).
const STATUSES = ['MONITORANDO', 'ABERTA', 'ENVIADA', 'GANHA', 'PERDIDA', 'ERRO_SISTEMA'];

async function create({ pedidoId, unidade, nomeContato, telefoneContato, notas, anexos }) {
  const doc = COLLECTION.doc();
  const agora = new Date().toISOString();
  const registro = {
    id: doc.id,
    pedidoId,
    unidade: unidade || null,
    nomeContato: nomeContato || '',
    telefoneContato: telefoneContato || '',
    notas: notas || '',
    status: 'MONITORANDO',
    anexos: anexos || [], // [{ nome, path, tipo }] - path e a chave no Cloud Storage, tipo e o mimetype
    criadoEm: agora,
    atualizadoEm: agora,
  };
  await doc.set(registro);
  disputesCache.invalidar();
  return registro;
}

async function listAllUncached() {
  const snap = await COLLECTION.orderBy('criadoEm', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const disputesCache = createCache(listAllUncached, 5 * 60 * 1000);
const listAll = disputesCache.cached;


async function listByPedido(pedidoId) {
  const snap = await COLLECTION.where('pedidoId', '==', pedidoId).get();
  return snap.docs.map((d) => d.data()).sort((a, b) => (b.criadoEm || '').localeCompare(a.criadoEm || ''));
}

async function getOne(id) {
  const doc = await COLLECTION.doc(id).get();
  return doc.exists ? doc.data() : null;
}

async function updateStatus(id, status) {
  if (!STATUSES.includes(status)) throw new Error('status invalido');
  await COLLECTION.doc(id).update({ status, atualizadoEm: new Date().toISOString() });
  disputesCache.invalidar();
  return getOne(id);
}

async function remove(id) {
  const registro = await getOne(id);
  if (!registro) return;
  await Promise.all((registro.anexos || []).map((a) => storage.apagarArquivo(a.path)));
  await COLLECTION.doc(id).delete();
  disputesCache.invalidar();
}


// CASO DA ADYEN (defesaChargeback.js): o mesmo registro, aberto sozinho
// pelos eventos de disputa. Id fixo por pedido (`adyen_<pedido>`), então a
// varredura pode rodar quantas vezes quiser sem duplicar. set com merge:
// o que a pessoa escreveu no caso (notas, anexos) não é apagado.
async function salvarCaso(id, patch) {
  const agora = new Date().toISOString();
  await COLLECTION.doc(id).set({ ...patch, id, atualizadoEm: agora }, { merge: true });
  disputesCache.invalidar();
  return getOne(id);
}

// o que o Claude/Cowork registra depois de agir NA Adyen (anexar a defesa
// ou aceitar o chargeback): o NoPulso não fala com a Adyen, então é o
// registro de quem fez, quando e o quê
async function registrarAcao(id, { status, porNome, observacao, campo }) {
  if (!STATUSES.includes(status)) throw new Error('status invalido');
  const caso = await getOne(id);
  if (!caso) throw new Error('Disputa não encontrada.');
  const agora = new Date().toISOString();
  const patch = {
    status, atualizadoEm: agora,
    [campo]: { em: agora, porNome: String(porNome || '').slice(0, 120), observacao: String(observacao || '').slice(0, 1000) },
    historicoAcoes: [...(caso.historicoAcoes || []), { status, em: agora, porNome: String(porNome || '').slice(0, 120), observacao: String(observacao || '').slice(0, 300) }].slice(-30),
  };
  await COLLECTION.doc(id).update(patch);
  disputesCache.invalidar();
  return getOne(id);
}

module.exports = {
  STATUSES, create, listAll, listByPedido, getOne, updateStatus, remove, salvarCaso, registrarAcao,
  invalidar: () => disputesCache.invalidar(),
};

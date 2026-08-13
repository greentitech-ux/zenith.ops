// lojaStatus.js
// Presenca/conectividade por loja: a tela publica atendimento.html, quando
// aberta em modo quiosque numa unidade (?unidade=<codigo>), manda um
// heartbeat periodico pra essa colecao. Se uma unidade para de mandar
// heartbeat por mais tempo que o esperado, e sinal de que a tela/computador
// caiu OU perdeu internet - a varredura periodica (ver rodarVarreduraLojaStatus
// em index.js) detecta essa transicao e avisa Master/Suporte, no mesmo
// espirito de ferramentas de RMM (Atera etc) que o usuario pediu, so que sem
// precisar de um agente instalado - o proprio navegador aberto na loja e o
// "sentinela". NAO GARANTE deteccao 100% (uma aba fechada por engano parece
// igual a uma internet caida), mas cobre o caso real: quiosque sempre ligado,
// silencio prolongado quase sempre significa "algo errado por la".
// Reaproveita esse mesmo documento pra guardar o ID do AnyDesk da unidade
// (acesso remoto rapido, ja que o usuario possui a licenca) e uma mensagem
// pendente que o Master/Suporte quer empurrar pra tela daquela loja - a
// mesma resposta do heartbeat entrega essa mensagem na proxima vez que o
// quiosque perguntar (nao existe canal de push pra visitante anonimo, so
// o polling do proprio heartbeat).
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('lojaStatus');

// heartbeat a cada ~25s (ver atendimento.html) - 90s da margem pra 2
// heartbeats perdidos por jitter de rede antes de considerar offline
const LIMIAR_OFFLINE_MS = 90 * 1000;

function docIdFor(codigo) {
  const limpo = String(codigo || '').trim().replace(/\//g, '_').slice(0, 200);
  if (!limpo) throw new Error('Código da unidade é obrigatório.');
  return limpo;
}

async function listUncached() {
  const snap = await COLLECTION.get();
  return snap.docs.map((d) => d.data());
}
const cache = createCache(listUncached, 10 * 1000);

// registra o heartbeat e devolve a mensagem pendente (se houver), ja
// limpando ela na mesma escrita - entrega "de uso unico", igual ao padrao
// forcarChat que o widget de suporte ja usa pro auto-abrir
async function heartbeat(codigo) {
  const id = docIdFor(codigo);
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  const atual = snap.exists ? snap.data() : null;
  const mensagemPendente = (atual && atual.mensagemPendente) || null;
  await ref.set({
    codigo,
    ultimoHeartbeatEm: Date.now(),
    anydeskId: (atual && atual.anydeskId) || null,
    avisadoOffline: (atual && atual.avisadoOffline) || false,
    offlineDesde: (atual && atual.offlineDesde) || null,
    mensagemPendente: null,
  }, { merge: true });
  cache.invalidar();
  return { mensagemPendente };
}

function comOnline(doc) {
  const online = !!doc.ultimoHeartbeatEm && (Date.now() - doc.ultimoHeartbeatEm) < LIMIAR_OFFLINE_MS;
  return { ...doc, online };
}

async function listar() {
  const docs = await cache.cached();
  return docs.map(comOnline);
}

// Master configura o ID do AnyDesk da unidade pra acesso remoto rapido -
// funciona mesmo se a unidade nunca mandou heartbeat ainda (cadastro
// adiantado), por isso o merge:true cria o documento se precisar
async function definirAnydeskId(codigo, anydeskId) {
  const id = docIdFor(codigo);
  const limpo = String(anydeskId || '').trim().slice(0, 40);
  await COLLECTION.doc(id).set({ codigo, anydeskId: limpo || null }, { merge: true });
  cache.invalidar();
  return { codigo, anydeskId: limpo || null };
}

// fica esperando pro proximo heartbeat dessa unidade entregar (ver
// heartbeat() acima) - nao exige a unidade estar online agora
async function enviarMensagem(codigo, texto, deEmail) {
  const id = docIdFor(codigo);
  const textoLimpo = String(texto || '').trim().slice(0, 500);
  if (!textoLimpo) throw new Error('Escreva a mensagem.');
  await COLLECTION.doc(id).set({
    codigo,
    mensagemPendente: { texto: textoLimpo, deEmail: deEmail || null, em: Date.now() },
  }, { merge: true });
  cache.invalidar();
  return { codigo, texto: textoLimpo };
}

// varredura periodica (ver rodarVarreduraLojaStatus em index.js): detecta
// unidades que ACABARAM de cair (pra avisar uma vez so - nao repete a cada
// tick, controlado por avisadoOffline) e unidades que voltaram - so
// considera unidades que ja mandaram heartbeat alguma vez, senao toda loja
// que nunca configurou o quiosque apareceria como "caida" desde sempre
async function varrerAlertas() {
  const docs = await listUncached();
  const transicoes = [];
  for (const doc of docs) {
    if (!doc.ultimoHeartbeatEm) continue;
    const online = (Date.now() - doc.ultimoHeartbeatEm) < LIMIAR_OFFLINE_MS;
    if (!online && !doc.avisadoOffline) {
      await COLLECTION.doc(docIdFor(doc.codigo)).update({ avisadoOffline: true, offlineDesde: Date.now() });
      transicoes.push({ codigo: doc.codigo, tipo: 'offline' });
    } else if (online && doc.avisadoOffline) {
      await COLLECTION.doc(docIdFor(doc.codigo)).update({ avisadoOffline: false, offlineDesde: null });
      transicoes.push({ codigo: doc.codigo, tipo: 'online' });
    }
  }
  if (transicoes.length) cache.invalidar();
  return transicoes;
}

module.exports = { heartbeat, listar, definirAnydeskId, enviarMensagem, varrerAlertas };

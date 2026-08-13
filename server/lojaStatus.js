// lojaStatus.js
// Presenca/conectividade por COMPUTADOR de cada loja: a tela publica
// atendimento.html, quando aberta em modo quiosque num computador especifico
// (?unidade=<codigo>&posto=<id>), manda um heartbeat periodico pra essa
// colecao. Se um computador para de mandar heartbeat por mais tempo que o
// esperado, e sinal de que a tela/maquina caiu OU perdeu internet - a
// varredura periodica (ver rodarVarreduraLojaStatus em index.js) detecta
// essa transicao e avisa Master/Suporte, no mesmo espirito de ferramentas de
// RMM (Atera etc) que o usuario pediu, so que sem precisar de um agente
// instalado - o proprio navegador aberto na loja e o "sentinela". NAO
// GARANTE deteccao 100% (uma aba fechada por engano parece igual a uma
// internet caida), mas cobre o caso real: quiosque sempre ligado, silencio
// prolongado quase sempre significa "algo errado por la".
//
// Cada unidade pode ter VARIOS computadores cadastrados (pedido explicito do
// usuario: "cada unidade tem varios computadores e eu tenho todos cadastrados
// no Anydesk") - por isso 1 documento por PAR unidade+posto, nao 1 por
// unidade. "posto" e um id curto e estavel gerado no cadastro (cadastrarComputador),
// nunca muda mesmo se o nome for editado depois - e o que entra no link/QR
// code que fica colado/salvo naquele computador especifico. Reaproveita esse
// mesmo documento pra guardar o ID do AnyDesk daquele computador (acesso
// remoto rapido, ja que o usuario possui a licenca) e uma mensagem pendente
// que o Master/Suporte quer empurrar pra ele - a mesma resposta do heartbeat
// entrega essa mensagem na proxima vez que o quiosque perguntar (nao existe
// canal de push pra visitante anonimo, so o polling do proprio heartbeat).
const crypto = require('crypto');
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('lojaStatus');

// heartbeat a cada ~25s (ver atendimento.html) - 90s da margem pra 2
// heartbeats perdidos por jitter de rede antes de considerar offline
const LIMIAR_OFFLINE_MS = 90 * 1000;

function docIdFor(codigo, posto) {
  const limpoCodigo = String(codigo || '').trim().replace(/\//g, '_').slice(0, 200);
  if (!limpoCodigo) throw new Error('Código da unidade é obrigatório.');
  const limpoPosto = String(posto || '').trim().replace(/\//g, '_').slice(0, 60);
  if (!limpoPosto) throw new Error('Computador é obrigatório.');
  return `${limpoCodigo}__${limpoPosto}`;
}

// migra documentos do formato antigo (1 por unidade, docId == codigo, sem
// campo "posto") pro formato novo (1 por unidade+posto) - roda sozinho na
// primeira listagem depois do deploy dessa mudanca, sem precisar de
// intervencao manual. Preserva anydeskId/heartbeat/mensagem ja existentes,
// so passa a chamar esse computador de "Computador 1"
async function migrarLegado(docs) {
  const legados = docs.filter((d) => !d.data().posto);
  if (!legados.length) return false;
  for (const doc of legados) {
    const atual = doc.data();
    await COLLECTION.doc(docIdFor(atual.codigo, 'principal')).set({
      ...atual, posto: 'principal', nome: atual.nome || 'Computador 1',
    }, { merge: true });
    await doc.ref.delete();
  }
  return true;
}

async function listUncached() {
  const snap = await COLLECTION.get();
  const migrou = await migrarLegado(snap.docs);
  if (!migrou) return snap.docs.map((d) => d.data());
  const snap2 = await COLLECTION.get();
  return snap2.docs.map((d) => d.data());
}
const cache = createCache(listUncached, 10 * 1000);

// registra o heartbeat de um computador especifico e devolve a mensagem
// pendente (se houver), ja limpando ela na mesma escrita - entrega "de uso
// unico", igual ao padrao forcarChat que o widget de suporte ja usa pro
// auto-abrir. posto ausente (link antigo, de antes dessa mudanca, ainda nao
// atualizado no navegador da loja) cai no computador "principal" da unidade
async function heartbeat(codigo, posto) {
  const id = docIdFor(codigo, posto || 'principal');
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  const atual = snap.exists ? snap.data() : null;
  const mensagemPendente = (atual && atual.mensagemPendente) || null;
  await ref.set({
    codigo,
    posto: posto || 'principal',
    nome: (atual && atual.nome) || null,
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

// lista achatada, 1 item por computador (varios por unidade) - quem chama
// (index.js/loja-status.html) agrupa por codigo pra exibir por unidade
async function listar() {
  const docs = await cache.cached();
  return docs.map(comOnline);
}

// Master cadastra um novo computador pra uma unidade - gera um id curto e
// estavel (nunca muda, mesmo se o nome for editado depois) que vira parte do
// link/QR code fixado naquele computador (ver POST /api/loja-status/:codigo/
// computadores em index.js, que devolve a URL pronta)
async function cadastrarComputador(codigo, nome) {
  const nomeOk = String(nome || '').trim().slice(0, 60);
  if (!nomeOk) throw new Error('Dê um nome pro computador (ex: Caixa 1, PDV Entrega).');
  const posto = crypto.randomBytes(4).toString('hex');
  const id = docIdFor(codigo, posto);
  const registro = {
    codigo, posto, nome: nomeOk, anydeskId: null,
    ultimoHeartbeatEm: null, avisadoOffline: false, offlineDesde: null, mensagemPendente: null,
  };
  await COLLECTION.doc(id).set(registro);
  cache.invalidar();
  return registro;
}

async function renomearComputador(codigo, posto, nome) {
  const nomeOk = String(nome || '').trim().slice(0, 60);
  if (!nomeOk) throw new Error('Dê um nome pro computador.');
  const id = docIdFor(codigo, posto);
  const snap = await COLLECTION.doc(id).get();
  if (!snap.exists) throw new Error('Computador não encontrado.');
  await COLLECTION.doc(id).update({ nome: nomeOk });
  cache.invalidar();
  return { codigo, posto, nome: nomeOk };
}

async function removerComputador(codigo, posto) {
  const id = docIdFor(codigo, posto);
  await COLLECTION.doc(id).delete();
  cache.invalidar();
  return { codigo, posto };
}

// Master configura o ID do AnyDesk daquele computador pra acesso remoto
// rapido - funciona mesmo se o computador nunca mandou heartbeat ainda, por
// isso o merge:true (nao exige ja existir)
async function definirAnydeskId(codigo, posto, anydeskId) {
  const id = docIdFor(codigo, posto);
  const limpo = String(anydeskId || '').trim().slice(0, 40);
  await COLLECTION.doc(id).set({ codigo, posto, anydeskId: limpo || null }, { merge: true });
  cache.invalidar();
  return { codigo, posto, anydeskId: limpo || null };
}

// fica esperando pro proximo heartbeat DESSE computador entregar (ver
// heartbeat() acima) - nao exige o computador estar online agora
async function enviarMensagem(codigo, posto, texto, deEmail) {
  const id = docIdFor(codigo, posto);
  const textoLimpo = String(texto || '').trim().slice(0, 500);
  if (!textoLimpo) throw new Error('Escreva a mensagem.');
  await COLLECTION.doc(id).set({
    codigo, posto,
    mensagemPendente: { texto: textoLimpo, deEmail: deEmail || null, em: Date.now() },
  }, { merge: true });
  cache.invalidar();
  return { codigo, posto, texto: textoLimpo };
}

// varredura periodica (ver rodarVarreduraLojaStatus em index.js): detecta
// computadores que ACABARAM de cair (pra avisar uma vez so - nao repete a
// cada tick, controlado por avisadoOffline) e os que voltaram - so
// considera computadores que ja mandaram heartbeat alguma vez, senao todo
// computador cadastrado mas ainda nao aberto no navegador da loja apareceria
// como "caido" desde sempre
async function varrerAlertas() {
  const docs = await listUncached();
  const transicoes = [];
  for (const doc of docs) {
    if (!doc.ultimoHeartbeatEm) continue;
    const online = (Date.now() - doc.ultimoHeartbeatEm) < LIMIAR_OFFLINE_MS;
    if (!online && !doc.avisadoOffline) {
      await COLLECTION.doc(docIdFor(doc.codigo, doc.posto)).update({ avisadoOffline: true, offlineDesde: Date.now() });
      transicoes.push({ codigo: doc.codigo, posto: doc.posto, nome: doc.nome, tipo: 'offline' });
    } else if (online && doc.avisadoOffline) {
      await COLLECTION.doc(docIdFor(doc.codigo, doc.posto)).update({ avisadoOffline: false, offlineDesde: null });
      transicoes.push({ codigo: doc.codigo, posto: doc.posto, nome: doc.nome, tipo: 'online' });
    }
  }
  if (transicoes.length) cache.invalidar();
  return transicoes;
}

module.exports = {
  heartbeat, listar, cadastrarComputador, renomearComputador, removerComputador,
  definirAnydeskId, enviarMensagem, varrerAlertas,
};

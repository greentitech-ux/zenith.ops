// alertasCentral.js
// Log central de TODOS os alertas que o sistema dispara (NOC Zenith, Beniboy,
// seguranca do chat, QA, RH, fraude/estorno...) - existe pra dar uma CENTRAL
// DE ALERTAS de verdade (pedido explicito do usuario: "crie se preciso uma
// central de alertas que mostre qual o alerta e o que e"), separada do push
// efemero que some se ninguem estiver com o celular na mao bem na hora. Cada
// chamador de push.js registra aqui tambem (ver push.js) - a lista fica
// disponivel em /central-alertas.html mesmo que o push tenha falhado/nao
// tocado, ou que a pessoa so va olhar horas depois.
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('alertasCentral');

const LIMITE = 300;

const listUncached = async () => {
  const snap = await COLLECTION.orderBy('criadoEm', 'desc').limit(LIMITE).get();
  return snap.docs.map((d) => d.data());
};
// TTL alto de proposito: esta lista completa e paga so na ABERTURA da tela
// (e quando a aba volta a ficar visivel). O polling de 15s usa listarDesde()
// abaixo, que custa ~1 leitura. Antes disso o TTL era 8s, MENOR que o
// intervalo do polling - ou seja, o cache nunca acertava e cada poll relia os
// 300 documentos: 240 polls/hora x 300 = 72.000 leituras/hora POR ABA aberta,
// a causa principal do salto de custo de agosto/2026.
const cache = createCache(listUncached, 60 * 1000);

async function listar() {
  return cache.cached();
}

// Leitura INCREMENTAL: so os alertas criados depois do mais recente que a tela
// ja tem. Consulta com desigualdade e ordenacao no MESMO campo (criadoEm), que
// o Firestore resolve com o indice de campo unico - nao precisa de indice
// composto. Quase sempre nao acha nada e custa 1 leitura (o minimo cobrado),
// em vez dos 300 documentos da lista inteira.
//
// Cache de uma posicao so (nao um Map): todas as abas convergem pro MESMO
// "desde" - o criadoEm do alerta mais novo - entao uma entrada cobre todo
// mundo, e a chave nao acumula lixo com o passar dos dias.
let incremental = { desde: null, valor: null, expiraEm: 0 };

async function listarDesde(desde) {
  const chave = String(desde || '');
  if (!chave) return listar();
  const agora = Date.now();
  if (incremental.desde === chave && agora < incremental.expiraEm) return incremental.valor;
  const snap = await COLLECTION.where('criadoEm', '>', chave).orderBy('criadoEm', 'desc').limit(LIMITE).get();
  const valor = snap.docs.map((d) => d.data());
  incremental = { desde: chave, valor, expiraEm: Date.now() + 8 * 1000 };
  return valor;
}

function invalidarIncremental() { incremental = { desde: null, valor: null, expiraEm: 0 }; }

// tipo identifica a categoria (ex: 'noc-offline', 'noc-acesso-remoto',
// 'beniboy', 'seguranca', 'qa-aprovacao', 'rh', 'fraude'...) - usado pro
// icone/cor na tela. critico decide se essa categoria toca o alarme cheio
// (sirene) no navegador com uma aba aberta, alem do vibrate mais forte no
// push (ver dispararAlarme em suporte-chat.js e sw.js)
async function registrar({ tipo, titulo, resumo, url, critico }) {
  const id = COLLECTION.doc().id;
  const registro = {
    id, tipo, titulo, resumo: resumo || null, url: url || '/', critico: !!critico,
    criadoEm: new Date().toISOString(),
    atendidoEm: null, atendidoPorEmail: null,
  };
  await COLLECTION.doc(id).set(registro);
  cache.invalidar();
  invalidarIncremental();
  return registro;
}

async function atender(id, porEmail) {
  const ref = COLLECTION.doc(id);
  const patch = { atendidoEm: new Date().toISOString(), atendidoPorEmail: porEmail || null };
  try {
    await ref.update(patch);
  } catch (err) {
    // update() em documento inexistente e o unico erro esperado aqui
    if (err.code === 5 || /NOT_FOUND|No document to update/i.test(err.message || '')) return null;
    throw err;
  }
  cache.invalidar();
  invalidarIncremental();
  // 1 leitura (o proprio documento) em vez de reler os 300 da lista inteira -
  // e isso rodava a CADA clique em "sinalizar que vi"
  const snap = await ref.get();
  return snap.exists ? snap.data() : null;
}

module.exports = { listar, listarDesde, registrar, atender };

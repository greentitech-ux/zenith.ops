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

const listUncached = async () => {
  const snap = await COLLECTION.orderBy('criadoEm', 'desc').limit(300).get();
  return snap.docs.map((d) => d.data());
};
// cache curto (mesmo espirito dos outros modulos "live") - a tela faz
// polling a cada alguns segundos pra ficar perto de tempo real sem bater
// direto no Firestore a cada request
const cache = createCache(listUncached, 8 * 1000);

async function listar() {
  return cache.cached();
}

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
  return registro;
}

async function atender(id, porEmail) {
  await COLLECTION.doc(id).update({ atendidoEm: new Date().toISOString(), atendidoPorEmail: porEmail || null });
  cache.invalidar();
  const atual = await listar();
  return atual.find((a) => a.id === id) || null;
}

module.exports = { listar, registrar, atender };

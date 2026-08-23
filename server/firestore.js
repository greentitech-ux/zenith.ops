// firestore.js
// Conexao com o Cloud Firestore (Firebase) - persiste dados fora do disco local,
// para nao perder historico quando o servidor reinicia/redeploya (ex: no Render).
// firebase-admin 14 aposentou a API "namespaced" (admin.firestore(),
// admin.credential.cert...) - agora cada pedaço sai do seu submódulo
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

if (!getApps().length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (process.env.FIRESTORE_EMULATOR_HOST) {
    // EMULADOR LOCAL: o SDK fala com o Firestore que roda na propria maquina.
    // Sem credencial, sem tocar no banco de producao e sem gerar UMA leitura
    // cobrada - e o caminho pra testar de verdade antes de subir (ver
    // server/DESENVOLVIMENTO.md). O firebase-admin le essa variavel sozinho;
    // aqui so dispensamos a exigencia de credencial, que no emulador nao ha.
    initializeApp({ projectId: projectId || 'zenith-local' });
    console.log(`[firestore] EMULADOR LOCAL em ${process.env.FIRESTORE_EMULATOR_HOST} - producao NAO sera tocada.`);
  } else if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'Credenciais do Firebase ausentes. Configure FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL e FIREBASE_PRIVATE_KEY (veja server/.env.example).'
    );
  } else {
    initializeApp({
      credential: cert({ projectId, clientEmail, privateKey }),
    });
  }
}

const db = getFirestore();

// ---------------------------------------------------------------------------
// Contador de LEITURAS (diagnostico de custo do Firestore)
// ---------------------------------------------------------------------------
// O console do Firebase so mostra o total da conta - nao diz QUAL colecao nem
// QUAL rota gastou. Sem isso, toda otimizacao vira chute (foi exatamente o que
// aconteceu quando a fatura pulou pra R$24/dia em 18/08/2026). Aqui a gente
// embrulha o .get() do proprio SDK e conta os documentos devolvidos, separando
// por colecao e por rota HTTP.
//
// Duas regras de cobranca que o contador respeita de proposito:
//   - o Firestore cobra 1 leitura por DOCUMENTO devolvido;
//   - uma consulta que nao acha NADA ainda custa 1 leitura (por isso o max(1)).
//
// A atribuicao por rota usa AsyncLocalStorage (nao um contador antes/depois no
// middleware): com varias requisicoes em voo ao mesmo tempo, o diff simples
// atribuiria a leitura de uma rota pra outra. O ALS carrega o contexto junto
// com a cadeia de await, entao cada leitura cai na rota certa mesmo sob
// concorrencia.
//
// TODO o bloco e best-effort: qualquer falha aqui e engolida. Contador que
// derruba leitura de producao seria pior que a fatura que ele veio medir.
const { AsyncLocalStorage } = require('async_hooks');

const contextoRota = new AsyncLocalStorage();

const LEITURAS = {
  desde: Date.now(),
  total: 0,
  porColecao: new Map(), // nome -> { docs, consultas }
  porRota: new Map(),    // "GET /api/x" -> { docs, consultas }
};

function acumular(mapa, chave, docs) {
  const atual = mapa.get(chave) || { docs: 0, consultas: 0 };
  atual.docs += docs;
  atual.consultas += 1;
  mapa.set(chave, atual);
}

function contar(colecao, docs) {
  LEITURAS.total += docs;
  acumular(LEITURAS.porColecao, colecao || 'desconhecida', docs);
  const ctx = contextoRota.getStore();
  acumular(LEITURAS.porRota, (ctx && ctx.rota) || 'fora de rota (job/boot)', docs);
}

// nome da colecao a partir do objeto em que .get() foi chamado. CollectionReference
// e DocumentReference tem .path publico; Query so expoe o collectionId por
// caminho interno - por isso os fallbacks encadeados.
function colecaoDe(alvo) {
  try {
    if (alvo && typeof alvo.path === 'string') return alvo.path.split('/')[0];
    if (alvo && alvo.parent && typeof alvo.parent.path === 'string') return alvo.parent.path.split('/')[0];
    if (alvo && alvo._queryOptions && alvo._queryOptions.collectionId) return alvo._queryOptions.collectionId;
  } catch (e) { /* best-effort */ }
  return 'desconhecida';
}

// So embrulha o get() que o proprio prototipo DEFINE. CollectionReference herda
// de Query: embrulhar os dois sem esse teste contaria a mesma leitura 2x.
function instrumentar(prototipo) {
  if (!prototipo || !Object.prototype.hasOwnProperty.call(prototipo, 'get')) return;
  const original = prototipo.get;
  if (typeof original !== 'function' || original.__zenithContado) return;
  function get(...args) {
    const resultado = original.apply(this, args);
    if (!resultado || typeof resultado.then !== 'function') return resultado;
    const alvo = this;
    return resultado.then((snap) => {
      try {
        const docs = snap && Array.isArray(snap.docs) ? snap.docs.length : 1;
        contar(colecaoDe(alvo), Math.max(docs, 1));
      } catch (e) { /* best-effort */ }
      return snap;
    });
  }
  get.__zenithContado = true;
  prototipo.get = get;
}

try {
  const colecaoExemplo = db.collection('__zenith_instrumentacao__');
  const protoColecao = Object.getPrototypeOf(colecaoExemplo);
  instrumentar(protoColecao);                          // CollectionReference
  instrumentar(Object.getPrototypeOf(protoColecao));   // Query
  instrumentar(Object.getPrototypeOf(colecaoExemplo.doc('x'))); // DocumentReference
} catch (e) {
  console.warn('[firestore] contador de leituras nao pode ser instalado:', e.message);
}

// snapshot ordenado do maior gasto pro menor - e o que a rota de diagnostico
// (GET /api/debug/leituras, so Master) devolve
function relatorioLeituras() {
  const ordenar = (mapa) => [...mapa.entries()]
    .map(([nome, v]) => ({ nome, docs: v.docs, consultas: v.consultas }))
    .sort((a, b) => b.docs - a.docs);
  const minutos = (Date.now() - LEITURAS.desde) / 60000;
  return {
    desde: new Date(LEITURAS.desde).toISOString(),
    minutos: Math.round(minutos * 10) / 10,
    total: LEITURAS.total,
    porHora: minutos > 0 ? Math.round(LEITURAS.total / minutos * 60) : 0,
    porColecao: ordenar(LEITURAS.porColecao),
    porRota: ordenar(LEITURAS.porRota),
  };
}

function zerarLeituras() {
  LEITURAS.desde = Date.now();
  LEITURAS.total = 0;
  LEITURAS.porColecao.clear();
  LEITURAS.porRota.clear();
}

db.relatorioLeituras = relatorioLeituras;
db.zerarLeituras = zerarLeituras;
db.contextoRota = contextoRota;

module.exports = db;

// unidades.js
// Unidades (lojas) cadastradas pelo Master em runtime, por cima das listas
// fixas de index.js (FECHAMENTO_UNIDADES_NOMES etc). As fixas continuam
// existindo porque carregam codigos historicos de sistemas externos (Adyen,
// planilhas) que nao podem mudar; esta colecao cobre o resto: loja nova
// abrindo, unidade administrativa (escritorio), qualquer lugar que precise
// aparecer nos seletores (RH, Central, permissoes...) sem esperar deploy.
// O codigo vira o proprio identificador gravado nos documentos (igual as
// fixas), entao ele NUNCA muda depois de criado - so o nome de exibicao.
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('unidadesExtras');

async function listUncached() {
  const snap = await COLLECTION.orderBy('nome', 'asc').get();
  return snap.docs.map((d) => d.data());
}
const cache = createCache(listUncached, 5 * 60 * 1000);
const listAll = cache.cached;

// mapa {codigo: nome} pronto pra mesclar nos UNIDADES_NOMES das paginas e
// no construirUnidadesMapa de index.js
async function mapa() {
  const out = {};
  (await listAll()).forEach((u) => { out[u.codigo] = u.nome; });
  return out;
}

// "codigosReservados" vem de index.js (uniao das listas fixas) - um codigo
// que ja existe fixo nao pode ser recadastrado aqui, senao viravam duas
// fontes de verdade pro mesmo lugar
async function criar({ codigo, nome, porEmail }, codigosReservados) {
  const nomeLimpo = String(nome || '').trim().slice(0, 60);
  if (!nomeLimpo) throw new Error('Informe o nome da unidade.');
  const codigoLimpo = String(codigo || nomeLimpo).trim().slice(0, 60);
  if (!codigoLimpo) throw new Error('Informe o código da unidade.');
  if (codigosReservados && codigosReservados.has(codigoLimpo)) {
    throw new Error('Esse código já existe nas unidades fixas do sistema.');
  }
  const existentes = await listAll();
  if (existentes.some((u) => u.codigo === codigoLimpo)) {
    throw new Error('Já existe uma unidade cadastrada com esse código.');
  }
  const ref = COLLECTION.doc();
  const registro = {
    id: ref.id,
    codigo: codigoLimpo,
    nome: nomeLimpo,
    criadoPorEmail: porEmail || null,
    criadoEm: new Date().toISOString(),
  };
  await ref.set(registro);
  cache.invalidar();
  return registro;
}

// so o NOME e editavel - o codigo e identidade (ja pode estar gravado em
// funcionarios do RH, permissoes de usuario, fechamentos...)
async function atualizar(id, { nome }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Unidade não encontrada.');
  const nomeLimpo = String(nome || '').trim().slice(0, 60);
  if (!nomeLimpo) throw new Error('Informe o nome da unidade.');
  await ref.update({ nome: nomeLimpo, atualizadoEm: new Date().toISOString() });
  cache.invalidar();
  return { ...snap.data(), nome: nomeLimpo };
}

async function remover(id) {
  const snap = await COLLECTION.doc(id).get();
  if (!snap.exists) throw new Error('Unidade não encontrada.');
  await COLLECTION.doc(id).delete();
  cache.invalidar();
  return snap.data();
}

module.exports = { listAll, mapa, criar, atualizar, remover, invalidar: () => cache.invalidar() };

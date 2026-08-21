// empresas.js
// Camada de ISOLAMENTO entre empresas donas de unidades - o Zenith vai
// hospedar mais de uma empresa, cada uma com seu próprio tipo de negócio
// (hoje só "alimentacao"; amanhã uma clínica, uma escola...). Uma unidade
// pertence a EXATAMENTE uma empresa, e essa é a fronteira que nunca deve
// vazar: usuário de uma empresa não pode ver dado de outra (ver
// empresasDoUsuario em auth.js), exceto o time de suporte, que atravessa
// tudo de propósito (ver ehTimeSuporte).
//
// Mesmo padrão de grupos.js (array de códigos de unidade no doc da
// empresa, sem campo de volta na unidade - grupoDaUnidade já prova que
// isso funciona bem aqui). A diferença que importa: toda unidade PRECISA
// cair em alguma empresa, então uma delas é a "padrao" (hoje: MVPar) -
// pega qualquer código que não esteja explicitamente listado em outra
// empresa. Isso evita o defeito que o comentário de redes.js já descreve
// (loja nova sem rede definida sumindo de tudo sem ninguém perceber):
// aqui, loja nova cai na empresa padrão automaticamente, e o Master só
// precisa agir se ela for de uma empresa DIFERENTE da padrão.
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('empresas');

// extensível - Fase A só usa 'alimentacao' (o negócio de hoje: franquias
// de comida). Vertical nova (ex: 'saude' pra uma clínica, 'educacao' pra
// uma escola) entra aqui quando a empresa dela for cadastrada de verdade,
// não antes - ver SECTION_VERTICAIS em users.js, que usa esse mesmo valor
// pra filtrar quais seções/itens de menu fazem sentido pra cada empresa.
const TIPOS_NEGOCIO_VALIDOS = new Set(['alimentacao']);

function sanitizarTipoNegocio(v) {
  const limpo = String(v || '').trim();
  return TIPOS_NEGOCIO_VALIDOS.has(limpo) ? limpo : 'alimentacao';
}

async function listUncached() {
  const snap = await COLLECTION.orderBy('nome', 'asc').get();
  return snap.docs.map((d) => d.data());
}
const empresasCache = createCache(listUncached, 5 * 60 * 1000);
const list = empresasCache.cached;

async function create({ nome, tipoNegocio, unidades, padrao }) {
  const nomeLimpo = String(nome || '').trim();
  if (!nomeLimpo) throw new Error('Informe o nome da empresa.');
  const todas = await list();
  // só uma empresa padrão por vez - virar padrão tira o título de quem
  // era antes, senão empresaDaUnidade fica ambíguo (mais de um "resto")
  if (padrao === true) {
    await Promise.all(todas.filter((e) => e.padrao).map((e) => COLLECTION.doc(e.id).update({ padrao: false })));
  }
  const ref = COLLECTION.doc();
  const registro = {
    id: ref.id,
    nome: nomeLimpo,
    tipoNegocio: sanitizarTipoNegocio(tipoNegocio),
    unidades: Array.isArray(unidades) ? unidades.map(String) : [],
    padrao: padrao === true,
    criadoEm: new Date().toISOString(),
  };
  await ref.set(registro);
  empresasCache.invalidar();
  return registro;
}

async function update(id, { nome, tipoNegocio, unidades, padrao }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Empresa não encontrada.');
  const patch = {};
  if (nome != null) {
    const nomeLimpo = String(nome).trim();
    if (!nomeLimpo) throw new Error('Informe o nome da empresa.');
    patch.nome = nomeLimpo;
  }
  if (tipoNegocio != null) patch.tipoNegocio = sanitizarTipoNegocio(tipoNegocio);
  if (unidades != null) patch.unidades = Array.isArray(unidades) ? unidades.map(String) : [];
  if (padrao === true) {
    const todas = await list();
    await Promise.all(todas.filter((e) => e.padrao && e.id !== id).map((e) => COLLECTION.doc(e.id).update({ padrao: false })));
    patch.padrao = true;
  } else if (padrao === false) {
    patch.padrao = false;
  }
  await ref.update(patch);
  empresasCache.invalidar();
  return { ...snap.data(), ...patch };
}

async function remove(id) {
  await COLLECTION.doc(id).delete();
  empresasCache.invalidar();
}

// empresa dona de um código de unidade: primeiro tenta achar quem lista
// esse código explicitamente; se ninguém listar, cai na empresa marcada
// como padrão (ou null, se nenhuma empresa existe ainda / nenhuma é
// padrão - ex: banco de teste vazio).
async function empresaDaUnidade(unidade) {
  const empresas = await list();
  const explicita = empresas.find((e) => (e.unidades || []).includes(unidade));
  if (explicita) return explicita;
  return empresas.find((e) => e.padrao) || null;
}

// bootstrap idempotente (chamado no boot, ver index.js): garante que
// existem as 2 empresas de hoje - MVPar (padrão: pega toda unidade que
// não for Arcfood, igual GBE em redes.js) e Arcfood (lista fechada, só
// os 4 códigos que já existem também em redes.CODIGOS_ARCFOOD no domínio
// do Fechamento). Só cria se AINDA não existir nenhuma empresa marcada
// como padrão - não sobrescreve nada que o Master já tenha editado depois.
async function ensureEmpresasSeed() {
  const todas = await list();
  if (todas.some((e) => e.padrao)) return;
  await create({ nome: 'MVPar', tipoNegocio: 'alimentacao', unidades: [], padrao: true });
  await create({
    nome: 'Arcfood', tipoNegocio: 'alimentacao',
    unidades: ['19821', '19855', '19888', '19889'],
    padrao: false,
  });
}

module.exports = {
  TIPOS_NEGOCIO_VALIDOS, list, create, update, remove,
  empresaDaUnidade, ensureEmpresasSeed, invalidarCache: empresasCache.invalidar,
};

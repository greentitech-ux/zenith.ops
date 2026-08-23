// empresas.js
// Camada de ISOLAMENTO entre as empresas donas de unidades - o NoPulso
// hospeda mais de uma empresa, cada uma com seu tipo de negócio (hoje só
// "alimentacao"; amanhã uma clínica, uma escola...). Uma unidade pertence
// a NO MÁXIMO uma empresa, e essa é a fronteira que não pode vazar:
// usuário de uma empresa não vê dado de outra - nem o Admin dela, que
// manda dentro da própria empresa e só (ver escopoDeUnidades em auth.js).
// A única exceção é o time de suporte, que atravessa tudo de propósito
// (ver ehTimeSuporte em auth.js).
//
// Mesmo padrão de grupos.js: array de códigos no doc da empresa, sem campo
// de volta na unidade. A diferença que importa vem de uma decisão explícita
// do Master: NÃO existe empresa "padrão"/catch-all. Toda unidade precisa
// ser escolhida a dedo pra entrar numa empresa. Unidade que ninguém listou
// não pertence a ninguém - some pra todo mundo menos Master e suporte, até
// alguém decidir de quem ela é. É o oposto do que redes.js faz (lá "GBE é o
// resto"), e é de propósito: aqui, entrar no GBE por engano é pior do que
// ficar de fora esperando alguém reparar.
//
// Sobre os códigos: a MESMA loja física aparece com código diferente em
// cada espaço de dados (Fechamento "19888", Adyen/Monitor "DOM___19888" e
// "Mooca", Entregas "Dominos Bessa"...). Como esta lista é o que filtra o
// que cada empresa enxerga, ela precisa dos códigos de TODOS os espaços -
// senão o Admin abre o Monitor e não vê transação nenhuma. Mesmo motivo da
// CODIGOS_ARCFOOD em redes.js ter as duas famílias de código.
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

// ---------------------------------------------------------------------
// Semente das 2 empresas de hoje. Só vale pro PRIMEIRO boot (e pra migrar
// o seed antigo, ver ensureEmpresasSeed) - depois disso quem manda é o que
// o Master editou na tela de Grupos, e nada aqui sobrescreve aquilo.
// ---------------------------------------------------------------------

// Arcfood: as 4 Domino's de São Paulo. Códigos do Fechamento + como as
// MESMAS lojas chegam da Adyen (é o mesmo conjunto de CODIGOS_ARCFOOD em
// redes.js - se entrar loja Arcfood nova, os dois lugares mudam juntos).
const UNIDADES_ARCFOOD = [
  '19821', '19855', '19888', '19889',
  'Sao Miguel', 'Carrao', 'Mooca', 'Tatuape',
  'DOM__19821', 'DOM__19855', 'DOM___19888', 'DOM_19889',
];

// GBE (Grupo Bravo Empresarial): as Domino's do Nordeste, as Spoleto, a
// São Braz, a Milky Moo e o Saltiverso, mais a unidade Administrativa.
// Escolhidas uma a uma, de propósito: o Master pediu que loja nova NÃO
// caia aqui sozinha.
const UNIDADES_GBE = [
  // Fechamento
  "Domino's Carrinho Aeroporto Recife",
  'Dominos Bessa',
  'Dominos Campina Grande',
  'Dominos Caruaru',
  'Dominos Garanhuns',
  'Dominos Praça Aeroporto Recife',
  'Dominos Tirol',
  'Milky Moo Tirol',
  'Spoleto Praça Aeroporto Recife',
  'Spoleto Shopping Recife',
  'Spoleto Shopping Tacaruna',
  'São Braz IL',
  'Spo Shop Midway',
  'Saltiverso Patteo',
  'Administrativa',
  // Adyen/Monitor (mesma loja, merchantAccountCode)
  'DOM_19798', 'Caruaru',
  'DOM19911', 'Garanhuns',
  'DOM_19706', 'Bessa',
  'DOM_19633',
  'DOM19940',
];

async function listUncached() {
  const snap = await COLLECTION.orderBy('nome', 'asc').get();
  return snap.docs.map((d) => d.data());
}
const empresasCache = createCache(listUncached, 5 * 60 * 1000);
const list = empresasCache.cached;

async function create({ nome, tipoNegocio, unidades }) {
  const nomeLimpo = String(nome || '').trim();
  if (!nomeLimpo) throw new Error('Informe o nome da empresa.');
  const ref = COLLECTION.doc();
  const registro = {
    id: ref.id,
    nome: nomeLimpo,
    tipoNegocio: sanitizarTipoNegocio(tipoNegocio),
    unidades: Array.isArray(unidades) ? unidades.map(String) : [],
    criadoEm: new Date().toISOString(),
  };
  await ref.set(registro);
  empresasCache.invalidar();
  return registro;
}

async function update(id, { nome, tipoNegocio, unidades }) {
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
  await ref.update(patch);
  empresasCache.invalidar();
  return { ...snap.data(), ...patch };
}

async function remove(id) {
  await COLLECTION.doc(id).delete();
  empresasCache.invalidar();
}

// ARQUIVAR: a saída reversível, e a que o Master deve preferir. A empresa
// para de existir pra todo efeito prático - deixa de ser dona das unidades
// dela (elas viram "sem empresa": só Master e suporte enxergam) e quem
// estiver vinculado a ela fica sem enxergar nada, até ser movido pra outra
// empresa. O que ela NÃO faz é apagar o registro: o nome, a lista de
// unidades e o vínculo dos acessos continuam gravados, então desarquivar
// devolve tudo exatamente como estava. É por isso que arquivar é o caminho
// certo pra "essa empresa saiu do grupo" e excluir é só pra cadastro que
// nunca deveria ter existido.
async function arquivar(id, { porEmail } = {}) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Empresa não encontrada.');
  const patch = {
    arquivada: true,
    arquivadaEm: new Date().toISOString(),
    arquivadaPorEmail: porEmail || null,
  };
  await ref.update(patch);
  empresasCache.invalidar();
  return { ...snap.data(), ...patch };
}

async function desarquivar(id) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Empresa não encontrada.');
  const patch = { arquivada: false, arquivadaEm: null, arquivadaPorEmail: null };
  await ref.update(patch);
  empresasCache.invalidar();
  return { ...snap.data(), ...patch };
}

// só as que valem pra decidir quem enxerga o quê. A tela de gestão continua
// usando list() (precisa mostrar a arquivada pra dar pra desarquivar); todo
// o resto do sistema passa por aqui, e é isso que faz o arquivamento ter
// efeito de verdade em vez de ser só um rótulo na tela.
async function listAtivas() {
  return (await list()).filter((e) => !e.arquivada);
}

// empresa dona de um código de unidade, ou null se ninguém listou esse
// código. null NÃO é erro nem "cai no padrão": é uma unidade que ainda não
// tem dono, e que por isso só aparece pro Master e pro suporte. Empresa
// arquivada não conta como dona - as unidades dela voltam pro limbo.
async function empresaDaUnidade(unidade) {
  const codigo = String(unidade == null ? '' : unidade).trim();
  if (!codigo) return null;
  const empresas = await listAtivas();
  return empresas.find((e) => (e.unidades || []).includes(codigo)) || null;
}

// todos os códigos de unidade de uma empresa (é o que limita o que o Admin
// dela enxerga - ver escopoDeUnidades em auth.js). Empresa inexistente,
// arquivada ou sem unidade devolve [], nunca null: nos três casos o certo
// é não mostrar nada.
async function unidadesDaEmpresa(empresaId) {
  if (!empresaId) return [];
  const empresas = await listAtivas();
  const empresa = empresas.find((e) => e.id === empresaId);
  return empresa ? (empresa.unidades || []).slice() : [];
}

// bootstrap idempotente (chamado no boot, ver index.js). Dois casos:
//
// 1. banco novo/vazio: cria GBE e Arcfood já com as unidades listadas.
// 2. banco que rodou a versão anterior deste arquivo: lá existia uma
//    empresa "MVPar" marcada como padrão (catch-all) - o Master corrigiu
//    depois que viu na tela: MVPar é uma das empresas DENTRO do GBE, não o
//    nome do grupo, e catch-all era justamente o que ele não queria. Aqui
//    ela é renomeada pra GBE, ganha a lista explícita e perde o padrao.
//
// Fora esses dois casos não mexe em nada: empresa que o Master já editou
// (ou criou do zero) fica como está.
async function ensureEmpresasSeed() {
  const todas = await list();

  const antigaPadrao = todas.find((e) => e.padrao === true);
  if (antigaPadrao) {
    await COLLECTION.doc(antigaPadrao.id).update({
      nome: antigaPadrao.nome === 'MVPar' ? 'GBE' : antigaPadrao.nome,
      unidades: (antigaPadrao.unidades || []).length ? antigaPadrao.unidades : UNIDADES_GBE,
      padrao: false,
    });
    empresasCache.invalidar();
  } else if (!todas.length) {
    await create({ nome: 'GBE', tipoNegocio: 'alimentacao', unidades: UNIDADES_GBE });
  }

  // Arcfood: cria se não existir, e completa a lista se ela tiver ficado
  // só com os 4 códigos do Fechamento (era assim na versão anterior, antes
  // de a lista virar o filtro de visibilidade e precisar dos códigos da
  // Adyen também).
  const atuais = await list();
  const arcfood = atuais.find((e) => e.nome === 'Arcfood');
  if (!arcfood) {
    await create({ nome: 'Arcfood', tipoNegocio: 'alimentacao', unidades: UNIDADES_ARCFOOD });
  } else if ((arcfood.unidades || []).length < UNIDADES_ARCFOOD.length) {
    const completa = [...new Set([...(arcfood.unidades || []), ...UNIDADES_ARCFOOD])];
    await COLLECTION.doc(arcfood.id).update({ unidades: completa });
    empresasCache.invalidar();
  }
}

module.exports = {
  TIPOS_NEGOCIO_VALIDOS, UNIDADES_GBE, UNIDADES_ARCFOOD,
  list, listAtivas, create, update, remove, arquivar, desarquivar,
  empresaDaUnidade, unidadesDaEmpresa, ensureEmpresasSeed,
  invalidarCache: empresasCache.invalidar,
};

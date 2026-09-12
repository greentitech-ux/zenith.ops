// ativosTI.js
// Inventario de ATIVOS DE TI das lojas (monitores, CPUs, pin pads,
// impressoras, e o rack: roteador, switch, DVR, cameras...). Funciona por
// VISTORIA: o tecnico que vai a loja (secao 'ativos-ti', concedida pelo
// Master) registra o que encontrou, organizado em AREAS (ex: "Loja" e
// "Rack"), cada area com itens de descricao + quantidade + observacao
// ("confirmar", numero de serie...). O inventario ATUAL de uma loja e a
// vistoria mais recente; as anteriores ficam como historico - da pra ver o
// que mudou entre visitas.
//
// Seed: os levantamentos ja feitos pelo time (Anderson, 02/07/2026) entram
// como primeira vistoria das 3 lojas, com as duvidas anotadas na observacao.
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('ativosTI');
// pedidos de correcao do inventario (mesmo desenho da fila de correcao de
// fechamento, ver fechamentosLive.solicitarEdicao): o tecnico que esteve na
// loja PEDE, o Master decide. Status do proprio vocabulario ja usado no app:
// PENDENTE / APROVADO / REJEITADO.
const EDICOES = db.collection('ativosTIEdicoes');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

function sanitizarAreas(areas) {
  if (!Array.isArray(areas)) return [];
  return areas.slice(0, 10).map((a) => ({
    nome: String(a?.nome || '').trim().slice(0, 60) || 'Loja',
    itens: (Array.isArray(a?.itens) ? a.itens : []).slice(0, 60)
      .map((i) => ({
        descricao: String(i?.descricao || '').trim().slice(0, 120),
        quantidade: num(i?.quantidade),
        observacao: String(i?.observacao || '').trim().slice(0, 200),
      }))
      .filter((i) => i.descricao),
  })).filter((a) => a.itens.length);
}

async function criar({ unidade, unidadeNome, areas, observacao, criadoPorEmail, criadoPorNome }) {
  if (!unidade) throw new Error('Escolha a loja.');
  const areasLimpas = sanitizarAreas(areas);
  if (!areasLimpas.length) throw new Error('Registre ao menos um ativo.');
  const doc = COLLECTION.doc();
  const registro = {
    id: doc.id,
    unidade,
    unidadeNome: unidadeNome || unidade,
    areas: areasLimpas,
    observacao: String(observacao || '').trim().slice(0, 500),
    totalAtivos: areasLimpas.reduce((t, a) => t + a.itens.reduce((s, i) => s + i.quantidade, 0), 0),
    criadoPorEmail: criadoPorEmail || null,
    criadoPorNome: criadoPorNome || null,
    criadoEm: new Date().toISOString(),
  };
  await doc.set(registro);
  cache.invalidar();
  return registro;
}

// achata as areas em "Area · Ativo" -> quantidade, pra comparar duas versoes
// do inventario item a item (e o que vira o "de -> para" do pedido e a linha
// do historico da vistoria)
function achatar(areas) {
  const mapa = new Map();
  (areas || []).forEach((a) => (a.itens || []).forEach((i) => {
    mapa.set(`${a.nome} · ${i.descricao}`, i.quantidade);
  }));
  return mapa;
}

// o que mudou entre o inventario atual e o proposto: item somado, item
// tirado, quantidade diferente. Sem isso o Master aprovaria um pedido sem
// saber o que exatamente muda.
function diferencas(areasAntes, areasDepois) {
  const antes = achatar(areasAntes);
  const depois = achatar(areasDepois);
  const linhas = [];
  for (const [chave, qtd] of depois) {
    if (!antes.has(chave)) linhas.push({ item: chave, de: null, para: qtd, tipo: 'adicionado' });
    else if (antes.get(chave) !== qtd) linhas.push({ item: chave, de: antes.get(chave), para: qtd, tipo: 'quantidade' });
  }
  for (const [chave, qtd] of antes) {
    if (!depois.has(chave)) linhas.push({ item: chave, de: qtd, para: null, tipo: 'removido' });
  }
  return linhas;
}

function totalDe(areas) {
  return areas.reduce((t, a) => t + a.itens.reduce((sm, i) => sm + i.quantidade, 0), 0);
}

// EDITA a vistoria no lugar (nao cria outra): e assim que se soma ou tira um
// ativo do inventario ATUAL sem inventar uma visita que nao aconteceu. Cada
// edicao deixa linha no historico do proprio documento - quem mexeu, quando,
// por que e o que mudou.
async function editar(id, { areas, observacao, motivo, editadoPorEmail, editadoPorNome }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Vistoria não encontrada.');
  const atual = snap.data();
  const areasLimpas = sanitizarAreas(areas);
  if (!areasLimpas.length) throw new Error('Registre ao menos um ativo.');
  const mudancas = diferencas(atual.areas, areasLimpas);
  const agora = new Date().toISOString();
  const patch = {
    areas: areasLimpas,
    totalAtivos: totalDe(areasLimpas),
    observacao: observacao === undefined ? (atual.observacao || '') : String(observacao || '').trim().slice(0, 500),
    historico: [...(atual.historico || []), {
      em: agora,
      porEmail: editadoPorEmail || null,
      porNome: editadoPorNome || null,
      motivo: String(motivo || '').trim().slice(0, 300) || null,
      mudancas,
    }].slice(-30),
    atualizadoEm: agora,
  };
  await ref.update(patch);
  cache.invalidar();
  return { ...atual, ...patch };
}

// ---- pedidos de correcao (tecnico pede, Master decide) ----
async function solicitarEdicao({ vistoriaId, areas, observacao, motivo, solicitadoPorId, solicitadoPorEmail, solicitadoPorNome }) {
  const snap = await COLLECTION.doc(vistoriaId).get();
  if (!snap.exists) throw new Error('Vistoria não encontrada.');
  if (!motivo || !String(motivo).trim()) throw new Error('Descreva o motivo da correção.');
  const atual = snap.data();
  const areasLimpas = sanitizarAreas(areas);
  if (!areasLimpas.length) throw new Error('Registre ao menos um ativo.');
  const mudancas = diferencas(atual.areas, areasLimpas);
  if (!mudancas.length) throw new Error('Nada mudou em relação ao inventário atual.');
  const pendentes = (await listarEdicoes()).filter((e) => e.vistoriaId === vistoriaId && e.status === 'PENDENTE');
  if (pendentes.length) throw new Error('Já existe um pedido de correção pendente para essa vistoria - espere a decisão do Master.');
  const doc = EDICOES.doc();
  const registro = {
    id: doc.id,
    vistoriaId,
    unidade: atual.unidade,
    unidadeNome: atual.unidadeNome || atual.unidade,
    areas: areasLimpas,
    observacao: String(observacao || '').trim().slice(0, 500),
    mudancas,
    motivo: String(motivo).trim().slice(0, 300),
    status: 'PENDENTE',
    solicitadoPorId: solicitadoPorId || null,
    solicitadoPorEmail: solicitadoPorEmail || null,
    solicitadoPorNome: solicitadoPorNome || null,
    criadoEm: new Date().toISOString(),
  };
  await doc.set(registro);
  cacheEdicoes.invalidar();
  return registro;
}

async function decidirEdicao(id, status, { decididoPorEmail, motivoDecisao } = {}) {
  if (!['APROVADO', 'REJEITADO'].includes(status)) throw new Error('Status inválido.');
  const ref = EDICOES.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Pedido não encontrado.');
  const pedido = snap.data();
  if (pedido.status !== 'PENDENTE') throw new Error('Esse pedido já foi decidido.');
  const patch = {
    status,
    motivoDecisao: String(motivoDecisao || '').trim().slice(0, 300) || null,
    decididoPorEmail: decididoPorEmail || null,
    decididoEm: new Date().toISOString(),
  };
  // aprovar APLICA a correcao na vistoria - a fila nunca guarda dado que a
  // tela ja mostra como valendo
  if (status === 'APROVADO') {
    await editar(pedido.vistoriaId, {
      areas: pedido.areas,
      observacao: pedido.observacao,
      motivo: `Correção aprovada (pedido de ${pedido.solicitadoPorNome || pedido.solicitadoPorEmail || '—'}): ${pedido.motivo}`,
      editadoPorEmail: decididoPorEmail,
      editadoPorNome: pedido.solicitadoPorNome || null,
    });
  }
  await ref.update(patch);
  cacheEdicoes.invalidar();
  return { ...pedido, ...patch };
}

async function remover(id) {
  const doc = await COLLECTION.doc(id).get();
  if (!doc.exists) throw new Error('Vistoria não encontrada.');
  await COLLECTION.doc(id).delete();
  cache.invalidar();
}

// vistorias iniciais: levantamento do Anderson em 02/07/2026 (WhatsApp) -
// "4 vou" e "1 suite" eram digitacao por voz de "4 CPU" e "1 switch"
const SEED = [
  {
    unidade: 'Spoleto Shopping Tacaruna', unidadeNome: 'Spoleto Tacaruna',
    areas: [
      { nome: 'Loja', itens: [
        { descricao: 'Monitor', quantidade: 3, observacao: '' },
        { descricao: 'CPU montada', quantidade: 3, observacao: '' },
        { descricao: 'Pin pad', quantidade: 2, observacao: '' },
        { descricao: 'Impressora térmica', quantidade: 2, observacao: '' },
        { descricao: 'Impressora jato de tinta', quantidade: 1, observacao: '' },
      ] },
      { nome: 'Rack', itens: [
        { descricao: 'CPU', quantidade: 2, observacao: '' },
        { descricao: 'Roteador', quantidade: 1, observacao: '' },
        { descricao: 'Switch', quantidade: 1, observacao: '' },
        { descricao: 'DVR', quantidade: 1, observacao: '' },
        { descricao: 'Câmeras', quantidade: 0, observacao: 'quantidade a confirmar' },
      ] },
    ],
  },
  {
    unidade: 'Spoleto Praça Aeroporto Recife', unidadeNome: "Spoleto/Domino's Aeroporto",
    areas: [
      { nome: 'Loja', itens: [
        { descricao: 'TV', quantidade: 6, observacao: '' },
        { descricao: 'Monitor', quantidade: 6, observacao: '' },
        { descricao: 'CPU', quantidade: 6, observacao: '' },
        { descricao: 'Pin pad', quantidade: 5, observacao: '' },
        { descricao: 'Impressora jato de tinta', quantidade: 2, observacao: '' },
        { descricao: 'Impressora térmica', quantidade: 3, observacao: '' },
        { descricao: 'Impressora de etiqueta', quantidade: 1, observacao: '' },
        { descricao: 'Totem', quantidade: 3, observacao: '' },
      ] },
      { nome: 'Rack', itens: [
        { descricao: 'CPU', quantidade: 4, observacao: 'anotado como "4 vou" na vistoria - confirmar' },
        { descricao: 'Roteador', quantidade: 1, observacao: '' },
        { descricao: 'Switch', quantidade: 1, observacao: 'anotado como "1 suite" na vistoria - confirmar' },
        { descricao: 'Wi-Fi (access point)', quantidade: 2, observacao: '' },
        { descricao: 'Estabilizador/Nobreak', quantidade: 1, observacao: '' },
      ] },
    ],
  },
  {
    unidade: 'São Braz IL', unidadeNome: 'São Brás Ilha do Leite',
    areas: [
      { nome: 'Loja', itens: [
        { descricao: 'Monitor', quantidade: 1, observacao: '' },
        { descricao: 'CPU', quantidade: 1, observacao: '' },
        { descricao: 'Notebook', quantidade: 1, observacao: '' },
        { descricao: 'Wi-Fi Intelbras', quantidade: 1, observacao: '' },
        { descricao: 'Impressora térmica', quantidade: 1, observacao: '' },
        { descricao: 'Pin pad', quantidade: 1, observacao: '' },
      ] },
      { nome: 'Rack', itens: [
        { descricao: 'DVR', quantidade: 1, observacao: '' },
        { descricao: 'Modem/Roteador', quantidade: 2, observacao: '' },
        { descricao: 'Câmeras', quantidade: 8, observacao: 'confirmar' },
      ] },
    ],
  },
];

const maisRecentePrimeiro = (a, b) => String(b.criadoEm || '').localeCompare(String(a.criadoEm || ''));

async function listAllUncached() {
  const snap = await COLLECTION.orderBy('criadoEm', 'desc').get();
  let itens = snap.docs.map((d) => d.data()).sort(maisRecentePrimeiro);
  if (!itens.length) {
    for (const v of SEED) {
      const doc = COLLECTION.doc();
      const areas = sanitizarAreas(v.areas);
      await doc.set({
        id: doc.id,
        unidade: v.unidade,
        unidadeNome: v.unidadeNome,
        areas,
        observacao: 'Vistoria inicial importada do levantamento de 02/07/2026 (Anderson).',
        totalAtivos: areas.reduce((t, a) => t + a.itens.reduce((s, i) => s + i.quantidade, 0), 0),
        criadoPorEmail: null,
        criadoPorNome: 'Anderson (levantamento 02/07/2026)',
        criadoEm: '2026-07-02T15:08:00.000Z',
      });
    }
    const snap2 = await COLLECTION.orderBy('criadoEm', 'desc').get();
    itens = snap2.docs.map((d) => d.data()).sort(maisRecentePrimeiro);
  }
  return itens;
}
const cache = createCache(listAllUncached, 5 * 60 * 1000);
const listAll = cache.cached;

async function listarEdicoesUncached() {
  const snap = await EDICOES.orderBy('criadoEm', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const cacheEdicoes = createCache(listarEdicoesUncached, 60 * 1000);
const listarEdicoes = cacheEdicoes.cached;

module.exports = { criar, editar, remover, listAll, diferencas, solicitarEdicao, listarEdicoes, decidirEdicao };

// saltiversoFechamento.js
// Fechamento de caixa DEDICADO do Saltiverso Patteo - diferente do
// fechamentosLive.js usado pelas lojas (que carrega campos de loja de
// comida sem sentido aqui: delivery/ifood/99food/etc.), mas reaproveita o
// MESMO conceito: um documento por unidade+data, "Faturado" calculado
// automaticamente a partir do que já foi vendido no sistema, "Total
// Declarado" digitado manualmente por quem fecha o caixa (conferindo os
// comprovantes físicos de maquininha/dinheiro/Pix - Saltiverso não tem
// maquininha integrada a esse app, então não dá pra puxar isso sozinho), e
// o mesmo ticket automático de "Quebra de caixa" (reaproveita o TIPO já
// existente em solicitacoes.js, não cria um novo) quando a diferença passa
// de um limite.
const db = require('./firestore');
const { createCache } = require('./liveCache');
const parque = require('./parque');
const saltiversoVendas = require('./saltiversoVendas');
const solicitacoes = require('./solicitacoes');

const COLLECTION = db.collection('saltiversoFechamentos');

// mesmo valor de LIMITE_QUEBRA_CAIXA (fechamentosLive.js), mas constante
// PROPRIA - escalas de faturamento bem diferentes entre loja de comida e
// balcão de parque, melhor poder ajustar cada um sem acoplar os dois
const LIMITE_QUEBRA_SALTIVERSO = 10;
const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;

// os 4 "baldes" que o usuário descreveu como os comprovantes reais do fim
// do dia: maquininha (débito+crédito juntos, o que a maquininha imprime),
// dinheiro, pix (PixOnlineCNPJ) e outros (voucher/demais formas). O Faturado
// automático é reagrupado nesses MESMOS 4 baldes (ver bucketsDoResumo) pra
// comparar lado a lado com o que foi digitado manualmente
const BUCKETS = ['maquininha', 'dinheiro', 'pix', 'outros'];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function arred(v) {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}
function docId(unidade, data) {
  return `${unidade}__${data}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

// reagrupa o breakdown fino (dinheiro/pix/debito/credito/voucher, ver
// parque.resumoDoDia/saltiversoVendas.resumoDoDia) nos 4 baldes do
// fechamento
function bucketsDoResumo(resumo) {
  const pf = (resumo && resumo.porForma) || {};
  return {
    maquininha: arred(num(pf.debito) + num(pf.credito)),
    dinheiro: arred(num(pf.dinheiro)),
    pix: arred(num(pf.pix)),
    outros: arred(num(pf.voucher)),
  };
}

// Faturado = soma do que já está registrado no sistema pro dia (entradas do
// parque + vendas de bebida/meia), tanto no total quanto por balde - é o
// lado "automático" da comparação, nunca digitado
async function calcularFaturado(unidade, data) {
  const [parqueResumo, vendasResumo] = await Promise.all([
    parque.resumoDoDia(unidade, data),
    saltiversoVendas.resumoDoDia(unidade, data),
  ]);
  const parqueBuckets = bucketsDoResumo(parqueResumo);
  const vendasBuckets = bucketsDoResumo(vendasResumo);
  const faturadoPorForma = {};
  BUCKETS.forEach((b) => { faturadoPorForma[b] = arred(parqueBuckets[b] + vendasBuckets[b]); });
  return {
    faturado: arred(parqueResumo.total + vendasResumo.total),
    faturadoPorForma,
    detalhe: { parque: parqueResumo, vendas: vendasResumo },
  };
}

function sanitizarTotalDeclarado(obj) {
  const out = {};
  BUCKETS.forEach((b) => { out[b] = arred(Math.max(0, num(obj && obj[b]))); });
  return out;
}

async function criarCardQuebra(registro) {
  return solicitacoes.create({
    tipo: 'quebra-caixa',
    unidade: registro.unidade,
    unidadeNome: registro.unidadeNome,
    titulo: `Quebra de caixa · ${registro.unidadeNome} (${registro.data}) · diferença de R$${registro.diferenca.toFixed(2)}`,
    valorEstimado: registro.diferenca,
    observacao: registro.observacao || 'Diferença detectada automaticamente no fechamento do Saltiverso.',
    fechamentoId: registro.id,
    criadoPorId: registro.criadoPorId,
    criadoPorEmail: registro.criadoPorEmail,
    direcionadoParaId: null,
    direcionadoParaEmail: null,
  });
}

async function fecharDia({ unidade, unidadeNome, data, totalDeclarado, observacao, criadoPorId, criadoPorEmail }) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  if (!data || !DATA_RE.test(data)) throw new Error('Data inválida.');
  const id = docId(unidade, data);
  const ref = COLLECTION.doc(id);
  const existente = await ref.get();
  if (existente.exists) {
    throw new Error('Esse dia já foi fechado para essa unidade. Peça uma correção em vez de fechar de novo.');
  }

  const { faturado, faturadoPorForma, detalhe } = await calcularFaturado(unidade, data);
  const totalDeclaradoOk = sanitizarTotalDeclarado(totalDeclarado);
  const somaTotalDeclarado = arred(BUCKETS.reduce((s, b) => s + totalDeclaradoOk[b], 0));
  const diferenca = arred(somaTotalDeclarado - faturado);

  const agora = new Date().toISOString();
  const registro = {
    id, unidade, unidadeNome: unidadeNome || unidade, data,
    faturado, faturadoPorForma, detalhe,
    totalDeclarado: totalDeclaradoOk, somaTotalDeclarado, diferenca,
    observacao: observacao ? String(observacao).trim().slice(0, 500) : null,
    historico: [],
    criadoPorId, criadoPorEmail, criadoEm: agora, atualizadoEm: agora,
  };
  await ref.set(registro);
  fechamentosCache.invalidar();

  // ticket automatico de Quebra de caixa quando a diferenca passa do limite
  // - falha aqui NAO derruba o fechamento em si (mesmo padrao de
  // fechamentosLive.create())
  let cardQuebraCaixa = null;
  if (Math.abs(diferenca) > LIMITE_QUEBRA_SALTIVERSO) {
    try {
      cardQuebraCaixa = await criarCardQuebra(registro);
    } catch (err) {
      console.error(`[saltiversoFechamento] falha ao criar ticket de quebra de caixa (${id}):`, err.message);
    }
  }
  return { ...registro, cardQuebraCaixa };
}

// correção Master-only: so mexe em totalDeclarado/observacao (faturado
// fica travado no que foi calculado na hora do fechamento - reabrir o
// calculo automatico dias depois inflaria/desinflaria vendas que já foram
// corrigidas/canceladas por outros motivos, sem relacao com ESSA correcao).
// Guarda o "antes" no historico[], mesmo espirito do historico de
// fechamentosLive.js
async function corrigirFechamento(id, { totalDeclarado, observacao }, { porId, porEmail }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Fechamento não encontrado.');
  const atual = snap.data();

  const patch = {};
  const antes = {};
  if (totalDeclarado !== undefined) {
    antes.totalDeclarado = atual.totalDeclarado;
    antes.diferenca = atual.diferenca;
    patch.totalDeclarado = sanitizarTotalDeclarado(totalDeclarado);
    patch.somaTotalDeclarado = arred(BUCKETS.reduce((s, b) => s + patch.totalDeclarado[b], 0));
    patch.diferenca = arred(patch.somaTotalDeclarado - atual.faturado);
  }
  if (observacao !== undefined) {
    antes.observacao = atual.observacao;
    patch.observacao = observacao ? String(observacao).trim().slice(0, 500) : null;
  }
  if (!Object.keys(patch).length) throw new Error('Nada para corrigir.');

  patch.historico = [...(atual.historico || []), { antes, em: new Date().toISOString(), porId: porId || null, porEmail: porEmail || null }];
  patch.atualizadoEm = new Date().toISOString();
  await ref.update(patch);
  fechamentosCache.invalidar();

  const atualizado = await getOne(id);
  let cardQuebraCaixa = null;
  if (patch.diferenca !== undefined && Math.abs(patch.diferenca) > LIMITE_QUEBRA_SALTIVERSO) {
    // idempotente: so cria se ainda nao existe ticket de quebra-caixa pra
    // esse fechamentoId (evita duplicar a cada correcao pequena)
    const jaExiste = (await solicitacoes.listAll()).some((s) => s.tipo === 'quebra-caixa' && s.fechamentoId === id);
    if (!jaExiste) {
      try {
        cardQuebraCaixa = await criarCardQuebra(atualizado);
      } catch (err) {
        console.error(`[saltiversoFechamento] falha ao criar ticket de quebra de caixa na correção (${id}):`, err.message);
      }
    }
  }
  return { ...atualizado, cardQuebraCaixa };
}

async function getOne(id) {
  const doc = await COLLECTION.doc(id).get();
  return doc.exists ? doc.data() : null;
}

// preview (dia ainda nao fechado) ou o fechamento ja lancado, pra tela de
// fechamento mostrar o Faturado ao vivo antes de confirmar
async function previewOuFechado(unidade, data) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  if (!data || !DATA_RE.test(data)) throw new Error('Data inválida.');
  const existente = await getOne(docId(unidade, data));
  if (existente) return { fechado: true, ...existente };
  const { faturado, faturadoPorForma, detalhe } = await calcularFaturado(unidade, data);
  return { fechado: false, unidade, data, faturado, faturadoPorForma, detalhe };
}

async function listFechamentosUncached() {
  const snap = await COLLECTION.orderBy('data', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const fechamentosCache = createCache(listFechamentosUncached, 5 * 60 * 1000);
const listAllCached = fechamentosCache.cached;

async function listFechamentos(unidade, dataInicio, dataFim) {
  const todos = await listAllCached();
  return todos.filter((f) => f.unidade === unidade
    && (!dataInicio || f.data >= dataInicio)
    && (!dataFim || f.data <= dataFim));
}

module.exports = {
  LIMITE_QUEBRA_SALTIVERSO,
  calcularFaturado, fecharDia, corrigirFechamento, getOne, previewOuFechado, listFechamentos,
};

// sangrias.js
// Sangrias (retiradas de caixa) registradas em campo - normalmente por quem
// visita as lojas ao longo do dia, ANTES do fechamento do dia ser lançado.
// Fica numa coleção separada, e só é mesclada com o fechamento do dia na
// hora da leitura (mesma lógica usada pra juntar as sangrias que vêm do
// AppSheet, em sheetsSync.js/mesclarLancamentosDoMesmoDia) - porque na hora
// que a sangria é registrada pode ainda não existir nenhum fechamento pra
// aquele dia.
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('sangrias');


function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function validarPeriodo(periodoInicio, periodoFim) {
  if (!periodoInicio || !/^\d{4}-\d{2}-\d{2}$/.test(periodoInicio)) throw new Error('Informe a data inicial do período do depósito.');
  if (!periodoFim || !/^\d{4}-\d{2}-\d{2}$/.test(periodoFim)) throw new Error('Informe a data final do período do depósito.');
  if (periodoFim < periodoInicio) throw new Error('A data final do período não pode ser anterior à data inicial.');
  return { periodoInicio, periodoFim };
}

function validarNomeDepositante(nomeDepositante) {
  const nome = String(nomeDepositante || '').trim();
  if (!nome) throw new Error('Informe o nome de quem depositou.');
  return nome.slice(0, 120);
}

// Diferenca que a operacao ignora - centavo de arredondamento nao e' furo de
// caixa. Acima disso o motivo passa a ser OBRIGATORIO.
const TOLERANCIA_DIVERGENCIA = Number(process.env.SANGRIA_TOLERANCIA_DIVERGENCIA) >= 0
  ? Number(process.env.SANGRIA_TOLERANCIA_DIVERGENCIA)
  : 2;

// esperado vem de fora (saidasPainel.calcularSaldoCaixa, chamado pela rota):
// este modulo nao pode requerer o saidasPainel, que ja requer este aqui.
// A REGRA mora aqui, junto das outras validacoes da sangria; so o numero e'
// que vem do chamador.
//
// divergencia > 0 = retirou MAIS do que o sistema conhece (tipico quando o
// fechamento do dia ainda nao foi lancado); < 0 = faltou dinheiro.
function avaliarDivergencia({ valor, esperado, motivoDivergencia }) {
  if (esperado == null || !Number.isFinite(Number(esperado))) return null;
  const dif = Number((num(valor) - Number(esperado)).toFixed(2));
  const motivo = String(motivoDivergencia || '').trim().slice(0, 300);
  if (Math.abs(dif) > TOLERANCIA_DIVERGENCIA && !motivo) {
    throw new Error(`Diferença de ${dif < 0 ? 'falta' : 'sobra'} de R$ ${Math.abs(dif).toFixed(2).replace('.', ',')} no caixa. Informe o motivo da divergência para salvar.`);
  }
  return { esperado: Number(Number(esperado).toFixed(2)), divergencia: dif, motivoDivergencia: motivo || null };
}

async function criar({ unidade, unidadeNome, grupo, data, valor, descricao, periodoInicio, periodoFim, nomeDepositante, esperado, motivoDivergencia, diasSemFechamento, criadoPorId, criadoPorEmail }) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new Error('Data inválida.');
  const v = num(valor);
  if (v <= 0) throw new Error('Informe o valor retirado.');
  const periodo = validarPeriodo(periodoInicio, periodoFim);
  const nome = validarNomeDepositante(nomeDepositante);
  const caixa = avaliarDivergencia({ valor: v, esperado, motivoDivergencia });

  const ref = COLLECTION.doc();
  const registro = {
    id: ref.id,
    unidade,
    unidadeNome: unidadeNome || unidade,
    grupo: grupo || 'MANUAL',
    data,
    valor: v,
    descricao: (descricao || '').slice(0, 300),
    periodoInicio: periodo.periodoInicio,
    periodoFim: periodo.periodoFim,
    nomeDepositante: nome,
    // fotografia do caixa NO MOMENTO da sangria: fechamento corrigido depois
    // nao pode reescrever a diferenca que a pessoa viu e justificou na hora
    esperado: caixa ? caixa.esperado : null,
    divergencia: caixa ? caixa.divergencia : null,
    motivoDivergencia: caixa ? caixa.motivoDivergencia : null,
    // quantos dias sem fechamento lancado havia na hora - e' o que explica a
    // maior parte das "sobras", e sem isso a diferenca fica sem contexto
    diasSemFechamento: Number(diasSemFechamento) || 0,
    criadoPorId,
    criadoPorEmail,
    criadoEm: new Date().toISOString(),
  };
  await ref.set(registro);
  sangriasCache.invalidar();
  return registro;
}

async function listAllUncached() {
  const snap = await COLLECTION.orderBy('data', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const sangriasCache = createCache(listAllUncached, 5 * 60 * 1000);
const listAll = sangriasCache.cached;


// filtra EM MEMORIA sobre o cache compartilhado - a query direta por
// unidade (where in) nao passava pelo cache e virava uma leitura completa
// no Firestore a cada chamada (ver o estouro de leituras de 2026-08-09)
async function listByUnidades(unidades) {
  if (!unidades || !unidades.length) return [];
  const alvo = new Set(unidades);
  return (await listAll()).filter((r) => alvo.has(r.unidade));
}

// diferenca que passou da tolerancia - o que o Painel de Saidas marca e o
// que dispara o alerta pro Master
function temDivergencia(s) {
  return s && s.divergencia != null && Math.abs(Number(s.divergencia)) > TOLERANCIA_DIVERGENCIA;
}

// formata a sangria como um "fechamento" mínimo (mesmo formato usado no
// resto do sistema), só com o valor retirado em totalSaida - assim dá pra
// mesclar com o fechamento real do dia usando a mesma função já validada
function comoFechamento(s) {
  return {
    id: `sangria-${s.id}`,
    gerente: s.criadoPorEmail || '',
    unidadeNome: s.unidadeNome,
    unidade: s.unidade,
    grupo: s.grupo,
    data: s.data,
    caixaInicial: 0, caixaFinal: 0, delivery: 0, carryout: 0, pickup: 0, loja: 0,
    adyen: 0, ifood: 0, food99: 0, pix: 0, pixCnpj: 0, outros: 0,
    somaMaq: 0, somaPOS: 0, entradaDinheiro: 0, deposito: 0,
    totalSaida: s.valor, faturamento: 0, totalDeclarado: 0, diferenca: 0,
    obsDif: null,
    observacao: s.descricao ? `Sangria: ${s.descricao}` : 'Sangria',
    quebra: 0, tc: 0, cancelados: 0,
  };
}

async function getOne(id) {
  const doc = await COLLECTION.doc(id).get();
  return doc.exists ? doc.data() : null;
}

// edicao/exclusao direta - poder do Master de corrigir ou apagar uma
// sangria lançada errado. Como a sangria só existe nessa coleção (o
// fechamento só a enxerga mesclada na leitura, ver comoFechamento), editar
// ou excluir aqui já reflete automaticamente em qualquer lugar que mostra
// o fechamento mesclado - não precisa (nem dá) mexer no fechamento em si
async function atualizar(id, { valor, descricao, data, periodoInicio, periodoFim, nomeDepositante }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Sangria não encontrada.');
  const patch = {};
  if (valor != null && valor !== '') {
    const v = num(valor);
    if (v <= 0) throw new Error('Informe o valor retirado.');
    patch.valor = v;
  }
  if (descricao != null) patch.descricao = String(descricao).slice(0, 300);
  if (data != null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new Error('Data inválida.');
    patch.data = data;
  }
  if (periodoInicio !== undefined || periodoFim !== undefined) {
    const periodo = validarPeriodo(periodoInicio, periodoFim);
    patch.periodoInicio = periodo.periodoInicio;
    patch.periodoFim = periodo.periodoFim;
  }
  if (nomeDepositante !== undefined) {
    patch.nomeDepositante = validarNomeDepositante(nomeDepositante);
  }
  await ref.update(patch);
  sangriasCache.invalidar();
  return getOne(id);
}

async function remover(id) {
  const snap = await COLLECTION.doc(id).get();
  if (!snap.exists) throw new Error('Sangria não encontrada.');
  await COLLECTION.doc(id).delete();
  sangriasCache.invalidar();
}

// conferencia (Painel de Saídas) - diferente de editar/excluir, que so o
// Master faz: aqui e Master OU Admin marcando que bateu com o extrato/
// comprovante. Fica gravado direto no proprio doc (a sangria ja tem id
// proprio, diferente das "outras saidas" do fechamento - ver
// verificacoesSaida.js pra aquelas)
async function marcarVerificada(id, { verificada, porId, porEmail }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Sangria não encontrada.');
  const patch = {
    verificada: !!verificada,
    verificadaPorId: verificada ? porId : null,
    verificadaPorEmail: verificada ? porEmail : null,
    verificadaEm: verificada ? new Date().toISOString() : null,
  };
  await ref.update(patch);
  sangriasCache.invalidar();
  return getOne(id);
}

module.exports = { criar, listAll, listByUnidades, comoFechamento, getOne, atualizar, remover, marcarVerificada, temDivergencia, TOLERANCIA_DIVERGENCIA };

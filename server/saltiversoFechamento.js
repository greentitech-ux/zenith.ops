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
const festas = require('./festas');
const solicitacoes = require('./solicitacoes');
const users = require('./users');

const COLLECTION = db.collection('saltiversoFechamentos');
// caixas individuais: cada operador (login) fecha O SEU proprio caixa. Depois
// todos juntos "fecham o dia" (consolidacao). Colecao separada do doc do dia.
const CAIXAS = db.collection('saltiversoCaixas');
// pedidos de alteracao de um caixa JA lancado (trava anti-fraude): depois de
// lancado, o valor so muda por aqui, com aprovacao do Master
const CAIXA_EDICOES = db.collection('saltiversoCaixaEdicoes');

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

// o MESMO operador pode ter dois caixas no mesmo dia: o do balcão (entradas
// do parque + bebida/meia) e o de FESTA (sinal de reserva + recebimentos).
// São dinheiros que chegam por caminhos diferentes - a festa muitas vezes é
// um Pix combinado dias antes - e misturar os dois num caixa só deixava a
// conferência ilegível: sobra/falta do balcão escondia sobra/falta da festa.
// Separados, cada um fecha e confere sozinho, e a lista de caixas do dia
// mostra "aurea" e "aurea · festa" como linhas distintas.
const ORIGENS = ['balcao', 'festa'];
const ORIGEM_LABEL = { balcao: 'balcão', festa: 'festa' };
// caixa lancado antes dessa separacao nao tem o campo - era tudo balcão
const normalizarOrigem = (o) => (ORIGENS.includes(o) ? o : 'balcao');

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
  const [parqueResumo, vendasResumo, festasResumo] = await Promise.all([
    parque.resumoDoDia(unidade, data),
    saltiversoVendas.resumoDoDia(unidade, data),
    // dinheiro de festa que entrou HOJE (sinal na data da venda + cada
    // recebimento na data dele) - ver festas.resumoDoDia
    festas.resumoDoDia(unidade, data),
  ]);
  const parqueBuckets = bucketsDoResumo(parqueResumo);
  const vendasBuckets = bucketsDoResumo(vendasResumo);
  const festasBuckets = bucketsDoResumo(festasResumo);
  const faturadoPorForma = {};
  BUCKETS.forEach((b) => { faturadoPorForma[b] = arred(parqueBuckets[b] + vendasBuckets[b] + festasBuckets[b]); });
  return {
    faturado: arred(parqueResumo.total + vendasResumo.total + festasResumo.total),
    faturadoPorForma,
    detalhe: { parque: parqueResumo, vendas: vendasResumo, festas: festasResumo },
  };
}

// versao categorica da diferenca - 'ok' | 'sobrando' | 'faltando' - pra
// devolver ao operador comum sem revelar o valor exato (ver lancarCaixa)
function resultadoCategoria(diferenca) {
  if (Math.abs(diferenca) <= LIMITE_QUEBRA_SALTIVERSO) return 'ok';
  return diferenca > 0 ? 'sobrando' : 'faltando';
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

// ---------------------------------------------------------------------------
// Caixas individuais por operador (login). Modelo: cada operador fecha o SEU
// caixa; quem vendeu no dia (parque/bebida-meia carregam criadoPorId) e
// obrigado a fechar; depois todos juntos "fecham o dia" (consolidacao).
// ---------------------------------------------------------------------------
function caixaDocId(unidade, data, operadorId, origem) {
  // o caixa de balcão mantém o id ANTIGO (sem sufixo) - os caixas já
  // lançados antes da separação continuam sendo encontrados
  const base = `${unidade}__${data}__${operadorId}`;
  const id = normalizarOrigem(origem) === 'festa' ? `${base}__festa` : base;
  return id.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

// recebimento de festa lançado antes de `registradoPorId` existir só tem o
// email de quem registrou. Resolve pelo email pra o dinheiro cair no caixa
// de alguém em vez de virar "sem-operador" - que entra no faturado do dia,
// não entra em caixa nenhum e trava a conferência pra sempre
async function resolverIdsPorEmail(movs) {
  if (!movs.some((m) => !m.porId && m.porEmail)) return movs;
  let porEmail = new Map();
  try {
    porEmail = new Map((await users.list()).map((u) => [String(u.email || '').toLowerCase(), u.id]));
  } catch (err) {
    console.error('[saltiversoFechamento] não consegui resolver operador de festa pelo email:', err.message);
    return movs;
  }
  return movs.map((m) => (m.porId || !m.porEmail
    ? m
    : { ...m, porId: porEmail.get(String(m.porEmail).toLowerCase()) || null }));
}

// faturado ATRIBUIDO a cada operador (quem lancou a entrada/venda) - base do
// modelo por operador e da regra "quem vendeu tem que fechar o proprio caixa".
// Uma linha por operador E POR ORIGEM (balcao/festa): quem vendeu nos dois
// aparece duas vezes e fecha um caixa de cada.
async function faturadoPorOperador(unidade, data) {
  const [checkins, vendas, movsFestaCru] = await Promise.all([
    parque.listAll(),
    saltiversoVendas.listVendasDoDia(unidade, data),
    // quem vende/recebe a festa fica responsável pelo valor no caixa dele
    festas.movimentosPorOperador(unidade, data),
  ]);
  const movsFesta = await resolverIdsPorEmail(movsFestaCru);
  const doDia = checkins.filter((c) => c.unidade === unidade && c.dataUtilizacao === data);
  const vendasOk = vendas.filter((v) => !v.cancelada);
  const map = new Map();
  const get = (id, email, origem) => {
    const key = `${id || email || 'sem-operador'}::${origem}`;
    if (!map.has(key)) map.set(key, { operadorId: id || null, operadorEmail: email || null, origem, total: 0, porFormaRaw: {} });
    return map.get(key);
  };
  doDia.forEach((c) => {
    const o = get(c.criadoPorId, c.criadoPorEmail, 'balcao');
    o.total += num(c.valor);
    (c.pagamentos || []).forEach((p) => { o.porFormaRaw[p.forma] = num(o.porFormaRaw[p.forma]) + num(p.valor); });
    (c.acrescimos || []).forEach((a) => { if (a.metodoPagamento) o.porFormaRaw[a.metodoPagamento] = num(o.porFormaRaw[a.metodoPagamento]) + num(a.valor); });
  });
  vendasOk.forEach((v) => {
    const o = get(v.criadoPorId, v.criadoPorEmail, 'balcao');
    o.total += num(v.total);
    (v.pagamentos || []).forEach((p) => { o.porFormaRaw[p.forma] = num(o.porFormaRaw[p.forma]) + num(p.valor); });
  });
  // festa: o sinal responsabiliza quem vendeu a reserva; cada recebimento
  // posterior responsabiliza quem registrou aquele recebimento
  movsFesta.forEach((m) => {
    const o = get(m.porId, m.porEmail, 'festa');
    o.total += num(m.valor);
    if (m.forma) o.porFormaRaw[m.forma] = num(o.porFormaRaw[m.forma]) + num(m.valor);
  });
  return [...map.values()].map((o) => ({
    operadorId: o.operadorId, operadorEmail: o.operadorEmail, origem: o.origem,
    faturado: arred(o.total),
    faturadoPorForma: bucketsDoResumo({ porForma: o.porFormaRaw }),
  }));
}

async function listCaixasUncached() {
  const snap = await CAIXAS.get();
  return snap.docs.map((d) => d.data());
}
const caixasCache = createCache(listCaixasUncached, 5 * 60 * 1000);
async function listCaixasDoDia(unidade, data) {
  const all = await caixasCache.cached();
  return all.filter((c) => c.unidade === unidade && c.data === data).sort((a, b) => String(a.lancadoEm).localeCompare(String(b.lancadoEm)));
}
async function getCaixa(id) {
  const doc = await CAIXAS.doc(id).get();
  return doc.exists ? doc.data() : null;
}

// o operador logado fecha O SEU caixa (declara o que contou). Trava depois:
// pra mudar, so via solicitarAlteracaoCaixa (aprovacao do Master)
async function lancarCaixa({ unidade, unidadeNome, data, declarado, observacao, origem, operadorId, operadorEmail, operadorNome }) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  if (!data || !DATA_RE.test(data)) throw new Error('Data inválida.');
  if (!operadorId) throw new Error('Operador não identificado (faça login no Zenith).');
  if (await getOne(docId(unidade, data))) throw new Error('O dia já foi fechado. Peça uma alteração ao Master.');
  const origemOk = normalizarOrigem(origem);
  const id = caixaDocId(unidade, data, operadorId, origemOk);
  if ((await CAIXAS.doc(id).get()).exists) throw new Error(`Você já fechou o seu caixa de ${ORIGEM_LABEL[origemOk]} hoje. Para mudar valores, peça uma alteração.`);
  const declaradoOk = sanitizarTotalDeclarado(declarado);
  const soma = arred(BUCKETS.reduce((s, b) => s + declaradoOk[b], 0));
  const faturados = await faturadoPorOperador(unidade, data);
  const meu = faturados.find((f) => f.operadorId === operadorId && f.origem === origemOk) || { faturado: 0, faturadoPorForma: sanitizarTotalDeclarado({}) };
  const diferenca = arred(soma - meu.faturado);
  const agora = new Date().toISOString();
  const registro = {
    id, unidade, unidadeNome: unidadeNome || unidade, data, origem: origemOk,
    operadorId, operadorEmail: operadorEmail || null, operadorNome: operadorNome || operadorEmail || null,
    declarado: declaradoOk, somaDeclarado: soma,
    faturadoOperador: meu.faturado, faturadoOperadorPorForma: meu.faturadoPorForma,
    diferencaOperador: diferenca,
    // resultado CATEGORICO (ok/sobrando/faltando) - é o único jeito que o
    // operador comum recebe de volta o "deu certo?" sem saber o faturado por
    // tras (se ele visse a diferenca exata, daria pra calcular faturado =
    // declarado - diferenca, o mesmo dado que a gente esconde dele)
    resultado: resultadoCategoria(diferenca),
    observacao: observacao ? String(observacao).trim().slice(0, 500) : null,
    status: 'lancado', historico: [],
    lancadoEm: agora, atualizadoEm: agora,
  };
  await CAIXAS.doc(id).set(registro);
  caixasCache.invalidar();
  return registro;
}

// estado do dia pra tela: faturado ao vivo, caixas ja fechados, operadores
// que venderam e ainda nao fecharam (pendentes) e o doc do dia se ja fechou
async function estadoDoDia(unidade, data) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  if (!data || !DATA_RE.test(data)) throw new Error('Data inválida.');
  const [dia, caixas, faturadoGeral, faturadosOper] = await Promise.all([
    getOne(docId(unidade, data)),
    listCaixasDoDia(unidade, data),
    calcularFaturado(unidade, data),
    faturadoPorOperador(unidade, data),
  ]);
  // pendencia e por operador E POR ORIGEM: quem vendeu no balcão e vendeu
  // festa precisa fechar os dois caixas
  const chavesComCaixa = new Set(caixas.map((c) => `${c.operadorId}::${normalizarOrigem(c.origem)}`));
  const pendentes = faturadosOper
    .filter((f) => f.operadorId && f.faturado > 0 && !chavesComCaixa.has(`${f.operadorId}::${f.origem}`))
    .map((f) => ({ operadorId: f.operadorId, operadorEmail: f.operadorEmail, origem: f.origem, faturado: f.faturado }));
  const somaCaixas = arred(caixas.reduce((s, c) => s + c.somaDeclarado, 0));
  return {
    unidade, data,
    faturado: faturadoGeral.faturado, faturadoPorForma: faturadoGeral.faturadoPorForma, detalhe: faturadoGeral.detalhe,
    caixas, pendentes, somaCaixas,
    diferencaPrevia: arred(somaCaixas - faturadoGeral.faturado),
    fechamento: dia || null,
  };
}

// trava anti-fraude: caixa lancado so muda por pedido de alteracao aprovado
// pelo Master. So vale ANTES do dia fechar (depois, o Master corrige o dia).
async function solicitarAlteracaoCaixa(caixaId, { declarado, motivo, solicitadoPorId, solicitadoPorEmail }) {
  const caixa = await getCaixa(caixaId);
  if (!caixa) throw new Error('Caixa não encontrado.');
  if (await getOne(docId(caixa.unidade, caixa.data))) throw new Error('O dia já foi fechado — a alteração agora é feita pelo Master no fechamento do dia.');
  const novo = sanitizarTotalDeclarado(declarado);
  const id = `${caixaId}__${Date.now()}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const registro = {
    id, caixaId, unidade: caixa.unidade, unidadeNome: caixa.unidadeNome, data: caixa.data,
    operadorEmail: caixa.operadorEmail, operadorNome: caixa.operadorNome,
    antes: caixa.declarado, novo,
    motivo: motivo ? String(motivo).trim().slice(0, 500) : null,
    status: 'PENDENTE',
    solicitadoPorId: solicitadoPorId || null, solicitadoPorEmail: solicitadoPorEmail || null,
    criadoEm: new Date().toISOString(), decididoEm: null, decididoPorEmail: null,
  };
  await CAIXA_EDICOES.doc(id).set(registro);
  return registro;
}

async function listAlteracoesPendentes(unidade) {
  const snap = await CAIXA_EDICOES.where('status', '==', 'PENDENTE').get();
  return snap.docs.map((d) => d.data()).filter((e) => !unidade || e.unidade === unidade)
    .sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm)));
}

// Master aprova/rejeita. Ao aprovar, aplica o novo declarado no caixa (guarda
// o antes no historico) e recalcula a diferenca do operador.
async function decidirAlteracaoCaixa(edicaoId, { aprovado, porId, porEmail }) {
  const ref = CAIXA_EDICOES.doc(edicaoId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Pedido de alteração não encontrado.');
  const ped = snap.data();
  if (ped.status !== 'PENDENTE') throw new Error('Esse pedido já foi decidido.');
  const agora = new Date().toISOString();
  if (aprovado) {
    const caixa = await getCaixa(ped.caixaId);
    if (!caixa) throw new Error('Caixa não encontrado.');
    const soma = arred(BUCKETS.reduce((s, b) => s + num(ped.novo[b]), 0));
    const novaDiferenca = arred(soma - num(caixa.faturadoOperador));
    await CAIXAS.doc(caixa.id).update({
      declarado: ped.novo, somaDeclarado: soma,
      diferencaOperador: novaDiferenca, resultado: resultadoCategoria(novaDiferenca),
      historico: [...(caixa.historico || []), { antes: caixa.declarado, em: agora, porEmail: porEmail || null, motivo: ped.motivo }],
      atualizadoEm: agora,
    });
    caixasCache.invalidar();
  }
  await ref.update({ status: aprovado ? 'APROVADO' : 'REJEITADO', decididoEm: agora, decididoPorId: porId || null, decididoPorEmail: porEmail || null });
  return { ...ped, status: aprovado ? 'APROVADO' : 'REJEITADO' };
}

// "fechar o dia": consolida os caixas individuais. Bloqueia se ainda ha
// operador que vendeu e nao fechou o proprio caixa (regra anti-fraude).
async function fecharDia({ unidade, unidadeNome, data, observacao, criadoPorId, criadoPorEmail }) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  if (!data || !DATA_RE.test(data)) throw new Error('Data inválida.');
  const id = docId(unidade, data);
  const ref = COLLECTION.doc(id);
  if ((await ref.get()).exists) {
    throw new Error('Esse dia já foi fechado para essa unidade. Peça uma correção em vez de fechar de novo.');
  }
  const estado = await estadoDoDia(unidade, data);
  if (estado.pendentes.length) {
    const nomes = estado.pendentes.map((p) => `${p.operadorEmail || p.operadorId} (${ORIGEM_LABEL[normalizarOrigem(p.origem)]})`).join(', ');
    throw new Error(`Não dá pra fechar o dia: ${estado.pendentes.length} caixa(s) de operador não foram fechados (${nomes}). Todos precisam fechar primeiro.`);
  }
  if (!estado.caixas.length) throw new Error('Nenhum caixa foi fechado ainda hoje.');

  const faturado = estado.faturado;
  const faturadoPorForma = estado.faturadoPorForma;
  const detalhe = estado.detalhe;
  const totalDeclaradoOk = {};
  BUCKETS.forEach((b) => { totalDeclaradoOk[b] = arred(estado.caixas.reduce((s, c) => s + num(c.declarado[b]), 0)); });
  const somaTotalDeclarado = estado.somaCaixas;
  const diferenca = arred(somaTotalDeclarado - faturado);

  const agora = new Date().toISOString();
  const registro = {
    id, unidade, unidadeNome: unidadeNome || unidade, data,
    faturado, faturadoPorForma, detalhe,
    totalDeclarado: totalDeclaradoOk, somaTotalDeclarado, diferenca,
    // fotografia dos caixas que compuseram o dia (quem declarou o que)
    caixas: estado.caixas.map((c) => ({ operadorId: c.operadorId, operadorNome: c.operadorNome, operadorEmail: c.operadorEmail, origem: normalizarOrigem(c.origem), declarado: c.declarado, somaDeclarado: c.somaDeclarado, faturadoOperador: c.faturadoOperador, diferencaOperador: c.diferencaOperador })),
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
  LIMITE_QUEBRA_SALTIVERSO, ORIGENS, ORIGEM_LABEL,
  calcularFaturado, fecharDia, corrigirFechamento, getOne, previewOuFechado, listFechamentos,
  // caixas individuais por operador
  faturadoPorOperador, lancarCaixa, listCaixasDoDia, getCaixa, estadoDoDia,
  solicitarAlteracaoCaixa, listAlteracoesPendentes, decidirAlteracaoCaixa,
};

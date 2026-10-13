const NoPulsoMoeda = require('./public/moeda-br');
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
const { randomUUID } = require('node:crypto');

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
const FUSO_BR = 'America/Sao_Paulo';

function hojeBrasiliaISO() {
  const partes = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO_BR, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const data = {};
  partes.forEach((p) => { if (p.type !== 'literal') data[p.type] = p.value; });
  return `${data.year}-${data.month}-${data.day}`;
}

function diaAnteriorISO(data) {
  const [ano, mes, dia] = String(data).split('-').map(Number);
  const anterior = new Date(Date.UTC(ano, mes - 1, dia - 1));
  return anterior.toISOString().slice(0, 10);
}

const formasCaixa = require('./public/saltiverso-caixa-formas');
const vendasFuturas = require('./parqueVendasFuturas');
const BUCKETS = formasCaixa.novos;

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

// Vendas antigas registram Pix sem origem. O fechamento separa a declaração,
// mas a UI compara os dois Pix juntos; nunca atribui uma origem retroativa.
function bucketsDoResumo(resumo) {
  const pf = (resumo && resumo.porForma) || {};
  return {
    credito: arred(num(pf.credito)), debito: arred(num(pf.debito)), voucher: arred(num(pf.voucher)),
    dinheiro: arred(num(pf.dinheiro)),
    pix: arred(num(pf.pix)),
    linkCredito: arred(num(pf.linkCredito)), linkDebito: arred(num(pf.linkDebito)), linkPix: arred(num(pf.linkPix)),
    outros: arred(num(pf.outros)),
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

function sanitizarTotalDeclarado(obj, campos = formasCaixa.campos(obj)) {
  const out = {};
  campos.forEach((b) => { out[b] = arred(Math.max(0, num(obj && obj[b]))); });
  return out;
}

async function criarCardQuebra(registro) {
  return solicitacoes.create({
    tipo: 'quebra-caixa',
    unidade: registro.unidade,
    unidadeNome: registro.unidadeNome,
    titulo: `Quebra de caixa · ${registro.unidadeNome} (${registro.data}) · diferença de R$ ${NoPulsoMoeda.numero(registro.diferenca)}`,
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
  const doDia = checkins.filter((c) => !c.vendaFuturaId && c.unidade === unidade && c.dataUtilizacao === data);
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
  for (const v of await vendasFuturas.movimentosDoDia(unidade, data)) {
    const o = get(v.porId, v.porEmail, 'balcao');
    o.total += v.valor;
    o.porFormaRaw[v.forma] = num(o.porFormaRaw[v.forma]) + v.valor;
  }
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
  if (!operadorId) throw new Error('Operador não identificado (faça login no NoPulso).');
  if (await getOne(docId(unidade, data))) throw new Error('O dia já foi fechado. Peça uma alteração ao Master.');
  const origemOk = normalizarOrigem(origem);
  const id = caixaDocId(unidade, data, operadorId, origemOk);
  if ((await CAIXAS.doc(id).get()).exists) throw new Error(`Você já fechou o seu caixa de ${ORIGEM_LABEL[origemOk]} hoje. Para mudar valores, peça uma alteração.`);
  const declaradoOk = validarCorrecaoDeclarado(declarado, formasCaixa.campos(declarado));
  const soma = arred(formasCaixa.somar(declaradoOk));
  const revisao = await vendasFuturas.revisaoDia(unidade, data);
  const faturados = await faturadoPorOperador(unidade, data);
  const meu = faturados.find((f) => f.operadorId === operadorId && f.origem === origemOk) || { faturado: 0, faturadoPorForma: sanitizarTotalDeclarado({}) };
  const faturadoPorForma = Object.hasOwn(declaradoOk, 'maquininha') ? {
    maquininha: arred(num(meu.faturadoPorForma.credito)+num(meu.faturadoPorForma.debito)),
    dinheiro: num(meu.faturadoPorForma.dinheiro), pix: arred(num(meu.faturadoPorForma.pix)+num(meu.faturadoPorForma.pixcnpj)),
    outros: arred(num(meu.faturadoPorForma.voucher)+num(meu.faturadoPorForma.outros)),
  } : meu.faturadoPorForma;
  const diferenca = arred(soma - meu.faturado);
  const agora = new Date().toISOString();
  const registro = {
    id, unidade, unidadeNome: unidadeNome || unidade, data, origem: origemOk,
    modeloFormas: formasCaixa.modelo(declaradoOk),
    operadorId, operadorEmail: operadorEmail || null, operadorNome: operadorNome || operadorEmail || null,
    declarado: declaradoOk, somaDeclarado: soma, consolidadoDeclarado: formasCaixa.consolidar([declaradoOk]),
    faturadoOperador: meu.faturado, faturadoOperadorPorForma: faturadoPorForma,
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
  await db.runTransaction(async tx => {
    const existente = await tx.get(CAIXAS.doc(id));
    const dia = await tx.get(COLLECTION.doc(docId(unidade, data)));
    const rev = await tx.get(db.collection('saltiversoMovimentosDia').doc(vendasFuturas.chaveDia(unidade, data)));
    if (existente.exists || dia.exists) throw new Error('Caixa ou dia já fechado. Atualize a tela.');
    if ((rev.exists ? Number(rev.data().versao) || 0 : 0) !== revisao) throw new Error('Uma venda online entrou durante o fechamento. Atualize e confira novamente.');
    tx.set(CAIXAS.doc(id), registro);
  });
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
// pelo Master. Também vale após consolidar o dia: a aprovação sincroniza
// o caixa e o consolidado, sem recalcular vendas históricas.
function passou24h(registro, agora = Date.now()) {
  const em = Date.parse(registro.lancadoEm || registro.criadoEm);
  // Sem hora confiável, nunca liberar a exceção de operador por suposição.
  return !Number.isFinite(em) || agora - em >= 24 * 60 * 60 * 1000;
}

async function solicitarAlteracaoCaixa(caixaId, { declarado, motivo, solicitadoPorId, solicitadoPorEmail, podeAlterarOutroCaixa = false, gerenteDaUnidade = false }) {
  return db.runTransaction(async tx => {
    const caixaSnap = await tx.get(CAIXAS.doc(caixaId));
    const caixa = caixaSnap.exists ? caixaSnap.data() : null;
    if (!caixa) throw new Error('Caixa não encontrado.');
    if (passou24h(caixa) && !gerenteDaUnidade) throw new Error('Após 24 horas do lançamento, somente o gerente da unidade pode solicitar correção.');
    if (String(caixa.operadorId) !== String(solicitadoPorId) && !podeAlterarOutroCaixa) {
      throw new Error('Você só pode pedir alteração do seu próprio caixa.');
    }
    const motivoOk = String(motivo || '').trim();
    if (!motivoOk) throw new Error('Informe o motivo da alteração.');
    const existentes = await tx.get(CAIXA_EDICOES.where('caixaId', '==', caixaId));
    if (existentes.docs.some((d) => d.data().status === 'PENDENTE')) throw new Error('Já existe um pedido de alteração pendente para este caixa.');
    const novo = validarCorrecaoDeclarado(declarado, formasCaixa.campos(caixa.declarado));
    const id = `${caixaId}__${randomUUID()}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const registro = {
      id, caixaId, unidade: caixa.unidade, unidadeNome: caixa.unidadeNome, data: caixa.data,
      operadorEmail: caixa.operadorEmail, operadorNome: caixa.operadorNome,
      antes: caixa.declarado, novo, caixaAtualizadoEm: caixa.atualizadoEm || caixa.lancadoEm || null,
      motivo: motivoOk.slice(0, 500),
      status: 'PENDENTE',
      solicitadoPorId: solicitadoPorId || null, solicitadoPorEmail: solicitadoPorEmail || null,
      criadoEm: new Date().toISOString(), decididoEm: null, decididoPorEmail: null,
    };
    tx.set(CAIXA_EDICOES.doc(id), registro);
    return registro;
  });
}

async function listAlteracoesPendentes(unidade) {
  const snap = await CAIXA_EDICOES.where('status', '==', 'PENDENTE').get();
  return snap.docs.map((d) => d.data()).filter((e) => !unidade || e.unidade === unidade)
    .sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm)));
}

// Master aprova/rejeita. Ao aprovar, aplica o novo declarado no caixa (guarda
// o antes no historico) e recalcula a diferenca do operador.
async function decidirAlteracaoCaixa(edicaoId, { aprovado, porId, porEmail }) {
  const pedido = await CAIXA_EDICOES.doc(edicaoId).get();
  if (aprovado && pedido.exists && pedido.data().tipo === 'fechamento') return corrigirFechamento(pedido.data().fechamentoId, {}, { porId, porEmail, edicaoId });
  if (aprovado) return corrigirCaixa(null, {}, { porId, porEmail, edicaoId });
  const ref = CAIXA_EDICOES.doc(edicaoId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('Pedido de alteração não encontrado.');
    const ped = snap.data();
    if (ped.status !== 'PENDENTE') throw new Error('Esse pedido já foi decidido.');
    const agora = new Date().toISOString();
    tx.update(ref, { status: 'REJEITADO', decididoEm: agora, decididoPorId: porId || null, decididoPorEmail: porEmail || null });
    return { ...ped, status: 'REJEITADO' };
  });
}

function validarCorrecaoDeclarado(valores, campos) {
  if (!valores || campos.some(b => !['number','string'].includes(typeof valores[b]) || String(valores[b]).trim() === '' || !Number.isFinite(Number(valores[b])) || Number(valores[b]) < 0 || Number(valores[b]) > Number.MAX_SAFE_INTEGER / 100)
    || Object.keys(valores).some(b => !campos.includes(b))) throw new Error('Informe valores válidos nas formas de pagamento originais deste caixa.');
  return sanitizarTotalDeclarado(valores, campos);
}

// Master direto ou decisão do pedido existente. A mesma transação guarda
// auditoria, caixa e fotografia do dia; nenhum caminho altera o faturado.
async function corrigirCaixa(caixaId, { declarado, motivo, versaoEsperada }, { porId, porEmail, edicaoId } = {}) {
  if (!porId) throw new Error('Responsável pela correção não identificado.');
  const resultado = await db.runTransaction(async (tx) => {
    const pedidoRef = edicaoId ? CAIXA_EDICOES.doc(edicaoId) : null;
    const pedidoSnap = pedidoRef ? await tx.get(pedidoRef) : null;
    const pedido = pedidoSnap?.exists ? pedidoSnap.data() : null;
    if (pedidoRef && (!pedido || pedido.status !== 'PENDENTE')) throw new Error('Pedido não encontrado ou já decidido.');
    const ref = CAIXAS.doc(pedido ? pedido.caixaId : caixaId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('Caixa não encontrado.');
    const caixa = snap.data();
    const esperado = pedido ? pedido.caixaAtualizadoEm : versaoEsperada;
    const campos = formasCaixa.campos(caixa.declarado);
    if ((esperado && esperado !== (caixa.atualizadoEm || caixa.lancadoEm)) || (pedido && campos.some(b => num(pedido.antes[b]) !== num(caixa.declarado[b])))) throw new Error('O caixa mudou depois deste pedido ou da abertura da tela. Atualize e revise os valores antes de corrigir.');
    const novo = validarCorrecaoDeclarado(pedido ? pedido.novo : declarado, campos);
    const motivoOk = String(pedido ? pedido.motivo : motivo || '').trim().slice(0, 500);
    if (!motivoOk) throw new Error('Informe o motivo da correção.');
    const diaRef = COLLECTION.doc(docId(caixa.unidade, caixa.data));
    const diaSnap = await tx.get(diaRef);
    const soma = arred(formasCaixa.somar(novo));
    const diferenca = arred(soma - num(caixa.faturadoOperador));
    const agora = new Date(Math.max(Date.now(), (Date.parse(caixa.atualizadoEm || caixa.lancadoEm) || 0) + 1)).toISOString();
    const auditoria = { antes: caixa.declarado, depois: novo, em: agora, porId, porEmail: porEmail || null, motivo: motivoOk, pedidoId: edicaoId || null };
    const patch = { declarado: novo, somaDeclarado: soma, consolidadoDeclarado: formasCaixa.consolidar([novo]), diferencaOperador: diferenca, resultado: resultadoCategoria(diferenca), historico: [...(caixa.historico || []), auditoria], atualizadoEm: agora };
    let diaAtualizado = null;
    if (diaSnap.exists) {
      const dia = diaSnap.data();
      const corresponde = c => c.operadorId === caixa.operadorId && normalizarOrigem(c.origem) === normalizarOrigem(caixa.origem);
      if (!(dia.caixas || []).some(corresponde)) throw new Error('Este caixa não consta no consolidado. Revise o fechamento do dia antes de corrigir.');
      // Aplica apenas o delta deste caixa; preserva correções anteriores
      // feitas diretamente no consolidado pelo Master.
      const camposDia = formasCaixa.uniao([dia.totalDeclarado, novo]);
      const totalDeclarado = Object.fromEntries(camposDia.map(b => [b, arred(num(dia.totalDeclarado?.[b]) + num(novo[b]) - num(caixa.declarado[b]))]));
      if (camposDia.some(b => totalDeclarado[b] < 0)) throw new Error('A correção conflita com os valores do dia consolidado. Revise o fechamento do dia.');
      const somaTotalDeclarado = arred(formasCaixa.somar(totalDeclarado));
      const patchDia = { totalDeclarado, somaTotalDeclarado, diferenca: arred(somaTotalDeclarado - num(dia.faturado)), atualizadoEm: agora,
        caixas: dia.caixas.map(c => corresponde(c) ? { ...c, declarado: novo, somaDeclarado: soma, diferencaOperador: diferenca } : c),
        historico: [...(dia.historico || []), { antes: { totalDeclarado: dia.totalDeclarado, diferenca: dia.diferenca }, depois: { totalDeclarado, somaTotalDeclarado }, em: agora, porId, porEmail: porEmail || null, motivo: motivoOk, caixaId: caixa.id, pedidoId: edicaoId || null }] };
      patchDia.consolidadoDeclarado = formasCaixa.consolidar([totalDeclarado], somaTotalDeclarado);
      tx.update(diaRef, patchDia);
      diaAtualizado = { ...dia, ...patchDia };
    }
    tx.update(ref, patch);
    if (pedidoRef) tx.update(pedidoRef, { status: 'APROVADO', decididoEm: agora, decididoPorId: porId, decididoPorEmail: porEmail || null });
    return { caixa: { ...caixa, ...patch }, dia: diaAtualizado, pedido: pedido ? { ...pedido, status: 'APROVADO' } : null };
  });
  caixasCache.invalidar();
  fechamentosCache.invalidar();
  if (resultado.dia && Math.abs(resultado.dia.diferenca) > LIMITE_QUEBRA_SALTIVERSO) {
    try {
      const existente = (await solicitacoes.listAll()).some(s => s.tipo === 'quebra-caixa' && s.fechamentoId === resultado.dia.id);
      if (!existente) await criarCardQuebra(resultado.dia);
    } catch (err) { console.error('[saltiversoFechamento] falha ao atualizar alerta de correção:', err.message); }
  }
  return resultado.pedido || resultado.caixa;
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
  const revisao = await vendasFuturas.revisaoDia(unidade, data);
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
  formasCaixa.uniao(estado.caixas.map(c=>c.declarado)).forEach((b) => { totalDeclaradoOk[b] = arred(estado.caixas.reduce((s, c) => s + num(c.declarado[b]), 0)); });
  const somaTotalDeclarado = estado.somaCaixas;
  const diferenca = arred(somaTotalDeclarado - faturado);

  const agora = new Date().toISOString();
  const registro = {
    id, unidade, unidadeNome: unidadeNome || unidade, data,
    faturado, faturadoPorForma, detalhe,
    totalDeclarado: totalDeclaradoOk, somaTotalDeclarado, diferenca,
    consolidadoDeclarado: formasCaixa.consolidar(estado.caixas.map(c=>c.declarado), somaTotalDeclarado),
    // fotografia dos caixas que compuseram o dia (quem declarou o que)
    caixas: estado.caixas.map((c) => ({ operadorId: c.operadorId, operadorNome: c.operadorNome, operadorEmail: c.operadorEmail, origem: normalizarOrigem(c.origem), declarado: c.declarado, somaDeclarado: c.somaDeclarado, faturadoOperador: c.faturadoOperador, diferencaOperador: c.diferencaOperador })),
    observacao: observacao ? String(observacao).trim().slice(0, 500) : null,
    historico: [],
    criadoPorId, criadoPorEmail, criadoEm: agora, atualizadoEm: agora,
  };
  await db.runTransaction(async tx => {
    if ((await tx.get(ref)).exists) throw new Error('Esse dia já foi fechado. Atualize a tela.');
    const rev = await tx.get(db.collection('saltiversoMovimentosDia').doc(vendasFuturas.chaveDia(unidade, data)));
    if ((rev.exists ? Number(rev.data().versao) || 0 : 0) !== revisao) throw new Error('Uma venda online entrou durante a consolidação. Atualize a tela.');
    const atuais = await tx.get(CAIXAS.where('unidade', '==', unidade).where('data', '==', data));
    if (atuais.docs.length !== estado.caixas.length || atuais.docs.some(d => {
      const caixa = d.data(), anterior = estado.caixas.find(c=>c.id===caixa.id);
      return !anterior || caixa.atualizadoEm !== anterior.atualizadoEm;
    })) throw new Error('Um caixa foi corrigido durante a consolidação. Atualize a tela e confira novamente.');
    tx.set(ref, registro);
  });
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
async function solicitarAlteracaoFechamento(id, { totalDeclarado, observacao, motivo, versaoEsperada }, { porId, porEmail }) {
  return db.runTransaction(async tx => {
    const snap = await tx.get(COLLECTION.doc(id));
    if (!snap.exists) throw new Error('Fechamento não encontrado.');
    const atual = snap.data();
    if (versaoEsperada === undefined || versaoEsperada !== (atual.atualizadoEm || atual.criadoEm || null)) throw new Error('O fechamento mudou. Atualize a tela e revise os valores.');
    const existentes = await tx.get(CAIXA_EDICOES.where('fechamentoId', '==', id));
    if (existentes.docs.some(d => d.data().status === 'PENDENTE')) throw new Error('Já existe um pedido pendente para este fechamento.');
    const motivoOk = String(motivo || '').trim().slice(0, 500);
    if (!motivoOk) throw new Error('Informe o motivo da correção.');
    const novo = validarCorrecaoDeclarado(totalDeclarado, formasCaixa.campos(atual.totalDeclarado));
    const pedidoId = randomUUID();
    const pedido = { id: pedidoId, tipo: 'fechamento', fechamentoId: id, unidade: atual.unidade, data: atual.data,
      antes: atual.totalDeclarado, novo, observacao: String(observacao ?? atual.observacao ?? '').trim().slice(0, 500),
      versaoEsperada, motivo: motivoOk, status: 'PENDENTE', solicitadoPorId: porId, solicitadoPorEmail: porEmail || null, criadoEm: new Date().toISOString() };
    tx.set(CAIXA_EDICOES.doc(pedidoId), pedido);
    return pedido;
  });
}

async function corrigirFechamento(id, { totalDeclarado, observacao, motivo, versaoEsperada }, { porId, porEmail, edicaoId }) {
  const atualizado = await db.runTransaction(async tx => {
    const ref = COLLECTION.doc(id);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('Fechamento não encontrado.');
    const atual = snap.data();
    let pedido = null;
    if (edicaoId) {
      const ped = await tx.get(CAIXA_EDICOES.doc(edicaoId));
      if (!ped.exists || ped.data().status !== 'PENDENTE' || ped.data().fechamentoId !== id) throw new Error('Pedido não está pendente para este fechamento.');
      pedido = ped.data();
      totalDeclarado = pedido.novo; observacao = pedido.observacao; motivo = pedido.motivo; versaoEsperada = pedido.versaoEsperada;
    }
    // Registros sem timestamp ainda podem ser corrigidos pelo Master usando
    // a versão explícita null; nunca reclassifica nem regrava ao consultar.
    if (versaoEsperada === undefined || versaoEsperada !== (atual.atualizadoEm || atual.criadoEm || null)) throw new Error('O fechamento mudou. Atualize a tela e revise os valores.');
    const motivoOk = String(motivo || '').trim().slice(0, 500);
    if (!motivoOk) throw new Error('Informe o motivo da correção.');
    const novo = validarCorrecaoDeclarado(totalDeclarado, formasCaixa.campos(atual.totalDeclarado));
    const soma = arred(formasCaixa.somar(novo));
    const agora = new Date(Math.max(Date.now(), (Date.parse(atual.atualizadoEm || atual.criadoEm) || 0) + 1)).toISOString();
    const patch = { totalDeclarado: novo, somaTotalDeclarado: soma, diferenca: arred(soma - atual.faturado),
      observacao: String(observacao ?? atual.observacao ?? '').trim().slice(0, 500) || null, atualizadoEm: agora,
      consolidadoDeclarado: formasCaixa.consolidar([novo], soma) };
    patch.historico = [...(atual.historico || []), {
      antes: { totalDeclarado: atual.totalDeclarado, somaTotalDeclarado: atual.somaTotalDeclarado, diferenca: atual.diferenca, observacao: atual.observacao || null },
      depois: { totalDeclarado: novo, somaTotalDeclarado: soma, diferenca: patch.diferenca, observacao: patch.observacao },
      em: agora, porId: porId || null, porEmail: porEmail || null, motivo: motivoOk, pedidoId: edicaoId || null,
    }];
    tx.update(ref, patch);
    if (pedido) tx.update(CAIXA_EDICOES.doc(edicaoId), { status: 'APROVADO', decididoEm: agora, decididoPorId: porId, decididoPorEmail: porEmail || null });
    return { ...atual, ...patch };
  });
  fechamentosCache.invalidar();
  let cardQuebraCaixa = null;
  if (Math.abs(atualizado.diferenca) > LIMITE_QUEBRA_SALTIVERSO) {
    try {
      const jaExiste = (await solicitacoes.listAll()).some(s => s.tipo === 'quebra-caixa' && s.fechamentoId === id);
      if (!jaExiste) cardQuebraCaixa = await criarCardQuebra(atualizado);
    } catch (err) { console.error('[saltiversoFechamento] falha no alerta da correção:', err.message); }
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

// Operador não pode inferir o faturado pelo histórico. Ele só precisa saber
// que aquele dia foi consolidado, nunca os valores, diferença ou observação.
function historicoParaOperador(f) {
  return { id: f.id, unidade: f.unidade, data: f.data, fechado: true, valoresOcultos: true };
}

// Antes de começar uma venda no novo dia, o dia anterior que teve movimento
// precisa estar integralmente concluído: caixas individuais e consolidação.
// Dias sem movimento não bloqueiam a primeira operação da unidade.
async function exigirDiaAnteriorFechado(unidade, dataAtual = hojeBrasiliaISO()) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  const anterior = diaAnteriorISO(dataAtual);
  if (await getOne(docId(unidade, anterior))) return { ok: true, data: anterior };
  const estadoAnterior = await estadoDoDia(unidade, anterior);
  const houveMovimento = estadoAnterior.faturado > 0 || estadoAnterior.caixas.length > 0;
  if (!houveMovimento) return { ok: true, data: anterior };
  const pendentes = estadoAnterior.pendentes.length;
  const detalhe = pendentes
    ? ` Ainda faltam ${pendentes} caixa(s) individual(is).`
    : ' Os caixas já lançados precisam ser consolidados pelo gerente.';
  throw new Error(`Venda bloqueada: o dia ${anterior} ainda não foi encerrado. Feche os caixas e consolide o dia antes de vender em ${dataAtual}.${detalhe}`);
}

// todos os dias fechados, de qualquer unidade - usado por GET /api/fechamentos
// (ver comoFechamento abaixo) pra esses dias aparecerem no painel geral de
// Fechamentos junto com as lojas, e nao só na tela dedicada do Saltiverso
async function listAll() {
  return listAllCached();
}

// converte um fechamento do Saltiverso pro MESMO formato de linha que
// fechamentosLive.js usa - mesmo padrao de sangrias.comoFechamento (ver
// sangrias.js): o painel de Fechamentos nunca precisa saber que essa linha
// veio de outra coleção, so trata como mais um fechamento. Faturamento =
// Faturado (calculado sozinho a partir do que já foi vendido no sistema),
// Total Declarado = soma do que cada operador conferiu contra os
// comprovantes físicos - as formas novas e as históricas viram
// "Formas de pagamento" extras do grupo Saltiverso Patteo
// (ver grupos.ensureGrupoSaltiverso), pra tabela mostrar o breakdown certo
// em vez de tudo somado numa coluna só
function comoFechamento(f) {
  return {
    id: f.id,
    gerente: f.criadoPorEmail || '',
    unidadeNome: f.unidadeNome || f.unidade,
    unidade: f.unidade,
    data: f.data,
    // schema fixo antigo (planilha/legado) - Saltiverso nao usa nenhum
    // desses, ficam zerados pra nao aparecer coluna nenhuma deles na tabela
    caixaInicial: 0, caixaFinal: 0, adyen: 0, adyenPos: 0,
    ifood: 0, food99: 0, pix: 0, pixCnpj: 0, loja: 0, outros: 0,
    totalSaida: 0, quebra: 0, entradaDinheiro: 0, deposito: 0,
    faturamento: f.faturado,
    totalDeclarado: f.somaTotalDeclarado,
    diferenca: f.diferenca,
    obsDif: null,
    observacao: f.observacao || '',
    tc: 0, cancelados: 0,
    canaisVendaExtras: {},
    kpisExtras: {},
    // o que cada operador CONFEREIU contra o comprovante físico, por balde -
    // o Faturado (automático) já virou o Faturamento acima
    formasPagamentoExtras: { ...(f.totalDeclarado || {}) },
    criadoPorId: f.criadoPorId, criadoPorEmail: f.criadoPorEmail, criadoEm: f.criadoEm,
  };
}

module.exports = {
  LIMITE_QUEBRA_SALTIVERSO, ORIGENS, ORIGEM_LABEL,
  calcularFaturado, fecharDia, corrigirFechamento, getOne, previewOuFechado, listFechamentos,
  listAll, comoFechamento,
  // caixas individuais por operador
  faturadoPorOperador, lancarCaixa, listCaixasDoDia, getCaixa, estadoDoDia,
  solicitarAlteracaoCaixa, listAlteracoesPendentes, decidirAlteracaoCaixa, corrigirCaixa,
  historicoParaOperador, exigirDiaAnteriorFechado, passou24h, solicitarAlteracaoFechamento,
};

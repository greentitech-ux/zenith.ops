// estacaoComida.js
// Rodízio com comanda por PESSOA (Estação da Comida). Desenhado com o Master
// em 14/09/2026, dentro do restaurante, olhando a comanda de papel que ele
// quer aposentar.
//
// A COMANDA É A UNIDADE ATÔMICA, NÃO A MESA. Cada pessoa que entra recebe um
// cartão numerado; a mesa é só o agrupamento que nasce quando as comandas são
// vinculadas a ela. Isso é o contrário do PDV comum (conta da mesa, dividida
// no fim) e é exatamente o que faz "pagar a minha parte" ser trivial: não se
// divide nada, cada comanda já é uma conta. Pagar por 3 pessoas é informar 3
// números.
//
// O NÚMERO NÃO É A IDENTIDADE. O cartão volta pro maço quando a pessoa paga,
// então a 7541 sai às 19h e é entregue de novo às 21h - no MESMO dia. Quem
// tratasse "número + data" como chave juntaria duas pessoas diferentes na
// mesma conta. Aqui a identidade é a SESSÃO (um documento por abertura), o
// número é só busca, e existe uma regra dura: só pode haver UMA comanda
// ABERTA por número na unidade.
//
// MESA NÃO É COLEÇÃO. "Mesa 74 com 4 pessoas e R$ 320" é derivado das
// comandas ABERTAS com mesa=74 - nenhum documento a mais, nenhuma escrita a
// mais, e nada pra ficar fora de sincronia. Mesa ocupada é mesa que tem
// comanda aberta.
//
// ESPELHO EM MEMÓRIA (CLAUDE.md §3). O salão é uma tela que fica aberta e
// recarrega sozinha; ler as comandas abertas do Firestore a cada recarga
// custaria ~80 documentos por consulta numa casa cheia - milhares de leituras
// por hora, que foi exatamente o erro que custou ~R$900/mês no NOC. Aqui vale
// a mesma solução: as abertas do dia vivem em memória e cada escrita aplica o
// patch no espelho em vez de forçar releitura (ver gravarEEspelhar).
//
// PREÇO NUNCA VEM DO NAVEGADOR. Mesma regra do saltiversoVendas.js: o preço
// do rodízio sai da tabela do dia e o da bebida sai do catálogo do inventário
// daquela unidade. Fecha a brecha óbvia de lançar valor menor e embolsar a
// diferença.
//
// E O QUE FOI COBRADO FICA CONGELADO. O preço do rodízio é gravado na
// comanda na ABERTURA e o da bebida no LANÇAMENTO. Mudar a tabela amanhã não
// reescreve o que já foi vendido - o histórico tem que continuar legível
// exatamente como foi.
const db = require('./firestore');
const { createCache } = require('./liveCache');
const inventario = require('./inventario');
const { FORMAS_PAGAMENTO_SPLIT } = require('./parque');

const COMANDAS = db.collection('estacaoComandas');
const PAGAMENTOS = db.collection('estacaoPagamentos');
const PRECOS = db.collection('estacaoPrecos');

const FUSO_BR = 'America/Sao_Paulo';
// ABERTA -> PAGA (caixa recebeu) ou ABERTA -> CANCELADA (erro de digitação,
// pessoa que foi embora antes de consumir). Três estados, disjuntos.
const STATUS = ['ABERTA', 'PAGA', 'CANCELADA'];
// A TABELA DE VALORES DA CASA (foto do cardápio, 14/09) tem três eixos, não
// um. O primeiro modelo aqui guardava um preço por DIA, e isso não cobre o
// que está no papel:
//
//   ALMOÇO  seg a sex (exceto feriados)  39,90   |  sáb, dom e feriados  59,90
//   JANTAR  dom a qui                    39,90   |  sex e sáb            49,90
//   CRIANÇA 6 a 10 anos: 30 / 40 no almoço, 30 / 35 no jantar
//   Criança até 5 anos NÃO PAGA.
//
// Então o preço é dia × TURNO × tipo, e o feriado muda o almoço (vira fim de
// semana) sem mudar o jantar - exatamente como o cardápio diz.
const TURNOS = ['almoco', 'jantar'];
// A criança até 5 anos entra como TIPO, não como "não abre comanda": ela
// ocupa lugar, come, e precisa aparecer na contagem de pessoas da mesa e no
// ticket médio. O que ela não faz é somar dinheiro - o preço dela é sempre 0.
const TIPOS_RODIZIO = ['adulto', 'crianca', 'crianca-ate-5'];
const TIPO_ISENTO = 'crianca-ate-5';
const ROTULO_TIPO = { adulto: 'adulto', crianca: 'criança (6 a 10)', 'crianca-ate-5': 'criança até 5 anos' };
const ROTULO_TURNO = { almoco: 'almoço', jantar: 'jantar' };
// o cardápio: almoço até as 18h (11h-15h em dia de semana, 11h-18h no fim de
// semana), jantar das 18h às 23h. A virada às 18h atende os dois calendários.
const HORA_VIRADA_JANTAR = 18;
// os 5 caixas da casa (o Master: "e assim e fechado pelo caixa 01 02 03 04 ou
// 05"). Lista fechada de propósito: caixa é conferência de dinheiro, e um
// campo livre viraria "caixa 3", "Caixa 3", "cx3" no mesmo fechamento.
const CAIXAS = ['01', '02', '03', '04', '05'];
const DIAS_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
const SERVICO_PCT_PADRAO = 10;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function arred(v) {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}
function texto(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

// Dia de NEGÓCIO. Hoje é o dia de calendário em São Paulo, e está escrito
// aqui porque é uma decisão, não um detalhe: se a casa virar a madrugada, uma
// comanda aberta 00:20 cai no dia seguinte e o fechamento da noite fica
// partido em dois. Quando isso for real, entra uma hora de corte na
// configuração - não invento uma agora.
function hojeBrasiliaISO(agora = new Date()) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO_BR, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(agora);
  const o = {};
  partes.forEach((p) => { if (p.type !== 'literal') o[p.type] = p.value; });
  return `${o.year}-${o.month}-${o.day}`;
}
function diaDaSemanaBR(dataISO) {
  // meio-dia UTC evita a virada de fuso jogar a data pro dia anterior
  const d = new Date(`${dataISO}T12:00:00Z`);
  return DIAS_SEMANA[d.getUTCDay()];
}

// ------------------------------------------------------------ preços
//
// Tabela por DIA DA SEMANA (pedido do Master: "preço deixar aberto para mudar
// quando necessário e também a opção de programar por dia da semana"). Sete
// dias, adulto e criança, mais o percentual de serviço.
function precosVazios(unidade) {
  const rodizio = {};
  // 'feriado' é uma linha a mais na tabela, ao lado dos sete dias: no almoço
  // o feriado tem preço próprio, e guardá-lo como um oitavo "dia" evita
  // espalhar exceção por todo lado
  [...DIAS_SEMANA, 'feriado'].forEach((d) => {
    rodizio[d] = { almoco: { adulto: 0, crianca: 0 }, jantar: { adulto: 0, crianca: 0 } };
  });
  return { unidade, rodizio, feriados: [], servicoPct: SERVICO_PCT_PADRAO, atualizadoEm: null, atualizadoPorEmail: null };
}

async function getPrecos(unidade) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  const snap = await PRECOS.doc(unidade).get();
  if (!snap.exists) return precosVazios(unidade);
  const d = snap.data() || {};
  const base = precosVazios(unidade);
  [...DIAS_SEMANA, 'feriado'].forEach((dia) => {
    const v = (d.rodizio || {})[dia] || {};
    TURNOS.forEach((turno) => {
      // aceita o formato ANTIGO (um preço por dia, sem turno) como se fosse o
      // almoço: quem já tinha tabela preenchida não perde o que cadastrou
      const t = v[turno] || (turno === 'almoco' && (v.adulto !== undefined || v.crianca !== undefined) ? v : {});
      base.rodizio[dia][turno] = { adulto: Math.max(0, num(t.adulto)), crianca: Math.max(0, num(t.crianca)) };
    });
  });
  base.feriados = [...new Set((Array.isArray(d.feriados) ? d.feriados : [])
    .map((x) => String(x || '').slice(0, 10)).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)))].sort();
  base.servicoPct = d.servicoPct != null ? Math.min(100, Math.max(0, num(d.servicoPct))) : SERVICO_PCT_PADRAO;
  base.atualizadoEm = d.atualizadoEm || null;
  base.atualizadoPorEmail = d.atualizadoPorEmail || null;
  return base;
}

async function salvarPrecos(unidade, { rodizio, servicoPct, feriados }, porEmail) {
  const atual = await getPrecos(unidade);
  const novo = { ...atual };
  if (rodizio && typeof rodizio === 'object') {
    [...DIAS_SEMANA, 'feriado'].forEach((dia) => {
      const v = rodizio[dia];
      if (!v || typeof v !== 'object') return;
      TURNOS.forEach((turno) => {
        const t = v[turno];
        if (!t || typeof t !== 'object') return;
        novo.rodizio[dia][turno] = {
          adulto: t.adulto === undefined ? atual.rodizio[dia][turno].adulto : Math.max(0, num(t.adulto)),
          crianca: t.crianca === undefined ? atual.rodizio[dia][turno].crianca : Math.max(0, num(t.crianca)),
        };
      });
    });
  }
  // os feriados são as DATAS marcadas à mão: não existe calendário nacional
  // aqui, e feriado de cidade (padroeira) não sairia de calendário nenhum
  if (Array.isArray(feriados)) {
    novo.feriados = [...new Set(feriados.map((x) => String(x || '').slice(0, 10))
      .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)))].sort().slice(0, 60);
  }
  if (servicoPct !== undefined) novo.servicoPct = Math.min(100, Math.max(0, num(servicoPct)));
  novo.atualizadoEm = new Date().toISOString();
  novo.atualizadoPorEmail = porEmail || null;
  await PRECOS.doc(unidade).set(novo, { merge: true });
  return novo;
}

// pura: o preço do rodízio daquele dia. Mudar a tabela vale pras comandas
// ABERTAS daqui pra frente - quem já está na mesa mantém o que foi cobrado
// (ver precoRodizio gravado em abrirComanda).
// O turno sai da HORA em que a comanda foi aberta, não de uma escolha do
// garçom: às 19h é jantar, e pedir isso na tela seria um campo a mais pra
// errar no meio do salão cheio.
// ---------- QUEM ABRE O TURNO E' O CAIXA, NAO O RELOGIO ----------
//
// Decisao do Master (14/09/2026): "quem define a abertura da venda almoco ou
// fechamento e' o caixa. Se o caixa abrir venda almoco, os precos ficam almoco.
// Se o caixa fecha e abre janta, tudo vira".
//
// POR QUE ISSO IMPORTA: o relogio mentia nos dois sentidos. Almoco que varou
// das 18h passava a cobrar preco de jantar no meio do servico; jantar que
// comecou 17h40 cobrava almoco na primeira mesa e jantar na segunda. A casa
// sabe em que turno esta - o sistema nao precisa adivinhar.
//
// UM DOCUMENTO POR UNIDADE E DIA. Nao e' historico de aberturas: e' o estado
// de hoje, e o de ontem nao interessa a ninguem. Trocar de turno sobrescreve.
//
// SEM NINGUEM TER ABERTO, o relogio ainda decide - e de proposito: a casa que
// esquecer de abrir o turno nao pode ficar impedida de vender. O relogio vira
// o palpite, nao a regra.
const TURNO_DIA = db.collection('estacaoTurno');
const OPERACAO_DIA = db.collection('estacaoOperacaoDia');
function idTurno(unidade, data) { return `${unidade}__${data}`; }
function idOperacao(unidade, data) { return `${unidade}__${data}`; }
function horaBrasilia(agora = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: FUSO_BR, hour: '2-digit', hourCycle: 'h23' }).format(new Date(agora)));
}
function caixasVazios() {
  return Object.fromEntries(CAIXAS.map((caixa) => [caixa, { caixa, aberto: false, aberturas: 0 }]));
}
function operacaoVazia(unidade, data) {
  return {
    id: idOperacao(unidade, data), unidade, data, status: 'NAO_ABERTO',
    turnoEstado: 'NAO_ABERTO', caixas: caixasVazios(), historicoCaixas: [],
    abertoEm: null, abertoPorEmail: null, fechadoEm: null, fechadoPorEmail: null,
  };
}
async function operacaoDoDia(unidade, data = hojeBrasiliaISO(), agora = new Date()) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  const snap = await OPERACAO_DIA.doc(idOperacao(unidade, data)).get();
  const base = operacaoVazia(unidade, data);
  const d = snap.exists ? { ...base, ...snap.data() } : base;
  d.caixas = { ...caixasVazios(), ...(d.caixas || {}) };
  d.todosCaixasFechados = CAIXAS.every((c) => !d.caixas[c]?.aberto);
  d.teveCaixaAberto = (d.historicoCaixas || []).length > 0 || CAIXAS.some((c) => Number(d.caixas[c]?.aberturas) > 0);
  d.comandasAbertas = [...(await garantirEspelho(unidade)).values()]
    .filter((c) => c.data === data && c.status === 'ABERTA').length;
  d.horaBrasilia = horaBrasilia(agora);
  return d;
}
async function abrirDia(unidade, porEmail, agora = new Date()) {
  const data = hojeBrasiliaISO(agora);
  const ref = OPERACAO_DIA.doc(idOperacao(unidade, data));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const atual = snap.exists ? { ...operacaoVazia(unidade, data), ...snap.data() } : operacaoVazia(unidade, data);
    if (atual.status === 'FECHADO') throw new Error('O dia já foi fechado e não pode ser reaberto.');
    if (atual.status === 'ABERTO') return atual;
    const novo = { ...atual, status: 'ABERTO', abertoEm: new Date(agora).toISOString(), abertoPorEmail: porEmail || null };
    tx.set(ref, novo);
    return novo;
  });
}
async function abrirCaixa({ unidade, caixa, fundo, porEmail, agora = new Date() }) {
  const cx = String(caixa || '');
  if (!CAIXAS.includes(cx)) throw new Error('Caixa inválido.');
  const valorFundo = arred(num(fundo));
  if (valorFundo < 0) throw new Error('Fundo de caixa inválido.');
  const data = hojeBrasiliaISO(agora);
  const ref = OPERACAO_DIA.doc(idOperacao(unidade, data));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().status !== 'ABERTO') throw new Error('Abra o dia antes de abrir o caixa.');
    const atual = { ...operacaoVazia(unidade, data), ...snap.data() };
    atual.caixas = { ...caixasVazios(), ...(atual.caixas || {}) };
    if (atual.caixas[cx]?.aberto) throw new Error(`O Caixa ${cx} já está aberto.`);
    const sessaoId = `${cx}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const abertura = { sessaoId, caixa: cx, fundo: valorFundo, abertoEm: new Date(agora).toISOString(), abertoPorEmail: porEmail || null };
    atual.caixas[cx] = { ...abertura, aberto: true, aberturas: Number(atual.caixas[cx]?.aberturas || 0) + 1 };
    atual.historicoCaixas = [...(atual.historicoCaixas || []), abertura].slice(-100);
    tx.set(ref, atual);
    return atual;
  });
}
async function fecharCaixa({ unidade, caixa, porEmail, agora = new Date() }) {
  const cx = String(caixa || '');
  if (!CAIXAS.includes(cx)) throw new Error('Caixa inválido.');
  const data = hojeBrasiliaISO(agora);
  const ref = OPERACAO_DIA.doc(idOperacao(unidade, data));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().status !== 'ABERTO') throw new Error('O dia não está aberto.');
    const atual = { ...operacaoVazia(unidade, data), ...snap.data() };
    atual.caixas = { ...caixasVazios(), ...(atual.caixas || {}) };
    const estado = atual.caixas[cx];
    if (!estado?.aberto) throw new Error(`O Caixa ${cx} já está fechado.`);
    const fechadoEm = new Date(agora).toISOString();
    atual.caixas[cx] = { ...estado, aberto: false, fechadoEm, fechadoPorEmail: porEmail || null };
    atual.historicoCaixas = (atual.historicoCaixas || []).map((s) => s.sessaoId === estado.sessaoId
      ? { ...s, fechadoEm, fechadoPorEmail: porEmail || null } : s);
    tx.set(ref, atual);
    return atual;
  });
}
async function mudarTurnoOperacao({ unidade, acao, porEmail, agora = new Date() }) {
  const data = hojeBrasiliaISO(agora);
  const ref = OPERACAO_DIA.doc(idOperacao(unidade, data));
  const resultado = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().status !== 'ABERTO') throw new Error('Abra o dia antes de abrir o turno.');
    const atual = { ...operacaoVazia(unidade, data), ...snap.data() };
    atual.caixas = { ...caixasVazios(), ...(atual.caixas || {}) };
    if (acao === 'abrir-almoco') {
      if (atual.turnoEstado !== 'NAO_ABERTO') throw new Error('O almoço já foi aberto hoje.');
      if (!CAIXAS.some((c) => atual.caixas[c]?.aberto)) throw new Error('Abra pelo menos um caixa com o fundo antes de abrir o almoço.');
      atual.turnoEstado = 'ALMOCO_ABERTO';
    } else if (acao === 'virar-jantar') {
      if (atual.turnoEstado !== 'ALMOCO_ABERTO') throw new Error('Abra o almoço antes de virar para o jantar.');
      atual.turnoEstado = 'JANTAR_ABERTO';
    } else if (acao === 'fechar-jantar') {
      if (atual.turnoEstado !== 'JANTAR_ABERTO') throw new Error('O jantar não está aberto.');
      if (horaBrasilia(agora) < 22) throw new Error('O jantar só pode ser fechado a partir das 22h.');
      atual.turnoEstado = 'JANTAR_FECHADO';
    } else throw new Error('Ação de turno inválida.');
    atual.turnoAlteradoEm = new Date(agora).toISOString();
    atual.turnoAlteradoPorEmail = porEmail || null;
    tx.set(ref, atual);
    return atual;
  });
  if (resultado.turnoEstado === 'ALMOCO_ABERTO') await abrirTurno(unidade, 'almoco', porEmail, agora);
  if (resultado.turnoEstado === 'JANTAR_ABERTO') await abrirTurno(unidade, 'jantar', porEmail, agora);
  if (resultado.turnoEstado === 'JANTAR_FECHADO') {
    await TURNO_DIA.doc(idTurno(unidade, data)).set({ estado: 'FECHADO', fechadoEm: new Date(agora).toISOString(), fechadoPorEmail: porEmail || null }, { merge: true });
  }
  return resultado;
}
async function fecharDia({ unidade, porEmail, podeAntecipar = false, agora = new Date() }) {
  const data = hojeBrasiliaISO(agora);
  const abertas = [...(await garantirEspelho(unidade)).values()].filter((c) => c.data === data && c.status === 'ABERTA');
  if (abertas.length) throw new Error(`Ainda existem ${abertas.length} comanda(s) aberta(s). Resolva no caixa antes de fechar o dia.`);
  const ref = OPERACAO_DIA.doc(idOperacao(unidade, data));
  const fechado = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().status !== 'ABERTO') throw new Error('O dia não está aberto.');
    const atual = { ...operacaoVazia(unidade, data), ...snap.data() };
    atual.caixas = { ...caixasVazios(), ...(atual.caixas || {}) };
    if (CAIXAS.some((c) => atual.caixas[c]?.aberto)) throw new Error('Feche todos os caixas antes de fechar o dia.');
    if (!(atual.historicoCaixas || []).length) throw new Error('Nenhum caixa foi aberto neste dia.');
    if (!podeAntecipar && horaBrasilia(agora) < 22) throw new Error('O Caixa só pode fechar o dia a partir das 22h.');
    if (!podeAntecipar && atual.turnoEstado !== 'JANTAR_FECHADO') throw new Error('Feche o jantar antes de fechar o dia.');
    atual.status = 'FECHADO';
    atual.turnoEstado = 'JANTAR_FECHADO';
    atual.fechadoEm = new Date(agora).toISOString();
    atual.fechadoPorEmail = porEmail || null;
    tx.set(ref, atual);
    return atual;
  });
  await TURNO_DIA.doc(idTurno(unidade, data)).set({ estado: 'FECHADO', fechadoEm: fechado.fechadoEm, fechadoPorEmail: porEmail || null }, { merge: true });
  return fechado;
}
async function exigirVendaAberta(unidade, caixa, agora = new Date()) {
  const op = await operacaoDoDia(unidade, hojeBrasiliaISO(agora), agora);
  if (op.status !== 'ABERTO') throw new Error('O dia não está aberto.');
  if (!['ALMOCO_ABERTO', 'JANTAR_ABERTO'].includes(op.turnoEstado)) throw new Error('Abra o almoço ou faça a virada para o jantar antes de vender.');
  if (caixa && !op.caixas[String(caixa)]?.aberto) throw new Error(`Abra o Caixa ${caixa} com o fundo antes de receber.`);
  return op;
}
async function turnoAberto(unidade, data) {
  const snap = await TURNO_DIA.doc(idTurno(unidade, data)).get();
  const d = snap.exists ? snap.data() : null;
  return d && TURNOS.includes(d.turno) ? d : null;
}
// o turno que VALE agora: o que o caixa abriu; sem isso, o palpite do relogio
async function turnoVigente(unidade, data, agora = new Date()) {
  const aberto = await turnoAberto(unidade, data);
  if (aberto) return { turno: aberto.turno, porCaixa: true, abertoEm: aberto.abertoEm, abertoPorEmail: aberto.abertoPorEmail };
  return { turno: turnoDe(agora), porCaixa: false, abertoEm: null, abertoPorEmail: null };
}
async function abrirTurno(unidade, turno, porEmail, agora = new Date()) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  if (!TURNOS.includes(turno)) throw new Error('Turno inválido.');
  const data = hojeBrasiliaISO(agora);
  const registro = {
    unidade, data, turno, abertoEm: new Date(agora).toISOString(), abertoPorEmail: texto(porEmail, 120) || null,
  };
  await TURNO_DIA.doc(idTurno(unidade, data)).set(registro);
  return registro;
}

function turnoDe(agora = new Date()) {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: FUSO_BR, hour: '2-digit', hourCycle: 'h23' }).format(new Date(agora)));
  return h >= HORA_VIRADA_JANTAR ? 'jantar' : 'almoco';
}
// Feriado vira fim de semana NO ALMOÇO e só nele - é o que o cardápio diz
// ("almoço sábado, domingo E FERIADOS"; o jantar não menciona feriado).
function linhaDaTabela(precos, dataISO, turno) {
  const ehFeriado = turno === 'almoco' && (precos.feriados || []).includes(String(dataISO || '').slice(0, 10));
  return ehFeriado ? 'feriado' : diaDaSemanaBR(dataISO);
}
function precoRodizioDoDia(precos, dataISO, tipo, turno) {
  // criança até 5 anos não paga: é 0 sempre, e não depende de tabela
  if (tipo === TIPO_ISENTO) return 0;
  const t = TURNOS.includes(turno) ? turno : 'almoco';
  const linha = linhaDaTabela(precos, dataISO, t);
  const doDia = ((precos && precos.rodizio && precos.rodizio[linha]) || {})[t] || { adulto: 0, crianca: 0 };
  return num(tipo === 'crianca' ? doDia.crianca : doDia.adulto);
}

// --------------------------------------------------- espelho das abertas
//
// Map(unidade -> { em, comandas: Map(id -> comanda) }). Só as ABERTAS: comanda
// paga sai do espelho na hora e vira histórico, que ninguém fica recarregando.
const espelho = new Map();
const ESPELHO_TTL_MS = 5 * 60 * 1000;

async function listarAbertasUncached(unidade) {
  const snap = await COMANDAS.where('unidade', '==', unidade).where('status', '==', 'ABERTA').get();
  return snap.docs.map((d) => d.data());
}

async function garantirEspelho(unidade) {
  const atual = espelho.get(unidade);
  if (atual && Date.now() - atual.em < ESPELHO_TTL_MS) return atual.comandas;
  const lista = await listarAbertasUncached(unidade);
  const mapa = new Map(lista.map((c) => [c.id, c]));
  espelho.set(unidade, { em: Date.now(), comandas: mapa });
  return mapa;
}

// grava no Firestore E aplica o patch no espelho - nunca invalida o espelho
// inteiro (CLAUDE.md §3: uma escrita não pode custar a releitura de tudo)
async function gravarEEspelhar(comanda) {
  await COMANDAS.doc(comanda.id).set(comanda, { merge: true });
  return aplicarNoEspelho(comanda);
}

// Uma transação pode gravar pagamento e várias comandas de uma só vez. Depois
// que ela confirma, atualizamos o espelho sem fazer uma segunda gravação.
async function aplicarNoEspelho(comanda) {
  const mapa = await garantirEspelho(comanda.unidade);
  if (comanda.status === 'ABERTA') mapa.set(comanda.id, comanda);
  else mapa.delete(comanda.id);
  return comanda;
}

function _limparEspelhoTeste() { espelho.clear(); }

// ------------------------------------------------------------ comandas

async function abertaDoNumero(unidade, numero) {
  const mapa = await garantirEspelho(unidade);
  for (const c of mapa.values()) if (c.numero === numero) return c;
  return null;
}

function sanitizarNumero(v) {
  const n = Math.trunc(num(v));
  if (!(n > 0) || n > 999999) throw new Error('Número de comanda inválido.');
  return n;
}
// MESA E' OBRIGATORIA (decisao do Master, 14/09/2026).
//
// Muda o desenho original: a comanda continua sendo a unidade atomica (cada
// pessoa e' uma conta), mas ela nasce JA numa mesa em vez de ser vinculada
// depois. O motivo e' o QR Code: cada mesa tem o seu, colado nela, e ler o
// codigo tem de responder "quem esta aqui e quanto deu" - comanda sem mesa nao
// aparece em QR nenhum e vira dinheiro que ninguem acha.
//
// definirMesa() continua existindo: a pessoa troca de mesa, e o cartao vai
// junto. O que deixou de existir e' comanda SEM mesa.
function sanitizarMesa(v, { obrigatoria = false } = {}) {
  if (v === null || v === undefined || v === '') {
    if (obrigatoria) throw new Error('Informe a mesa: é ela que o QR Code identifica, e é por ela que a conta é encontrada.');
    return null;
  }
  const n = Math.trunc(num(v));
  if (!(n > 0) || n > 9999) throw new Error('Número de mesa inválido.');
  return n;
}

async function abrirComanda({ unidade, unidadeNome, numero, mesa, tipoRodizio, porEmail, agora = new Date() }) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  // A MESA VEM PRIMEIRO, antes de qualquer leitura: é ela que o QR Code
  // identifica. Barrar aqui também custa zero no Firestore - comanda sem mesa
  // nem chega a consultar número repetido nem tabela de preço (§3).
  const mesaN = sanitizarMesa(mesa, { obrigatoria: true });
  const n = sanitizarNumero(numero);
  const tipo = TIPOS_RODIZIO.includes(tipoRodizio) ? tipoRodizio : null;
  if (!tipo) throw new Error('Escolha se a comanda é rodízio adulto ou criança.');
  // UMA aberta por número: sem isso, a 7541 entregue de novo à noite somaria
  // o consumo da pessoa que já foi embora
  const data = hojeBrasiliaISO(agora);
  const precos = await getPrecos(unidade);
  // o turno vem do CAIXA (ver turnoVigente) - o relogio so opina se ninguem abriu
  const vigente = await turnoVigente(unidade, data, agora);
  const turno = vigente.turno;
  const precoRodizio = precoRodizioDoDia(precos, data, tipo, turno);
  // criança até 5 anos custa 0 DE PROPÓSITO - só ela pode passar sem preço
  if (tipo !== TIPO_ISENTO && !(precoRodizio > 0)) {
    const porque = vigente.porCaixa
      ? `o caixa abriu o ${ROTULO_TURNO[turno]}`
      : `ninguém abriu turno hoje, então vale o horário (${ROTULO_TURNO[turno]})`;
    throw new Error(`O rodízio ${ROTULO_TIPO[tipo]} do ${ROTULO_TURNO[turno]} de ${linhaDaTabela(precos, data, turno)} não tem preço cadastrado - ${porque}. Preencha essa linha na tabela de preços (Fechamento do dia), ou troque o turno no caixa.`);
  }
  const ref = COMANDAS.doc();
  const comanda = {
    id: ref.id,
    unidade,
    unidadeNome: unidadeNome || unidade,
    numero: n,
    data,
    status: 'ABERTA',
    mesa: mesaN,
    tipoRodizio: tipo,
    turno,              // almoço ou jantar, pela hora em que ela foi aberta
    precoRodizio,       // congelado aqui: mudar a tabela não reescreve o passado
    itens: [],
    abertaEm: new Date(agora).toISOString(),
    abertaPorEmail: porEmail || null,
    pagaEm: null, pagaPorEmail: null, caixa: null, pagamentoId: null,
  };
  // A verificação e a criação precisam ser a MESMA operação. Sem transação,
  // dois tablets podem ler "livre" e entregar o mesmo cartão duas vezes.
  await db.runTransaction(async (tx) => {
    const abertas = await tx.get(COMANDAS.where('unidade', '==', unidade).where('status', '==', 'ABERTA'));
    const jaAberta = abertas.docs.map((d) => d.data()).find((c) => c.numero === n);
    if (jaAberta) {
      throw new Error(`A comanda ${n} já está aberta${jaAberta.mesa ? ` na mesa ${jaAberta.mesa}` : ''}. Feche no caixa antes de entregar esse cartão de novo.`);
    }
    tx.set(ref, comanda);
  });
  return aplicarNoEspelho(comanda);
}

// mudar de mesa é rotina (o grupo troca de lugar, ou o garçom errou o número)
// Trocar de mesa é rotina (o grupo muda de lugar, ou o garçom errou o número)
// - e por isso mesmo fica REGISTRADO. Sem o histórico, "essa comanda estava na
// 92, agora está na 110" vira palavra contra palavra quando a conta da mesa
// não bate no fim da noite.
async function definirMesa(id, mesa, porEmail) {
  const comanda = await getComanda(id);
  if (comanda.status !== 'ABERTA') throw new Error('Essa comanda já foi fechada.');
  const nova = sanitizarMesa(mesa, { obrigatoria: true });
  const anterior = comanda.mesa || null;
  // só registra TROCA de verdade: salvar a mesma mesa de novo não é evento
  const historicoMesa = anterior === nova
    ? (comanda.historicoMesa || [])
    : [...(comanda.historicoMesa || []), { de: anterior, para: nova, em: new Date().toISOString(), porEmail: porEmail || null }].slice(-20);
  return gravarEEspelhar({ ...comanda, mesa: nova, mesaPorEmail: porEmail || null, historicoMesa });
}

async function getComanda(id) {
  const snap = await COMANDAS.doc(String(id || '')).get();
  if (!snap.exists) throw new Error('Comanda não encontrada.');
  return snap.data();
}

// Lançar bebida/sobremesa. O preço vem do CATÁLOGO da unidade (inventario),
// nunca do navegador, e fica congelado na linha - igual ao balcão do
// Saltiverso.
async function lancarItem({ comandaId, itemId, quantidade, porEmail, agora = new Date() }) {
  const comanda = await getComanda(comandaId);
  if (comanda.status !== 'ABERTA') throw new Error('Essa comanda já foi fechada.');
  const qtd = num(quantidade) || 1;
  if (!(qtd > 0) || qtd > 99) throw new Error('Quantidade inválida.');
  const catalogo = await inventario.listCatalogo(comanda.unidade);
  const item = catalogo.find((i) => i.id === itemId);
  if (!item) throw new Error('Item não encontrado no catálogo dessa unidade.');
  if (!(item.precoVenda > 0)) throw new Error(`"${item.nome}" não tem preço de venda cadastrado.`);
  const linha = {
    itemId: item.id,
    nome: item.nome,
    quantidade: qtd,
    precoUnitario: num(item.precoVenda),
    em: new Date(agora).toISOString(),
    porEmail: porEmail || null,
  };
  return gravarEEspelhar({ ...comanda, itens: [...(comanda.itens || []), linha] });
}

// Tirar uma linha lançada errado. Pelo ÍNDICE e com o nome conferido: no
// salão cheio, duas linhas iguais na mesma comanda são comuns (dois chopps),
// e apagar "o chopp" apagaria o errado.
async function removerItem({ comandaId, indice, nome, porEmail }) {
  const comanda = await getComanda(comandaId);
  if (comanda.status !== 'ABERTA') throw new Error('Essa comanda já foi fechada.');
  const itens = [...(comanda.itens || [])];
  const i = Math.trunc(num(indice));
  if (!(i >= 0) || i >= itens.length) throw new Error('Lançamento não encontrado.');
  if (nome && texto(itens[i].nome, 80) !== texto(nome, 80)) {
    throw new Error('A lista mudou desde que você abriu a tela - confira de novo antes de remover.');
  }
  const [removida] = itens.splice(i, 1);
  const remocoes = [...(comanda.remocoes || []), { ...removida, removidoEm: new Date().toISOString(), removidoPorEmail: porEmail || null }];
  return gravarEEspelhar({ ...comanda, itens, remocoes });
}

async function cancelarComanda({ id, motivo, porEmail }) {
  const comanda = await getComanda(id);
  if (comanda.status === 'PAGA') throw new Error('Comanda já paga não pode ser cancelada.');
  if (comanda.status === 'CANCELADA') return comanda;
  const texto_ = texto(motivo, 200);
  if (!texto_) throw new Error('Diga por que está cancelando.');
  return gravarEEspelhar({
    ...comanda, status: 'CANCELADA',
    canceladaEm: new Date().toISOString(), canceladaPorEmail: porEmail || null, motivoCancelamento: texto_,
  });
}

// Excluir uma mesa no Caixa significa CANCELAR todas as comandas que ainda
// estão abertas nela. Nada é apagado: cada cartão guarda motivo, data e Master
// responsável. A transação evita deixar metade da mesa cancelada se uma das
// comandas tiver sido paga em outro caixa entre a abertura do modal e o OK.
async function cancelarMesa({ unidade, mesa, motivo, porEmail }) {
  const numeroMesa = Math.trunc(num(mesa));
  if (!unidade || !(numeroMesa > 0)) throw new Error('Mesa inválida.');
  const texto_ = texto(motivo, 200);
  if (!texto_) throw new Error('Diga por que está excluindo a mesa.');
  const abertas = [...(await garantirEspelho(unidade)).values()]
    .filter((c) => c.status === 'ABERTA' && Number(c.mesa) === numeroMesa);
  if (!abertas.length) throw new Error('Essa mesa não tem comandas abertas.');
  const em = new Date().toISOString();
  const canceladas = await db.runTransaction(async (tx) => {
    const atuais = [];
    for (const aberta of abertas) {
      const snap = await tx.get(COMANDAS.doc(aberta.id));
      if (!snap.exists || snap.data().status !== 'ABERTA') {
        throw new Error(`A comanda ${aberta.numero} mudou enquanto você confirmava. Atualize e confira novamente.`);
      }
      const atual = snap.data();
      if (atual.unidade !== unidade || Number(atual.mesa) !== numeroMesa) {
        throw new Error(`A comanda ${aberta.numero} não pertence mais a essa mesa.`);
      }
      atuais.push(atual);
    }
    atuais.forEach((c) => tx.set(COMANDAS.doc(c.id), {
      status: 'CANCELADA', canceladaEm: em, canceladaPorEmail: porEmail || null,
      motivoCancelamento: texto_, canceladaComMesa: numeroMesa,
    }, { merge: true }));
    return atuais.map((c) => ({ ...c, status: 'CANCELADA', canceladaEm: em,
      canceladaPorEmail: porEmail || null, motivoCancelamento: texto_, canceladaComMesa: numeroMesa }));
  });
  await Promise.all(canceladas.map(aplicarNoEspelho));
  return { unidade, mesa: numeroMesa, quantidade: canceladas.length, comandas: canceladas };
}

// ------------------------------------------------------------- totais
//
// Pura, e usada nos dois lados (tela e cobrança) - duas contas diferentes pro
// mesmo valor é como um PDV passa a mentir.
function totaisDaComanda(comanda, servicoPct, comServico = true) {
  const consumo = arred((comanda.itens || []).reduce((s, i) => s + num(i.quantidade) * num(i.precoUnitario), 0));
  const rodizio = num(comanda.precoRodizio);
  const subtotal = arred(rodizio + consumo);
  const pct = comServico ? Math.min(100, Math.max(0, num(servicoPct))) : 0;
  const servico = arred(subtotal * (pct / 100));
  return { rodizio, consumo, subtotal, servicoPct: pct, servico, total: arred(subtotal + servico) };
}

// ------------------------------------------------------------- salão
//
// Mesas derivadas das comandas abertas (ver cabeçalho): nada é gravado, nada
// pode dessincronizar. Comanda sem mesa aparece à parte - é quem já recebeu o
// cartão na porta mas ainda não sentou.
async function salao(unidade, comServico = true) {
  const mapa = await garantirEspelho(unidade);
  const precos = await getPrecos(unidade);
  const abertas = [...mapa.values()];
  const porMesa = new Map();
  const semMesa = [];
  abertas.forEach((c) => {
    const t = totaisDaComanda(c, precos.servicoPct, comServico);
    const resumo = { ...c, totais: t };
    if (!c.mesa) { semMesa.push(resumo); return; }
    if (!porMesa.has(c.mesa)) porMesa.set(c.mesa, { mesa: c.mesa, pessoas: 0, consumo: 0, subtotal: 0, comandas: [], desde: c.abertaEm });
    const m = porMesa.get(c.mesa);
    m.pessoas += 1;
    m.consumo = arred(m.consumo + t.consumo);
    m.subtotal = arred(m.subtotal + t.subtotal);
    m.comandas.push(resumo);
    if (c.abertaEm < m.desde) m.desde = c.abertaEm;
  });
  return {
    unidade,
    servicoPct: precos.servicoPct,
    mesas: [...porMesa.values()].sort((a, b) => a.mesa - b.mesa),
    semMesa: semMesa.sort((a, b) => a.numero - b.numero),
    pessoas: abertas.length,
    subtotalAberto: arred(abertas.reduce((s, c) => s + totaisDaComanda(c, precos.servicoPct, comServico).subtotal, 0)),
  };
}

// ------------------------------------------------- venda de balcão
//
// O caixa NÃO lança consumo de mesa - isso é do garçom, e a separação é de
// propósito (ver as seções). Mas ele vende o que está ao alcance da mão:
// "o cliente quer uma água, um refri na hora de ir embora" (Master,
// 14/09/2026). Então existe uma lista curta de itens marcados como
// disponíveis no balcão, e o caixa só vende esses - se pudesse vender o
// catálogo inteiro, chopp sairia sem passar pelo salão.
//
// Quem marca é o Master ou o Gerente da unidade, no próprio item do catálogo
// (campo noBalcao) - não há cadastro paralelo: item é item, e duas listas do
// mesmo produto divergem.
//
// SEM os 10%: garrafa levada na saída não é serviço de mesa. Se um dia
// precisar entrar, é uma linha - mas não invento cobrança.
async function itensDoBalcao(unidade) {
  const catalogo = await inventario.listCatalogo(unidade);
  return catalogo.filter((i) => i.ativo !== false && i.noBalcao === true && i.precoVenda > 0);
}

function sanitizarItensBalcao(lista) {
  if (!Array.isArray(lista)) return [];
  return lista
    .map((l) => ({ itemId: texto(l && l.itemId, 80), quantidade: Math.trunc(num(l && l.quantidade)) || 1 }))
    .filter((l) => l.itemId && l.quantidade > 0 && l.quantidade <= 99);
}

// preço SEMPRE do catálogo, e só do que está liberado pro balcão
async function resolverItensBalcao(unidade, lista) {
  const pedidos = sanitizarItensBalcao(lista);
  if (!pedidos.length) return { itens: [], total: 0 };
  const disponiveis = new Map((await itensDoBalcao(unidade)).map((i) => [i.id, i]));
  const itens = pedidos.map((l) => {
    const item = disponiveis.get(l.itemId);
    if (!item) throw new Error('Esse item não está liberado pra venda no balcão. Peça pro Master ou Gerente marcar no catálogo.');
    return { itemId: item.id, nome: item.nome, quantidade: l.quantidade, precoUnitario: num(item.precoVenda) };
  });
  return { itens, total: arred(itens.reduce((t, i) => t + i.quantidade * i.precoUnitario, 0)) };
}

// ------------------------------------------------------------- caixa
//
// Receber UMA OU VÁRIAS comandas de uma vez ("se alguém quiser pagar 2, 3
// pessoas é só informar os números das comandas"). O caixa manda NÚMEROS, que
// é o que ele lê no cartão; o servidor resolve pra sessão aberta de cada um.
async function contaDe(unidade, numeros, comServico = true, itensBalcao = []) {
  const precos = await getPrecos(unidade);
  const lista = Array.isArray(numeros) ? numeros : (numeros === undefined || numeros === null || numeros === '' ? [] : [numeros]);
  const vistos = new Set();
  const comandas = [];
  for (const bruto of lista) {
    const n = sanitizarNumero(bruto);
    if (vistos.has(n)) continue;   // digitou o mesmo número duas vezes
    vistos.add(n);
    const c = await abertaDoNumero(unidade, n);
    if (!c) throw new Error(`A comanda ${n} não está aberta. Confira o número no cartão.`);
    comandas.push({ ...c, totais: totaisDaComanda(c, precos.servicoPct, comServico) });
  }
  const balcao = await resolverItensBalcao(unidade, itensBalcao);
  // venda de balcão SEM comanda é venda válida (quem só passou pra comprar
  // uma água); o que não existe é pagamento sem nada dentro
  if (!comandas.length && !balcao.itens.length) throw new Error('Informe pelo menos uma comanda ou um item do balcão.');
  const soma = (campo) => arred(comandas.reduce((s, c) => s + c.totais[campo], 0));
  return {
    comandas,
    servicoPct: comServico ? precos.servicoPct : 0,
    rodizio: soma('rodizio'), consumo: soma('consumo'), subtotal: soma('subtotal'),
    servico: soma('servico'),
    // o balcão entra DEPOIS do serviço, e por isso fica num campo próprio:
    // é o que deixa o fechamento separar venda de mesa de venda de balcão
    itensBalcao: balcao.itens, balcao: balcao.total,
    total: arred(soma('total') + balcao.total),
  };
}

function sanitizarPagamentos(lista) {
  if (!Array.isArray(lista)) return [];
  return lista
    .map((p) => ({
      forma: FORMAS_PAGAMENTO_SPLIT.includes(p && p.forma) ? p.forma : null,
      valor: arred(Math.max(0, num(p && p.valor))),
    }))
    .filter((p) => p.forma && p.valor > 0);
}

async function receber({ unidade, unidadeNome, numeros, caixa, pagamentos, comServico = true, itensBalcao = [], porEmail, agora = new Date() }) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  if (!CAIXAS.includes(String(caixa))) throw new Error(`Caixa inválido - use ${CAIXAS.join(', ')}.`);
  const conta = await contaDe(unidade, numeros, comServico, itensBalcao);
  const pagosOk = sanitizarPagamentos(pagamentos);
  if (!pagosOk.length) throw new Error('Informe pelo menos uma forma de pagamento.');
  const somaPag = arred(pagosOk.reduce((s, p) => s + p.valor, 0));
  if (Math.abs(somaPag - conta.total) > 0.01) {
    throw new Error(`A soma das formas de pagamento (R$${somaPag.toFixed(2)}) precisa bater com o total (R$${conta.total.toFixed(2)}).`);
  }
  const data = hojeBrasiliaISO(agora);
  const ref = PAGAMENTOS.doc();
  const registro = {
    id: ref.id, unidade, unidadeNome: unidadeNome || unidade, data,
    caixa: String(caixa),
    comandaIds: conta.comandas.map((c) => c.id),
    numeros: conta.comandas.map((c) => c.numero),
    mesas: [...new Set(conta.comandas.map((c) => c.mesa).filter(Boolean))],
    pessoas: conta.comandas.length,
    rodizio: conta.rodizio, consumo: conta.consumo, subtotal: conta.subtotal,
    servicoPct: conta.servicoPct, servico: conta.servico,
    itensBalcao: conta.itensBalcao, balcao: conta.balcao,
    total: conta.total,
    pagamentos: pagosOk,
    em: new Date(agora).toISOString(),
    porEmail: porEmail || null,
  };
  // Pagamento e baixa das comandas são indivisíveis. A transação também
  // impede cobrança dupla se o caixa der dois toques ou dois terminais
  // tentarem receber a mesma comanda ao mesmo tempo.
  const comandasPagas = await db.runTransaction(async (tx) => {
    const atuais = [];
    for (const c of conta.comandas) {
      const snap = await tx.get(COMANDAS.doc(c.id));
      if (!snap.exists || snap.data().status !== 'ABERTA') {
        throw new Error(`A comanda ${c.numero} acabou de ser fechada. Atualize a conta antes de receber.`);
      }
      const atual = snap.data();
      const totalAtual = totaisDaComanda(atual, conta.servicoPct, comServico).total;
      if (Math.abs(totalAtual - c.totais.total) > 0.01) {
        throw new Error(`A conta da comanda ${c.numero} mudou. Atualize antes de receber.`);
      }
      atuais.push({ ...atual, totais: totaisDaComanda(atual, conta.servicoPct, comServico) });
    }
    tx.set(ref, registro);
    atuais.forEach((c) => tx.set(COMANDAS.doc(c.id), {
      status: 'PAGA', pagaEm: registro.em, pagaPorEmail: porEmail || null, caixa: registro.caixa, pagamentoId: registro.id,
      totalCobrado: c.totais.total, servicoCobrado: c.totais.servico,
    }, { merge: true }));
    return atuais.map((c) => ({ ...c, totais: undefined, status: 'PAGA', pagaEm: registro.em, pagaPorEmail: porEmail || null, caixa: registro.caixa, pagamentoId: registro.id, totalCobrado: c.totais.total, servicoCobrado: c.totais.servico }));
  });
  await Promise.all(comandasPagas.map(aplicarNoEspelho));
  // baixa de estoque por bebida vendida (rastreabilidade - mesma ideia do
  // balcão do Saltiverso). Falha aqui NÃO desfaz o pagamento: o dinheiro já
  // entrou, e estoque se reconcilia na contagem.
  const paraBaixar = [
    ...conta.comandas.flatMap((c) => (c.itens || []).map((i) => ({ ...i, de: `Comanda ${c.numero}` }))),
    ...conta.itensBalcao.map((i) => ({ ...i, de: 'Balcão' })),
  ];
  for (const grupo of [{ itens: paraBaixar }]) {
    for (const item of grupo.itens) {
      try {
        await inventario.criarSaida({
          unidade, unidadeNome: unidadeNome || unidade, itemId: item.itemId, tipo: 'VENDA',
          quantidade: item.quantidade, motivo: `${item.de} · Estação da Comida`,
          data, valorUnitario: item.precoUnitario, vendaId: registro.id,
        });
      } catch (e) {
        console.error('estacaoComida: baixa de estoque falhou (pagamento mantido). %s', e.message);
      }
    }
  }
  return registro;
}

// -------------------------------------------------------- fechamento
//
// O dia por caixa e consolidado. Serviço separado da venda de propósito: são
// dinheiros com destino diferente.
const pagamentosDoDiaCache = createCache(async (chave) => {
  const [unidade, data] = String(chave).split('|');
  const snap = await PAGAMENTOS.where('unidade', '==', unidade).where('data', '==', data).get();
  return snap.docs.map((d) => d.data());
}, 30 * 1000);

async function fechamentoDoDia(unidade, data) {
  const dia = data || hojeBrasiliaISO();
  const pagos = await pagamentosDoDiaCache.cached(`${unidade}|${dia}`);
  // "pagamentos" é o número de recebimentos (uma conta pode juntar várias
  // pessoas). "comandasFechadas" é a quantidade real de cartões que passaram
  // pelo caixa, que é o número usado para comparar com as ainda em atendimento.
  const vazio = () => ({ pagamentos: 0, comandasFechadas: 0, pessoas: 0, rodizio: 0, consumo: 0, subtotal: 0, servico: 0, balcao: 0, total: 0, formas: {} });
  const total = vazio();
  const porCaixa = new Map(CAIXAS.map((c) => [c, { caixa: c, ...vazio() }]));
  pagos.forEach((p) => {
    const alvos = [total, porCaixa.get(p.caixa) || porCaixa.set(p.caixa, { caixa: p.caixa, ...vazio() }).get(p.caixa)];
    alvos.forEach((a) => {
      a.pagamentos += 1;
      a.comandasFechadas += Array.isArray(p.numeros) ? p.numeros.length : num(p.pessoas);
      a.pessoas += num(p.pessoas);
      a.rodizio = arred(a.rodizio + num(p.rodizio));
      a.consumo = arred(a.consumo + num(p.consumo));
      a.subtotal = arred(a.subtotal + num(p.subtotal));
      a.servico = arred(a.servico + num(p.servico));
      a.balcao = arred(a.balcao + num(p.balcao));
      a.total = arred(a.total + num(p.total));
      (p.pagamentos || []).forEach((f) => { a.formas[f.forma] = arred(num(a.formas[f.forma]) + num(f.valor)); });
    });
  });
  // o que ficou aberto é parte do fechamento, não uma nota de rodapé: mesa que
  // sobrou às 23h é gente que saiu sem pagar ou comanda que ninguém baixou
  const abertas = [...(await garantirEspelho(unidade)).values()].filter((c) => c.data === dia);
  const precos = await getPrecos(unidade);
  return {
    unidade, data: dia,
    total: { ...total, ticketMedio: total.pessoas ? arred(total.total / total.pessoas) : 0 },
    porCaixa: [...porCaixa.values()].filter((c) => c.pagamentos > 0 || CAIXAS.includes(c.caixa)),
    abertas: abertas.map((c) => ({ ...c, totais: totaisDaComanda(c, precos.servicoPct) })).sort((a, b) => a.numero - b.numero),
    subtotalAberto: arred(abertas.reduce((s, c) => s + totaisDaComanda(c, precos.servicoPct).subtotal, 0)),
  };
}

function invalidarFechamento() { pagamentosDoDiaCache.invalidar(); }

module.exports = {
  STATUS, TIPOS_RODIZIO, CAIXAS, DIAS_SEMANA, SERVICO_PCT_PADRAO,
  hojeBrasiliaISO, diaDaSemanaBR,
  getPrecos, salvarPrecos, precoRodizioDoDia, precosVazios, turnoDe, linhaDaTabela,
  turnoAberto, turnoVigente, abrirTurno,
  operacaoDoDia, abrirDia, abrirCaixa, fecharCaixa, mudarTurnoOperacao, fecharDia, exigirVendaAberta, horaBrasilia,
  TURNOS, TIPO_ISENTO, ROTULO_TIPO, ROTULO_TURNO, HORA_VIRADA_JANTAR,
  itensDoBalcao, resolverItensBalcao,
  abrirComanda, definirMesa, getComanda, lancarItem, removerItem, cancelarComanda, cancelarMesa,
  totaisDaComanda, salao, contaDe, receber, abertaDoNumero,
  fechamentoDoDia, invalidarFechamento,
  _limparEspelhoTeste,
};

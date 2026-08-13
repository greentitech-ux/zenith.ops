// rhCheckin.js
// Check-in/check-out por foto - resolve o pedido do usuario de "identificar
// no dia que for" um extra que nao trabalha todo dia: em vez de depender do
// gerente lembrar quem apareceu, a propria pessoa se identifica num
// dispositivo fixo na entrada da loja (tablet/PC com webcam), escolhe o
// proprio nome na ficha ja cadastrada em rh.js e tira uma foto na entrada;
// na saida, repete o processo pra fechar o check-in. A foto e o horario sao
// o registro/prova de quem esteve na loja e quando - sem reconhecimento
// facial nem nada automatico, so tira a duvida "quem apareceu hoje" com
// prova visual e timestamp.
//
// So faz check-in aqui quem AINDA NAO tem vinculo formal - extra (avulso) e
// candidato em teste de 5 dias (ver elegivelParaCheckin). Colaborador
// efetivado (direto ou promovido do teste) NAO usa esse quiosque - ele bate
// o ponto no sistema de ponto de verdade, fora do Zenith.
//
// Dois freios pedidos pelo usuario, resolvidos com uma pendencia de
// aprovacao (status 'pendente_aprovacao') em vez de bloquear liso:
// - extra so pode entrar ate 3x por semana - da 4a tentativa em diante, a
//   entrada fica pendente ate o RH (tag "RH todas as unidades")/Admin/Master
//   aprovar - aprovar ja registra a entrada na hora (ver aprovarPendencia).
// - candidato que passou do 5o dia de teste sem decisao (efetivar/desligar)
//   tambem cai em pendencia pra abrir uma NOVA entrada - se ja estiver com
//   check-in aberto, o check-out continua liberado normalmente.
//
// Colecao propria (rhCheckins), separada de rhFuncionarios (rh.js), porque
// cresce todo dia (um par entrada/saida por pessoa por dia), enquanto a
// ficha de funcionarios muda pouco - mesmo raciocinio de festas.js/parque.js
// serem modulos separados dentro do mesmo dominio (Saltiverso).
const db = require('./firestore');
const { createCache } = require('./liveCache');
const rh = require('./rh');

const COLLECTION = db.collection('rhCheckins');

const LIMITE_CHECKINS_SEMANA_EXTRA = 3;

function hojeBrasilia() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

// segunda-feira da semana atual (Brasilia), formato YYYY-MM-DD - usado como
// corte pra contar quantas entradas o extra ja fez "essa semana"
function inicioSemanaBrasilia() {
  const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const diaSemana = agora.getDay(); // 0=domingo .. 6=sabado
  const diffSegunda = diaSemana === 0 ? 6 : diaSemana - 1;
  agora.setDate(agora.getDate() - diffSegunda);
  agora.setHours(0, 0, 0, 0);
  const y = agora.getFullYear();
  const m = String(agora.getMonth() + 1).padStart(2, '0');
  const d = String(agora.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function listAllUncached() {
  // limite de seguranca - nao precisa do historico inteiro em memoria pra
  // sempre, os usos reais (check-ins de hoje, quem esta aberto agora) sao
  // recentes; se precisar de historico mais antigo no futuro da pra paginar
  // direto no Firestore por unidade+data
  const snap = await COLLECTION.orderBy('criadoEm', 'desc').limit(3000).get();
  return snap.docs.map((d) => d.data());
}
const checkinCache = createCache(listAllUncached, 30 * 1000);
const listAll = checkinCache.cached;

async function getOne(id) {
  const doc = await COLLECTION.doc(id).get();
  return doc.exists ? doc.data() : null;
}

// quem pode fazer check-in por aqui: extra "ativo", efetivado "ativo" (via
// link de auto-atendimento, ver rh-colaborador.html) ou candidato ainda em
// teste. So candidato tem status proprio ('candidato'); extra e efetivado
// caem no mesmo criterio (status 'ativo'), diferenciados so pelo limite
// semanal de 3x que continua exclusivo do extra (ver registrarEntrada)
function elegivelParaCheckin(funcionario) {
  if (!funcionario) return false;
  if (funcionario.tipoCadastro === 'candidato') return funcionario.status === 'candidato';
  return funcionario.status === 'ativo';
}

// registra a ENTRADA - so deixa 1 check-in aberto por vez por pessoa (se ja
// tem um aberto, tem que fechar - checkout - antes de abrir outro). A
// localizacao (se o navegador conseguiu, silenciosamente, sem UI propria
// pedindo - so o prompt nativo do proprio navegador) fica guardada mas so e
// exposta pro Master nas rotas de leitura (ver sanitizarCheckin em index.js)
async function registrarEntrada({ funcionarioId, foto, localizacao, registradoPorEmail }) {
  const funcionario = await rh.getOne(funcionarioId);
  if (!funcionario) throw new Error('Funcionário não encontrado.');
  if (!elegivelParaCheckin(funcionario)) throw new Error('Esse colaborador não faz check-in por aqui - já bate ponto no sistema próprio.');

  const todos = await listAll();
  const aberto = todos.find((c) => c.funcionarioId === funcionarioId && c.status === 'aberto');
  if (aberto) throw new Error(`${funcionario.nome} já tem um check-in em aberto - faça o check-out antes de um novo check-in.`);
  const pendente = todos.find((c) => c.funcionarioId === funcionarioId && c.status === 'pendente_aprovacao');
  if (pendente) throw new Error(`${funcionario.nome} já tem uma solicitação de check-in aguardando aprovação do RH.`);

  let motivoPendencia = null;
  if (funcionario.tipoCadastro === 'extra') {
    const inicioSemana = inicioSemanaBrasilia();
    // entrada.horario e ISO em UTC; a segunda 00:00 de Brasilia e 03:00Z
    // (offset fixo -03:00, Brasil nao tem mais horario de verao) - sem a
    // conversao, a "semana" comecava 3h mais cedo e contava check-ins de
    // domingo a noite como se fossem da semana nova
    const corteUtc = new Date(`${inicioSemana}T00:00:00-03:00`).toISOString();
    const feitosNaSemana = todos.filter((c) => (
      c.funcionarioId === funcionarioId && c.status !== 'pendente_aprovacao' && c.status !== 'recusado'
      && c.entrada && c.entrada.horario >= corteUtc
    )).length;
    if (feitosNaSemana >= LIMITE_CHECKINS_SEMANA_EXTRA) motivoPendencia = 'limite_semanal_extra';
  } else if (funcionario.tipoCadastro === 'candidato') {
    if (!funcionario.feedbackTeste && rh.diasDesde(funcionario.dataAdmissao) >= rh.DIAS_TESTE_ALERTA) motivoPendencia = 'teste_vencido_sem_decisao';
  }

  const ref = COLLECTION.doc();
  const agora = new Date().toISOString();
  const registro = {
    id: ref.id,
    funcionarioId,
    funcionarioNome: funcionario.nome,
    unidade: funcionario.unidade,
    data: hojeBrasilia(),
    entrada: { horario: agora, foto: foto || null, localizacao: localizacao || null, registradoPorEmail: registradoPorEmail || null },
    saida: null,
    status: motivoPendencia ? 'pendente_aprovacao' : 'aberto',
    motivoPendencia,
    decisaoPendencia: null,
    criadoEm: agora,
    atualizadoEm: agora,
  };
  await ref.set(registro);
  checkinCache.invalidar();
  return registro;
}

// registra a SAIDA de um check-in aberto especifico - nao depende de tipo
// nem status do funcionario (se ja tem entrada aberta, closeout sempre vale)
async function registrarSaida(id, { foto, localizacao, registradoPorEmail }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Check-in não encontrado.');
  const atual = snap.data();
  if (atual.status !== 'aberto') throw new Error('Esse check-in já foi encerrado.');
  const agora = new Date().toISOString();
  const merge = {
    saida: { horario: agora, foto: foto || null, localizacao: localizacao || null, registradoPorEmail: registradoPorEmail || null },
    status: 'fechado',
    atualizadoEm: agora,
  };
  await ref.update(merge);
  checkinCache.invalidar();
  return { ...atual, ...merge };
}

async function buscarAbertoDoFuncionario(funcionarioId) {
  const todos = await listAll();
  return todos.find((c) => c.funcionarioId === funcionarioId && c.status === 'aberto') || null;
}

// todos os check-ins (qualquer status/data) de 1 funcionario - usado pelo
// mesclarDuplicados de rh.js pra decidir qual cadastro duplicado manter (o
// que tem check-in fechado) e limpar os check-ins do que vai ser removido
async function listPorFuncionario(funcionarioId) {
  return (await listAll()).filter((c) => c.funcionarioId === funcionarioId);
}

// mesmo padrao de filtro em memoria sobre o cache compartilhado usado em
// rh.js/festas.js/parque.js - unidades null = sem filtro (Master/Admin/RH
// todas unidades ja resolvem isso em index.js antes de chamar)
async function listByUnidadesData(unidades, data) {
  const dataAlvo = data || hojeBrasilia();
  const todos = (await listAll()).filter((c) => c.data === dataAlvo);
  if (unidades == null) return todos;
  if (!unidades.length) return [];
  const alvo = new Set(unidades);
  return todos.filter((c) => alvo.has(c.unidade));
}

// quem esta com check-in aberto agora (ainda nao fez check-out) - "quem
// esta na loja agora"
async function listAbertos(unidades) {
  const todos = (await listAll()).filter((c) => c.status === 'aberto');
  if (unidades == null) return todos;
  if (!unidades.length) return [];
  const alvo = new Set(unidades);
  return todos.filter((c) => alvo.has(c.unidade));
}

// pedidos de check-in aguardando aprovacao do RH/Admin/Master (extra que
// passou do limite semanal, candidato com teste vencido sem decisao)
async function listPendentesAprovacao(unidades) {
  const todos = (await listAll()).filter((c) => c.status === 'pendente_aprovacao');
  if (unidades == null) return todos;
  if (!unidades.length) return [];
  const alvo = new Set(unidades);
  return todos.filter((c) => alvo.has(c.unidade));
}

// aprovar ja registra a entrada de verdade (vira "aberto"), com o horario
// original da tentativa - a pessoa nao precisa voltar no quiosque
async function aprovarPendencia(id, { porEmail }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  const atual = snap.data();
  if (atual.status !== 'pendente_aprovacao') throw new Error('Essa solicitação já foi resolvida.');
  const agora = new Date().toISOString();
  const merge = {
    status: 'aberto',
    decisaoPendencia: { aprovado: true, porEmail: porEmail || null, decididoEm: agora },
    atualizadoEm: agora,
  };
  await ref.update(merge);
  checkinCache.invalidar();
  return { ...atual, ...merge };
}

// Master corrige um check-in registrado errado (kiosk digitou/gerou horario
// errado, ou precisa lancar manualmente um caso que passou batido) - so mexe
// no horario de entrada/saida, preserva foto/localizacao como estavam. Data
// e hora vem SEPARADOS (nao datetime-local) e sao interpretados como
// Horario de Brasilia (-03:00 fixo, Brasil nao tem mais horario de verao)
// explicitamente, pro resultado nao depender do fuso do navegador de quem
// esta editando
const DATA_HORA_RE = { data: /^\d{4}-\d{2}-\d{2}$/, hora: /^\d{2}:\d{2}$/ };
function horarioBrasiliaISO(data, hora) {
  if (!DATA_HORA_RE.data.test(data) || !DATA_HORA_RE.hora.test(hora)) throw new Error('Data ou hora inválida.');
  return new Date(`${data}T${hora}:00-03:00`).toISOString();
}

async function editarHorarios(id, { entradaData, entradaHora, saidaData, saidaHora, porEmail }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Check-in não encontrado.');
  const atual = snap.data();
  const merge = { atualizadoEm: new Date().toISOString() };
  if (entradaData && entradaHora) {
    merge.entrada = { ...atual.entrada, horario: horarioBrasiliaISO(entradaData, entradaHora), editadoPorEmail: porEmail || null };
  }
  // saida so pode ser editada se ja existir (nao cria um checkout que nao aconteceu)
  if (atual.saida && saidaData && saidaHora) {
    merge.saida = { ...atual.saida, horario: horarioBrasiliaISO(saidaData, saidaHora), editadoPorEmail: porEmail || null };
  }
  const entradaFinal = (merge.entrada || atual.entrada).horario;
  const saidaFinal = (merge.saida || atual.saida || {}).horario;
  if (saidaFinal && saidaFinal < entradaFinal) throw new Error('A saída não pode ser antes da entrada.');
  await ref.update(merge);
  checkinCache.invalidar();
  return { ...atual, ...merge };
}

async function remover(id) {
  const snap = await COLLECTION.doc(id).get();
  if (!snap.exists) throw new Error('Check-in não encontrado.');
  await COLLECTION.doc(id).delete();
  checkinCache.invalidar();
  return snap.data();
}

async function recusarPendencia(id, { porEmail, motivo }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  const atual = snap.data();
  if (atual.status !== 'pendente_aprovacao') throw new Error('Essa solicitação já foi resolvida.');
  const agora = new Date().toISOString();
  const merge = {
    status: 'recusado',
    decisaoPendencia: { aprovado: false, motivo: motivo ? String(motivo).trim().slice(0, 300) : null, porEmail: porEmail || null, decididoEm: agora },
    atualizadoEm: agora,
  };
  await ref.update(merge);
  checkinCache.invalidar();
  return { ...atual, ...merge };
}

// numeros de apoio pro topo do painel: quantos check-outs ja fecharam essa
// semana (Brasilia) e quantos check-ins (entrada aberta ou ja fechada) sao de
// extra - usado no contador da aba Extras. So conta o que ja e "check-in de
// verdade" (aberto/fechado), nunca pendencia/recusado
async function resumoSemana(unidades) {
  const [todos, funcionarios] = await Promise.all([listAll(), rh.listAll()]);
  const extrasIds = new Set(funcionarios.filter((f) => f.tipoCadastro === 'extra').map((f) => f.id));
  const alvo = unidades == null ? null : new Set(unidades);
  const filtrados = todos.filter((c) => !alvo || alvo.has(c.unidade));
  const inicioSemana = inicioSemanaBrasilia();
  const corteUtc = new Date(`${inicioSemana}T00:00:00-03:00`).toISOString();
  const checkoutsSemana = filtrados.filter((c) => (
    c.status === 'fechado' && c.saida && c.saida.horario >= corteUtc
  )).length;
  const totalCheckinsExtras = filtrados.filter((c) => (
    (c.status === 'aberto' || c.status === 'fechado') && extrasIds.has(c.funcionarioId)
  )).length;
  return { checkoutsSemana, totalCheckinsExtras };
}

// quantos check-ins (aberto/fechado, nunca pendencia/recusado) cada pessoa
// tem - semana (Brasilia) e total historico. Usado pro numero individual nos
// cards de "Por Unidade" (semana) e "Extras" (total), separado do resumo
// global de resumoSemana()
async function contagemPorFuncionario(unidades) {
  const todos = await listAll();
  const alvo = unidades == null ? null : new Set(unidades);
  const filtrados = todos.filter((c) => (
    (!alvo || alvo.has(c.unidade)) && (c.status === 'aberto' || c.status === 'fechado')
  ));
  const inicioSemana = inicioSemanaBrasilia();
  const corteUtc = new Date(`${inicioSemana}T00:00:00-03:00`).toISOString();
  const mapa = {};
  for (const c of filtrados) {
    if (!mapa[c.funcionarioId]) mapa[c.funcionarioId] = { semana: 0, total: 0 };
    mapa[c.funcionarioId].total += 1;
    if (c.entrada && c.entrada.horario >= corteUtc) mapa[c.funcionarioId].semana += 1;
  }
  return mapa;
}

module.exports = {
  LIMITE_CHECKINS_SEMANA_EXTRA,
  registrarEntrada, registrarSaida, buscarAbertoDoFuncionario, listPorFuncionario,
  listByUnidadesData, listAbertos, listPendentesAprovacao, resumoSemana, contagemPorFuncionario,
  aprovarPendencia, recusarPendencia, editarHorarios, remover, getOne, hojeBrasilia,
  invalidar: () => checkinCache.invalidar(),
};

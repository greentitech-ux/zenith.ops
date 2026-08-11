// rhCheckin.js
// Check-in/check-out por foto - resolve o pedido do usuario de "identificar
// no dia que for" um extra que nao trabalha todo dia: em vez de depender do
// gerente lembrar quem apareceu, a propria pessoa se identifica num
// dispositivo fixo na entrada da loja (tablet/PC com webcam), escolhe o
// proprio nome na ficha ja cadastrada em rh.js e tira uma foto na entrada;
// na saida, repete o processo pra fechar o check-in. A foto e o horario sao
// o registro/prova de quem esteve na loja e quando - sem reconhecimento
// facial nem nada automatico, so tira a duvida "quem apareceu hoje" com
// prova visual e timestamp. Vale tanto pra quem ja e "ativo" quanto pra
// candidato em teste de 5 dias (ver STATUS_PODE_CHECKIN) - so quem foi
// desligado nao faz mais check-in.
//
// Colecao propria (rhCheckins), separada de rhFuncionarios (rh.js), porque
// cresce todo dia (um par entrada/saida por pessoa por dia), enquanto a
// ficha de funcionarios muda pouco - mesmo raciocinio de festas.js/parque.js
// serem modulos separados dentro do mesmo dominio (Saltiverso).
const db = require('./firestore');
const { createCache } = require('./liveCache');
const rh = require('./rh');

const COLLECTION = db.collection('rhCheckins');

function hojeBrasilia() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
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

// quem pode fazer check-in: funcionario ativo OU candidato em teste de 5
// dias (tambem precisa ser identificado no dia que aparece, mesmo antes de
// ser efetivado) - so nao deixa quem ja foi desligado (inativo)
const STATUS_PODE_CHECKIN = ['ativo', 'candidato'];

// registra a ENTRADA - so deixa 1 check-in aberto por vez por pessoa (se ja
// tem um aberto, tem que fechar - checkout - antes de abrir outro). A
// localizacao (se o navegador conseguiu, silenciosamente, sem UI propria
// pedindo - so o prompt nativo do proprio navegador) fica guardada mas so e
// exposta pro Master nas rotas de leitura (ver sanitizarLocalizacao em
// index.js)
async function registrarEntrada({ funcionarioId, foto, localizacao, registradoPorEmail }) {
  const funcionario = await rh.getOne(funcionarioId);
  if (!funcionario) throw new Error('Funcionário não encontrado.');
  if (!STATUS_PODE_CHECKIN.includes(funcionario.status)) throw new Error('Só funcionários ativos ou em teste podem fazer check-in.');

  const todos = await listAll();
  const aberto = todos.find((c) => c.funcionarioId === funcionarioId && c.status === 'aberto');
  if (aberto) throw new Error(`${funcionario.nome} já tem um check-in em aberto - faça o check-out antes de um novo check-in.`);

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
    status: 'aberto',
    criadoEm: agora,
    atualizadoEm: agora,
  };
  await ref.set(registro);
  checkinCache.invalidar();
  return registro;
}

// registra a SAIDA de um check-in aberto especifico
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

module.exports = {
  registrarEntrada, registrarSaida, buscarAbertoDoFuncionario,
  listByUnidadesData, listAbertos, getOne, hojeBrasilia,
  invalidar: () => checkinCache.invalidar(),
};

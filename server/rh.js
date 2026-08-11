// rh.js
// Modulo de RH: ficha de funcionarios (extras e efetivos) por loja, sem
// exigir login no Zenith - a maioria de quem trabalha na loja (extra,
// cozinha, entregador) nunca acessa o sistema, entao esse cadastro e
// independente de users.js. Cobre as frentes pedidas pelo usuario:
// - Cadastro no 1o dia (nome, contato, curriculo), com 2 tipos (tipoCadastro):
//   "extra" (avulso, ja entra direto como ativo - so precisa de visibilidade
//   de quem esta atuando na loja) e "candidato" (vai pro teste de 5 dias -
//   fica em status "candidato", FORA da Ficha de Ativos, ate a decisao).
// - Acompanhamento de teste: quem esta em periodo de experiencia (emTeste)
//   gera um alerta automatico no 5o dia (ver verificarTestesVencidos,
//   chamado por um job periodico em index.js) - decisao "efetivar" promove
//   o candidato pra status "ativo" (entra na Ficha de Ativos); "desligar"
//   marca "inativo".
// - Atestado: funcionario ativo pode ser marcado como afastado (emAtestado)
//   sem contar como desligamento - da visibilidade de quantos estao de
//   atestado agora (card do Painel) e guarda o historico de quando voltou.
// - Ficha de Funcionarios Ativos + Aniversariante do Dia (calculado sobre a
//   mesma ficha, sem colecao propria).
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('rhFuncionarios');

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;
const DECISOES_VALIDAS = ['efetivar', 'desligar'];

// dias corridos desde a admissao ate a decisao virar exigivel - pedido
// explicito do usuario ("no 5o dia")
const DIAS_TESTE_ALERTA = 5;

function limpar(v, max) {
  return String(v || '').trim().slice(0, max);
}

function validarDataOuNull(v, campo) {
  if (v == null || v === '') return null;
  if (!DATA_RE.test(v)) throw new Error(`${campo} inválida. Use o formato AAAA-MM-DD.`);
  return v;
}

// "efetivado" e restrito: so Master/Admin/quem tem a tag podeRhCadastrarEfetivado
// pode usar (ver podeCadastrarEfetivado em index.js) - a loja (gerente comum,
// so com a secao 'rh') cadastra Extra ou Candidato, nunca pula direto pra
// "ja efetivado"
const TIPOS_CADASTRO = ['extra', 'candidato', 'efetivado'];

async function criar({
  unidade, nome, contato, cargoFuncao, dataNascimento, dataAdmissao, tipoCadastro,
  curriculo, cadastradoPorId, cadastradoPorEmail,
}) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  const nomeOk = limpar(nome, 150);
  if (!nomeOk) throw new Error('Informe o nome completo.');
  const tipo = TIPOS_CADASTRO.includes(tipoCadastro) ? tipoCadastro : 'extra';
  // extra (avulso) e efetivado (contratacao direta) ja entram como ativo -
  // nao passam por decisao de contratacao. candidato (teste de 5 dias) so
  // vira "ativo" quando efetivado (ver registrarDecisaoTeste) - ate la fica
  // de fora da Ficha de Ativos, so aparece em Acompanhamento de Teste
  const emTeste = tipo === 'candidato';
  const status = tipo === 'candidato' ? 'candidato' : 'ativo';

  const ref = COLLECTION.doc();
  const agora = new Date().toISOString();
  const registro = {
    id: ref.id,
    unidade,
    nome: nomeOk,
    contato: limpar(contato, 40),
    cargoFuncao: limpar(cargoFuncao, 60),
    dataNascimento: validarDataOuNull(dataNascimento, 'Data de nascimento'),
    dataAdmissao: validarDataOuNull(dataAdmissao, 'Data de admissão') || agora.slice(0, 10),
    curriculo: curriculo || null,
    tipoCadastro: tipo,
    emTeste,
    status,
    feedbackTeste: null,
    alertaTesteEnviadoEm: null,
    desligadoEm: null,
    emAtestado: false,
    atestadoAtual: null,
    atestados: [],
    cadastradoPorId: cadastradoPorId || null,
    cadastradoPorEmail: cadastradoPorEmail || null,
    criadoEm: agora,
    atualizadoEm: agora,
  };
  await ref.set(registro);
  rhCache.invalidar();
  return registro;
}

async function listAllUncached() {
  const snap = await COLLECTION.orderBy('criadoEm', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const rhCache = createCache(listAllUncached, 60 * 1000);
const listAll = rhCache.cached;

// mesmo padrao de festas.js: filtra em memoria sobre o cache compartilhado -
// evita uma query direta por unidade (where in) que passaria por fora do
// cache e viraria leitura completa no Firestore a cada chamada
async function listByUnidades(unidades) {
  if (!unidades || !unidades.length) return [];
  const alvo = new Set(unidades);
  return (await listAll()).filter((r) => alvo.has(r.unidade));
}

async function getOne(id) {
  const doc = await COLLECTION.doc(id).get();
  return doc.exists ? doc.data() : null;
}

async function atualizar(id, patch) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Funcionário não encontrado.');
  const merge = { atualizadoEm: new Date().toISOString() };

  if (patch.nome !== undefined) {
    const nomeOk = limpar(patch.nome, 150);
    if (!nomeOk) throw new Error('Informe o nome completo.');
    merge.nome = nomeOk;
  }
  if (patch.contato !== undefined) merge.contato = limpar(patch.contato, 40);
  if (patch.cargoFuncao !== undefined) merge.cargoFuncao = limpar(patch.cargoFuncao, 60);
  if (patch.dataNascimento !== undefined) merge.dataNascimento = validarDataOuNull(patch.dataNascimento, 'Data de nascimento');
  if (patch.dataAdmissao !== undefined) merge.dataAdmissao = validarDataOuNull(patch.dataAdmissao, 'Data de admissão');
  if (patch.curriculo !== undefined) merge.curriculo = patch.curriculo;

  if (patch.status !== undefined) {
    if (!['candidato', 'ativo', 'inativo'].includes(patch.status)) throw new Error('Status inválido.');
    merge.status = patch.status;
    merge.desligadoEm = patch.status === 'inativo' ? new Date().toISOString() : null;
  }

  await ref.update(merge);
  rhCache.invalidar();
  return getOne(id);
}

// registra a decisao do periodo de teste (efetivar/desligar) - tira
// emTeste (o card some da aba de Acompanhamento) e muda o status: efetivar
// promove o candidato pra "ativo" (agora entra na Ficha de Funcionarios
// Ativos); desligar marca "inativo" direto (evita passo duplicado)
async function registrarDecisaoTeste(id, { decisao, observacao, porEmail }) {
  if (!DECISOES_VALIDAS.includes(decisao)) throw new Error('Decisão inválida. Use "efetivar" ou "desligar".');
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Funcionário não encontrado.');
  const agora = new Date().toISOString();
  const merge = {
    emTeste: false,
    feedbackTeste: { decisao, observacao: limpar(observacao, 500), decididoPorEmail: porEmail || null, decididoEm: agora },
    atualizadoEm: agora,
  };
  if (decisao === 'efetivar') {
    merge.status = 'ativo';
  } else {
    merge.status = 'inativo';
    merge.desligadoEm = agora;
  }
  await ref.update(merge);
  rhCache.invalidar();
  return getOne(id);
}

async function remover(id) {
  const snap = await COLLECTION.doc(id).get();
  if (!snap.exists) throw new Error('Funcionário não encontrado.');
  await COLLECTION.doc(id).delete();
  rhCache.invalidar();
}

// atestado medico: o funcionario continua "ativo" (nao e desligamento), so
// fica marcado como afastado - da visibilidade de quantas pessoas estao de
// atestado agora (card do Painel) e guarda o historico pra quando ela voltar
async function registrarAtestado(id, { inicio, previsaoRetorno, porEmail }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Funcionário não encontrado.');
  const atual = snap.data();
  if (atual.status !== 'ativo') throw new Error('Só é possível lançar atestado pra funcionário ativo.');
  if (atual.emAtestado) throw new Error('Esse funcionário já está com atestado em aberto.');
  const inicioOk = validarDataOuNull(inicio, 'Data de início') || new Date().toISOString().slice(0, 10);
  const agora = new Date().toISOString();
  await ref.update({
    emAtestado: true,
    atestadoAtual: {
      inicio: inicioOk,
      previsaoRetorno: validarDataOuNull(previsaoRetorno, 'Previsão de retorno'),
      registradoPorEmail: porEmail || null,
      registradoEm: agora,
    },
    atualizadoEm: agora,
  });
  rhCache.invalidar();
  return getOne(id);
}

async function registrarRetornoAtestado(id, { porEmail }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Funcionário não encontrado.');
  const atual = snap.data();
  if (!atual.emAtestado || !atual.atestadoAtual) throw new Error('Esse funcionário não está de atestado.');
  const agora = new Date().toISOString();
  const registroFechado = {
    ...atual.atestadoAtual,
    retorno: agora.slice(0, 10),
    marcadoRetornoPorEmail: porEmail || null,
  };
  await ref.update({
    emAtestado: false,
    atestadoAtual: null,
    atestados: [...(atual.atestados || []), registroFechado],
    atualizadoEm: agora,
  });
  rhCache.invalidar();
  return getOne(id);
}

function diasDesde(dataIso) {
  if (!dataIso) return 0;
  const inicio = new Date(`${dataIso}T00:00:00`);
  const hoje = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  hoje.setHours(0, 0, 0, 0);
  return Math.floor((hoje - inicio) / 86400000);
}

// quem completou (ou passou) os DIAS_TESTE_ALERTA desde a admissao, ainda
// em teste, sem decisao e sem alerta ja enviado - usado pelo job diario
// (ver rodarAlertaTesteRh em index.js) pra disparar o push uma unica vez
async function verificarTestesVencidos() {
  const todos = await listAllUncached();
  return todos.filter((f) => (
    f.status !== 'inativo' && f.emTeste && !f.feedbackTeste && !f.alertaTesteEnviadoEm
    && diasDesde(f.dataAdmissao) >= DIAS_TESTE_ALERTA
  ));
}

async function marcarAlertaTesteEnviado(id) {
  await COLLECTION.doc(id).update({ alertaTesteEnviadoEm: new Date().toISOString() });
  rhCache.invalidar();
}

// aniversariantes: so compara mes/dia (sem janela de tolerancia, ao
// contrario do niver do Parque) - recebe a lista ja carregada pelo chamador
// pra nao repetir leitura do Firestore
function aniversariantesHoje(lista, dataRef) {
  const hoje = dataRef || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const [, mes, dia] = hoje.split('-');
  return (lista || []).filter((f) => {
    if (f.status !== 'ativo' || !f.dataNascimento) return false;
    const [, m, d] = f.dataNascimento.split('-');
    return m === mes && d === dia;
  });
}

module.exports = {
  DIAS_TESTE_ALERTA, TIPOS_CADASTRO,
  criar, listAll, listByUnidades, getOne, atualizar, remover,
  registrarDecisaoTeste, verificarTestesVencidos, marcarAlertaTesteEnviado,
  registrarAtestado, registrarRetornoAtestado,
  diasDesde, aniversariantesHoje,
  invalidar: () => rhCache.invalidar(),
};

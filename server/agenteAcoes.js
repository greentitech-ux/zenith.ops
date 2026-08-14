// agenteAcoes.js
// Catálogo de ações que o Beniboy (bot de IA, ver suporteBot.js) pode
// executar como agente - pedido explícito do usuário: "quero uma caixa
// onde iríamos inserir os códigos (ensinar) o que ele pode fazer" +
// "quero uma caixa de prompt ou contexto pra ensinarmos ao Beniboy como
// resolver as coisas". Master cadastra cada AÇÃO aqui (nunca o Beniboy -
// ele só ESCOLHE entre o que já está cadastrado, nunca escreve o comando
// em si) e um texto livre de contexto/orientação geral.
//
// Duas coisas nesse módulo:
// 1) o catálogo (collection 'agenteAcoes') - cada ação é 'comando_maquina'
//    (PowerShell fixo, roda via NOCZenith num computador tipo 'interno' -
//    ver lojaStatus.js enfileirarComando/comandoPendenteId) ou
//    'acao_sistema' (uma função pré-pronta e revisada, nunca código livre -
//    ver EXECUTORES_ACAO_SISTEMA abaixo).
// 2) o contexto (doc singleton 'agenteContexto/principal') - texto livre
//    injetado no system prompt do Beniboy quando quem conversa é Master
//    (ver montarSystem em suporteBot.js).
//
// `requerAprovacao` é por AÇÃO, default true (pedido explícito: "quero que
// tudo que ele execute passe por aprovação do master exceto algumas coisas
// mais óbvias" - a exceção é escolhida pelo Master ao cadastrar, nunca uma
// lista fixa no código). Quando true, a execução de verdade passa pela
// MESMA fila de aprovação que o QA Master já usa (qaAprovacoes.js) - ver
// EXECUTORES_QA['agente.executarAcao'] em index.js.
const crypto = require('crypto');
const db = require('./firestore');
const { createCache } = require('./liveCache');
const users = require('./users');
const lojaStatus = require('./lojaStatus');

const COLLECTION = db.collection('agenteAcoes');
const CONTEXTO_REF = db.collection('agenteContexto').doc('principal');

const TIPOS_ACAO = ['comando_maquina', 'acao_sistema'];
// lista fechada de propósito - o Master escolhe num <select>, nunca digita
// código; adicionar uma nova ação de sistema exige alterar este arquivo
const EXECUTORES_SISTEMA_VALIDOS = ['criar_usuario_zenith'];

async function listUncached() {
  const snap = await COLLECTION.orderBy('nome').get();
  return snap.docs.map((d) => d.data());
}
const cache = createCache(listUncached, 10 * 1000);

async function listar() {
  return cache.cached();
}

// só as ativas, com os campos que o Beniboy precisa pra decidir - usada
// pelo system prompt (ver montarSystem em suporteBot.js)
async function listarAtivas() {
  const todas = await listar();
  return todas.filter((a) => a.ativo);
}

async function obter(id) {
  const snap = await COLLECTION.doc(id).get();
  return snap.exists ? snap.data() : null;
}

function validarDados(dados) {
  const nome = String(dados.nome || '').trim().slice(0, 80);
  if (!nome) throw new Error('Dê um nome pra ação.');
  const descricao = String(dados.descricao || '').trim().slice(0, 600);
  if (!descricao) throw new Error('Descreva quando/por que usar essa ação - é o que o Beniboy lê pra decidir.');
  const tipo = TIPOS_ACAO.includes(dados.tipo) ? dados.tipo : null;
  if (!tipo) throw new Error('Tipo inválido.');
  const registro = {
    nome, descricao, tipo,
    requerAprovacao: dados.requerAprovacao !== false,
    ativo: dados.ativo !== false,
  };
  if (tipo === 'comando_maquina') {
    const comando = String(dados.comando || '').trim().slice(0, 4000);
    if (!comando) throw new Error('Escreva o comando PowerShell dessa ação.');
    registro.comando = comando;
    registro.executorSistema = null;
  } else {
    const executorSistema = EXECUTORES_SISTEMA_VALIDOS.includes(dados.executorSistema) ? dados.executorSistema : null;
    if (!executorSistema) throw new Error('Escolha uma ação de sistema válida.');
    registro.executorSistema = executorSistema;
    registro.comando = null;
  }
  return registro;
}

async function criar(dados) {
  const registro = validarDados(dados);
  const ref = COLLECTION.doc();
  const completo = {
    id: ref.id,
    ...registro,
    criadoEm: new Date().toISOString(),
    atualizadoEm: new Date().toISOString(),
    criadoPorEmail: dados.criadoPorEmail || null,
    atualizadoPorEmail: dados.criadoPorEmail || null,
  };
  await ref.set(completo);
  cache.invalidar();
  return completo;
}

async function atualizar(id, dados, atualizadoPorEmail) {
  const snap = await COLLECTION.doc(id).get();
  if (!snap.exists) throw new Error('Ação não encontrada.');
  const registro = validarDados(dados);
  const patch = { ...registro, atualizadoEm: new Date().toISOString(), atualizadoPorEmail: atualizadoPorEmail || null };
  await COLLECTION.doc(id).update(patch);
  cache.invalidar();
  return { ...snap.data(), ...patch };
}

async function remover(id) {
  await COLLECTION.doc(id).delete();
  cache.invalidar();
  return { id };
}

async function obterContexto() {
  const snap = await CONTEXTO_REF.get();
  return snap.exists ? snap.data() : { texto: '', atualizadoEm: null, atualizadoPorEmail: null };
}

async function salvarContexto(texto, atualizadoPorEmail) {
  const registro = {
    texto: String(texto || '').slice(0, 12000),
    atualizadoEm: new Date().toISOString(),
    atualizadoPorEmail: atualizadoPorEmail || null,
  };
  await CONTEXTO_REF.set(registro);
  return registro;
}

// gera a senha que o Beniboy nunca vê nem escolhe - mesmo espírito do
// SENHA_PADRAO_BOT em suporteBot.js, mas aleatória de verdade (isso é
// CRIAÇÃO de acesso, não reset de senha existente). O próprio users.create
// já força precisaTrocarSenha:true - o Master vê a senha no card de
// aprovação e repassa por fora do app, igual já faz hoje quando cadastra
// um acesso na mão (ver comentário em users.js:102-104)
function gerarSenhaAleatoria() {
  return crypto.randomBytes(6).toString('base64url');
}

async function criarUsuarioZenith(params) {
  const p = params || {};
  const senha = gerarSenhaAleatoria();
  const criado = await users.create({
    email: p.email, username: p.username, password: senha, permissions: p.permissions || {},
  });
  return `Usuário criado: ${criado.email} (username: ${criado.username || '-'}). Senha temporária: ${senha} (precisa trocar no primeiro login) - repasse pra pessoa por fora do app.`;
}

const EXECUTORES_SISTEMA = {
  criar_usuario_zenith: criarUsuarioZenith,
};

// dispatcher genérico - chamado tanto pela aprovação (EXECUTORES_QA em
// index.js) quanto pelo caminho direto (ação com requerAprovacao:false).
// Busca a ação FRESCA (não do cache) porque pode ter passado tempo entre o
// Beniboy pedir e o Master aprovar, e o Master pode ter editado/desativado
// nesse meio tempo - defesa em profundidade, mesmo espírito do recheck de
// consultar_pedido em suporteBot.js
async function executarAcaoDoAgente(acaoId, parametros) {
  const acao = await obter(acaoId);
  if (!acao || !acao.ativo) throw new Error('Ação não encontrada ou desativada.');
  const params = parametros || {};
  if (acao.tipo === 'comando_maquina') {
    if (!params.codigo || !params.posto) throw new Error('Faltou dizer qual computador (codigo/posto) vai rodar o comando.');
    await lojaStatus.enfileirarComando(params.codigo, params.posto, acao.comando, { origem: 'agente', acaoId });
    return `Comando "${acao.nome}" enfileirado pro computador ${params.codigo}/${params.posto} - executa no próximo contato do NOCZenith.`;
  }
  const executor = EXECUTORES_SISTEMA[acao.executorSistema];
  if (!executor) throw new Error(`Ação de sistema desconhecida: ${acao.executorSistema}`);
  return executor(params);
}

module.exports = {
  TIPOS_ACAO, EXECUTORES_SISTEMA_VALIDOS,
  listar, listarAtivas, obter, criar, atualizar, remover,
  obterContexto, salvarContexto, executarAcaoDoAgente,
};

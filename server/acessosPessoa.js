// acessosPessoa.js
// Motor do checklist de bloqueio/liberação de acesso (ver solicitacoes.js
// tipo 'acesso-pessoa'). Nao tem colecao propria - o estado do checklist
// mora dentro do proprio ticket (acessoChecklist), gravado por
// solicitacoes.atualizarAcessoChecklist()/marcarAcessoConcluido().
//
// Este modulo so faz duas coisas: (1) SUGERIR candidatos por nome/unidade
// nos 3 sistemas que dao entrada (login, RH, operador do Abastecimento), e
// (2) EXECUTAR o bloqueio/liberacao de verdade, sempre em cima do id que o
// Master confirmou na tela - nunca decide sozinho, nunca desliga em massa.
const users = require('./users');
const rh = require('./rh');
const abastecimentoCarrinho = require('./abastecimentoCarrinho');

// mesma heuristica que o proprio app ja usa pra transformar nome em login
// (ver users.sugerirAcesso) - reaproveitada aqui pra ir na direcao
// contraria: de um nome digitado, quais tokens um username/email dessa
// pessoa provavelmente teria
function tokensDeNome(nomeCompleto) {
  const { nome, sobrenome } = users.separarNome(nomeCompleto);
  const n = users.soLetras(nome);
  const s = users.soLetras(sobrenome);
  const tokens = new Set();
  if (n.length >= 2) tokens.add(n);
  if (s.length >= 2) { tokens.add(s); tokens.add(n[0] + s); }
  return tokens;
}

async function candidatosLogin(nomePessoa, unidade) {
  const tokens = tokensDeNome(nomePessoa);
  if (!tokens.size) return [];
  const todos = await users.list();
  return todos
    .filter((u) => u.active !== false && Array.isArray(u.permissions?.unidades) && u.permissions.unidades.includes(unidade))
    .filter((u) => {
      const emailLocal = String(u.email || '').split('@')[0].toLowerCase();
      const username = String(u.username || '').toLowerCase();
      return tokens.has(username) || tokens.has(emailLocal);
    })
    .map((u) => ({ id: u.id, email: u.email, username: u.username, cargo: u.cargo || null }));
}

async function candidatosRh(nomePessoa, unidade) {
  const nomeNorm = rh.normalizarNome(nomePessoa);
  if (!nomeNorm) return [];
  const doUnidade = await rh.listByUnidades([unidade]);
  return doUnidade
    .filter((f) => f.status === 'ativo' && rh.normalizarNome(f.nome) === nomeNorm)
    .map((f) => ({ id: f.id, nome: f.nome, unidade: f.unidade, emFerias: !!f.emFerias }));
}

async function candidatosAbastecimento(nomePessoa) {
  const nomeNorm = rh.normalizarNome(nomePessoa);
  if (!nomeNorm) return [];
  const todos = await abastecimentoCarrinho.listarOperadores();
  return todos
    .filter((o) => o.ativo !== false && rh.normalizarNome(o.nome) === nomeNorm)
    .map((o) => ({ id: o.id, nome: o.nome, usuario: o.usuario, papel: o.papel }));
}

// abastecimento nao tem campo de unidade (ver abastecimentoCarrinho.js -
// operacao unica do carrinho Dom Aeroporto) - so nome mesmo
async function buscarCandidatos({ nomePessoa, unidade }) {
  const [loginList, rhList, abastecimentoList] = await Promise.all([
    candidatosLogin(nomePessoa, unidade),
    candidatosRh(nomePessoa, unidade),
    candidatosAbastecimento(nomePessoa),
  ]);
  return { users: loginList, rh: rhList, abastecimento: abastecimentoList };
}

// ---- execucao (uma por sistema x acao, sempre em cima do id confirmado) ----

async function bloquearLogin(userId, porEmail) {
  await users.setActive(userId, false);
}
async function reativarLogin(userId, porEmail) {
  await users.setActive(userId, true);
}
async function desligarFuncionarioRh(funcId, { dataEfetiva, motivoAcesso, porEmail }) {
  await rh.desligar(funcId, { motivo: `Bloqueio de acesso (${motivoAcesso})`, data: dataEfetiva, porEmail });
}
async function marcarFeriasRh(funcId, { dataEfetiva, dataRetornoPrevista, porEmail }) {
  await rh.registrarFerias(funcId, { inicio: dataEfetiva, retornoPrevisto: dataRetornoPrevista, porEmail });
}
async function encerrarFeriasRh(funcId, porEmail) {
  await rh.registrarRetornoFerias(funcId, { porEmail });
}
async function removerOperadorAbastecimento(opId, porEmail) {
  await abastecimentoCarrinho.removerOperador(opId);
}
async function suspenderOperadorAbastecimento(opId, porEmail) {
  await abastecimentoCarrinho.atualizarOperador(opId, { ativo: false });
}
async function reativarOperadorAbastecimento(opId, porEmail) {
  await abastecimentoCarrinho.atualizarOperador(opId, { ativo: true });
}

module.exports = {
  buscarCandidatos,
  bloquearLogin, reativarLogin,
  desligarFuncionarioRh, marcarFeriasRh, encerrarFeriasRh,
  removerOperadorAbastecimento, suspenderOperadorAbastecimento, reativarOperadorAbastecimento,
};

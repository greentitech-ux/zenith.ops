// users.js
// Gestao dos acessos criados pelo Master: cada usuario tem permissoes
// proprias (secoes do app, unidades, grupos do cofre). So o Master pode
// chamar essas funcoes (aplicado nas rotas via auth.requireMaster).
const bcrypt = require('bcryptjs');
const db = require('./firestore');
const { emptyPermissions, invalidarUsuario } = require('./auth');
const { createCache } = require('./liveCache');
const sessions = require('./sessions');

const usersRef = db.collection('users');

const VALID_SECTIONS = ['monitor', 'disputas', 'cofre', 'fechamentos', 'lancamento', 'sangria', 'entregas', 'entregas-lancamento', 'ifood', 'solicitacoes', 'tecnico', 'suporte', 'manutencao', 'inventario', 'parque', 'parque-checkin', 'parque-loja', 'festas', 'abastecimento-carrinho', 'abastecimento-loja', 'ativos-ti', 'central-solucoes', 'rh'];

// os 7 tipos de card que aparecem na Central - mesma lista de TIPOS_INFO em
// central.html/central-historico.html. Igual ao cofre (vaultSubgroups) e
// unidades: em branco significa SEM restrição (vê todos) - diferente do
// cofre, aqui em branco = "sem restrição" pra não quebrar o acesso de quem
// já usava a Central antes dessa permissão existir; o Master so restringe
// quem precisa ver só alguns tipos (ex: Admin que só cuida de Suporte de TI)
const TIPOS_SOLICITACAO = ['estorno', 'ajuste-fechamento', 'compra', 'manutencao', 'suporte-ti', 'pagamento', 'nota'];

function sanitizePermissions(input) {
  const p = input || {};
  return {
    sections: Array.isArray(p.sections) ? p.sections.filter((s) => VALID_SECTIONS.includes(s)) : [],
    unidades: Array.isArray(p.unidades) ? p.unidades.map(String) : [],
    vaultSubgroups: Array.isArray(p.vaultSubgroups) ? p.vaultSubgroups.map(String) : [],
    tiposSolicitacao: Array.isArray(p.tiposSolicitacao) ? p.tiposSolicitacao.filter((t) => TIPOS_SOLICITACAO.includes(t)) : [],
  };
}

const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const USERNAME_RE = /^[a-z0-9._-]{2,30}$/;

function sanitizeUsername(raw) {
  const u = String(raw || '').trim().toLowerCase();
  if (!u) return '';
  if (!USERNAME_RE.test(u)) throw new Error('Usuário inválido. Use só letras minúsculas, números, ponto, hífen ou underline (2 a 30 caracteres).');
  return u;
}

async function garantirUsernameLivre(username, idAtual) {
  if (!username) return;
  const existing = await usersRef.where('username', '==', username).limit(1).get();
  if (!existing.empty && existing.docs[0].id !== idAtual) throw new Error('Já existe um acesso com esse usuário.');
}

// acha um acesso pelo usuário (login curto) ou email - mesmo criterio de
// auth.login() (se tem "@" busca por email, senao por username). Usado no
// Reset Senha rapido do Painel (ver index.js), onde o Master/Admin so tem o
// usuario/email de quem precisa do reset, nao o id do documento
async function findByIdentifier(identifier) {
  const valor = String(identifier || '').trim().toLowerCase();
  if (!valor) return null;
  const campo = valor.includes('@') ? 'email' : 'username';
  const snap = await usersRef.where(campo, '==', valor).limit(1).get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

function sanitizeHorarioPermitido(input) {
  const h = input || {};
  const ativo = !!h.ativo;
  if (!ativo) return { ativo: false, inicio: '', fim: '' };
  if (!HORA_RE.test(h.inicio) || !HORA_RE.test(h.fim)) {
    throw new Error('Informe início e fim no formato HH:MM.');
  }
  return { ativo: true, inicio: h.inicio, fim: h.fim };
}

// cache de 20s: a listagem passou a ser lida tambem por rotas quentes fora
// da tela de Usuarios (ex: GET /api/grupos/responsaveis, chamada a cada
// troca de unidade no formulario da Central) - sem cache, cada uma dessas
// chamadas relia a colecao users inteira do Firestore. Toda mutacao abaixo
// invalida (create/permissions/active/horario/isAdmin/cargo/senha/remove)
async function listUncached() {
  const snap = await usersRef.orderBy('createdAt', 'asc').get();
  return snap.docs.map(toPublic);
}
const usersCache = createCache(listUncached, 60 * 1000);
const list = usersCache.cached;

// checagem + gravacao dentro da MESMA transacao do Firestore - sem isso,
// dois POST /api/users quase simultaneos (duplo clique no botao "Criar
// acesso", ou um clique seguido de Enter antes da resposta voltar - o
// botao nao ficava desabilitado durante a requisicao) podem os dois ler
// "email livre" e cada um criar um acesso, resultando em 2+ acessos
// identicos pro mesmo email (foi exatamente isso que aconteceu de
// verdade). O botao no front agora trava durante a chamada (ver
// usuarios.html) - isso aqui e a segunda camada, pra cobrir qualquer outra
// forma de disparar 2 chamadas ao mesmo tempo (rede lenta com retry, etc)
async function create({ email, password, permissions, username }) {
  email = String(email || '').trim().toLowerCase();
  if (!email || !password) throw new Error('Email e senha são obrigatórios.');
  if (password.length < 8) throw new Error('A senha deve ter pelo menos 8 caracteres.');
  const usernameOk = sanitizeUsername(username);
  const passwordHash = await bcrypt.hash(password, 12);

  const novoId = await db.runTransaction(async (tx) => {
    const existing = await tx.get(usersRef.where('email', '==', email).limit(1));
    if (!existing.empty) throw new Error('Já existe um acesso com esse email.');
    if (usernameOk) {
      const existingUsername = await tx.get(usersRef.where('username', '==', usernameOk).limit(1));
      if (!existingUsername.empty) throw new Error('Já existe um acesso com esse usuário.');
    }
    const ref = usersRef.doc();
    tx.set(ref, {
      email,
      username: usernameOk || null,
      passwordHash,
      role: 'user',
      active: true,
      // senha definida pelo Master na hora de criar o acesso - pede pra
      // trocar no primeiro login, ja que ele avisa a senha por fora do app
      precisaTrocarSenha: true,
      permissions: sanitizePermissions(permissions),
      createdAt: new Date().toISOString(),
    });
    return ref.id;
  });
  usersCache.invalidar();
  return toPublic(await usersRef.doc(novoId).get());
}

// acesso "QA Master": mesmo role 'master' de sempre (100% das rotas que
// checam req.isMaster tratam esse acesso IGUAL a um Master de verdade, sem
// precisar tocar em nenhuma delas) - a UNICA diferenca e a flag qaMaster,
// que index.js usa pra desviar acoes sensiveis (exclusoes/configuracao
// global) pra fila de aprovacao em vez de executar na hora (ver
// qaAprovacoes.js). Pensado pra treino/teste em produção sem risco de
// alguem (ou um bot) apagar/reconfigurar algo real sem um Master de
// verdade revisar antes.
// mesma protecao contra dupla-criacao do create() acima (checagem +
// gravacao numa unica transacao)
async function createQaMaster({ email, password, username }) {
  email = String(email || '').trim().toLowerCase();
  if (!email || !password) throw new Error('Email e senha são obrigatórios.');
  if (password.length < 8) throw new Error('A senha deve ter pelo menos 8 caracteres.');
  const usernameOk = sanitizeUsername(username);
  const passwordHash = await bcrypt.hash(password, 12);

  const novoId = await db.runTransaction(async (tx) => {
    const existing = await tx.get(usersRef.where('email', '==', email).limit(1));
    if (!existing.empty) throw new Error('Já existe um acesso com esse email.');
    if (usernameOk) {
      const existingUsername = await tx.get(usersRef.where('username', '==', usernameOk).limit(1));
      if (!existingUsername.empty) throw new Error('Já existe um acesso com esse usuário.');
    }
    const ref = usersRef.doc();
    tx.set(ref, {
      email,
      username: usernameOk || null,
      passwordHash,
      role: 'master',
      qaMaster: true,
      active: true,
      precisaTrocarSenha: true,
      permissions: sanitizePermissions(null),
      createdAt: new Date().toISOString(),
    });
    return ref.id;
  });
  usersCache.invalidar();
  return toPublic(await usersRef.doc(novoId).get());
}

// tag "QA User": acesso comum (role 'user', com as permissoes normais que o
// Master configurar) que ganha 2 coisas extras (ver index.js/central.html):
// sempre ve/cria TODOS os tipos de solicitacao na Central, independente de
// tiposSolicitacao configurado pra ele, e toda solicitacao que criar entra
// marcada "TESTE" - pra quem for atender/aprovar saber na hora que aquilo
// nao e um caso real
async function updateQaUser(id, valor) {
  const ref = usersRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Acesso não encontrado.');
  if (snap.data().role === 'master') throw new Error('Acesso Master usa a tag QA Master, não QA User.');
  await ref.update({ qaUser: !!valor });
  invalidarUsuario(id);
  usersCache.invalidar();
  return toPublic(await ref.get());
}

async function updateUsername(id, username) {
  const ref = usersRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Acesso não encontrado.');
  const usernameOk = sanitizeUsername(username);
  await garantirUsernameLivre(usernameOk, id);
  await ref.update({ username: usernameOk || null });
  invalidarUsuario(id);
  usersCache.invalidar();
  return toPublic(await ref.get());
}

// atualizacao em massa: recebe uma lista [{email, username}] (ex: colada
// pelo Master a partir de uma planilha) e aplica uma a uma, sem parar no
// primeiro erro - devolve o resultado de cada linha pra revisao
async function updateUsernamesEmMassa(itens) {
  const lista = Array.isArray(itens) ? itens : [];
  const resultados = [];
  for (const item of lista) {
    const email = String((item && item.email) || '').trim().toLowerCase();
    try {
      if (!email) throw new Error('Email em branco.');
      const snap = await usersRef.where('email', '==', email).limit(1).get();
      if (snap.empty) throw new Error('Nenhum acesso com esse email.');
      await updateUsername(snap.docs[0].id, item.username);
      resultados.push({ email, username: sanitizeUsername(item.username), ok: true });
    } catch (err) {
      resultados.push({ email, ok: false, erro: err.message });
    }
  }
  return resultados;
}

async function updatePermissions(id, permissions) {
  const ref = usersRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Acesso não encontrado.');
  if (snap.data().role === 'master') throw new Error('O acesso Master não usa permissões.');
  await ref.update({ permissions: sanitizePermissions(permissions) });
  invalidarUsuario(id);
  usersCache.invalidar();
  return toPublic(await ref.get());
}

async function setActive(id, active) {
  const ref = usersRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Acesso não encontrado.');
  if (snap.data().role === 'master') throw new Error('O acesso Master não pode ser desativado.');
  await ref.update({ active: !!active });
  invalidarUsuario(id);
  usersCache.invalidar();
  // desativar derruba os locais logados na hora - senao um token emitido
  // antes continuaria valido ate as 8h expirarem sozinhas
  if (!active) await sessions.encerrarTodasDoUsuario(id);
  return toPublic(await ref.get());
}

async function updateHorarioPermitido(id, horarioPermitido) {
  const ref = usersRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Acesso não encontrado.');
  if (snap.data().role === 'master') throw new Error('O acesso Master não usa horário restrito.');
  await ref.update({ horarioPermitido: sanitizeHorarioPermitido(horarioPermitido) });
  invalidarUsuario(id);
  usersCache.invalidar();
  return toPublic(await ref.get());
}

async function updateIsAdmin(id, isAdmin) {
  const ref = usersRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Acesso não encontrado.');
  if (snap.data().role === 'master') throw new Error('O acesso Master já pode tudo, não precisa da tag Admin.');
  await ref.update({ isAdmin: !!isAdmin });
  invalidarUsuario(id);
  usersCache.invalidar();
  return toPublic(await ref.get());
}

// libera o Catálogo do Estoque (organizar setor/tipo, ajustar custo de
// referência, ativar/desativar item) pra um usuário especifico, sem precisar
// dar Master/Admin pra ele - pensado pra gerente de loja que cuida disso no
// dia a dia (ver requireMaster/podeCatalogoEstoque em auth.js)
async function updatePodeCatalogoEstoque(id, valor) {
  const ref = usersRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Acesso não encontrado.');
  if (snap.data().role === 'master') throw new Error('O acesso Master já pode tudo, não precisa dessa permissão.');
  await ref.update({ podeCatalogoEstoque: !!valor });
  invalidarUsuario(id);
  usersCache.invalidar();
  return toPublic(await ref.get());
}

// "manter sempre conectado": a sessao dessa conta passa a durar 30 dias em
// vez das 8h padrao (ver auth.js/sessions.js). Pensado originalmente pra
// login compartilhado de loja/terminal, mas tambem vale pro Master (ex:
// "solutions") que nao quer perder alerta do Beniboy por ter deslogado do
// celular/computador no meio do dia - ao contrario das outras tags dessa
// tela (que sao permissao, sem sentido pro Master que ja pode tudo), essa
// e sobre DURACAO da sessao, entao nao ha motivo pra bloquear pro Master.
// So vale a partir do PROXIMO login (nao estende sessoes ja abertas).
//
// Ao DESLIGAR, encerra na hora qualquer sessao ja aberta com esse acesso -
// sem isso, uma sessao de ate 30 dias emitida antes continuaria valida
// mesmo depois do Master desligar a opcao (ela so vale "pro proximo login"
// pra abrir, mas sem isso nao vale pra fechar). Se o motivo de desligar foi
// um terminal comprometido, o Master precisa que o corte seja imediato -
// a pessoa so cai de novo (ja nas 8h padrao) no proximo login.
async function updateSessaoLonga(id, valor) {
  const ref = usersRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Acesso não encontrado.');
  await ref.update({ sessaoLonga: !!valor });
  if (!valor) await sessions.encerrarTodasDoUsuario(id);
  invalidarUsuario(id);
  usersCache.invalidar();
  return toPublic(await ref.get());
}

// mesma ideia do Catalogo do Estoque, so que pro cadastro de INSUMOS do
// Abastecimento do Carrinho (Dom Aeroporto): quem tem a permissao adiciona/
// edita itens do catalogo (nome, quantidade por caixa, ativo) sem precisar
// ser Master/Admin
async function updatePodeCatalogoInsumos(id, valor) {
  const ref = usersRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Acesso não encontrado.');
  if (snap.data().role === 'master') throw new Error('O acesso Master já pode tudo, não precisa dessa permissão.');
  await ref.update({ podeCatalogoInsumos: !!valor });
  invalidarUsuario(id);
  usersCache.invalidar();
  return toPublic(await ref.get());
}

// tag "cadastrar Operadores" do Abastecimento do Carrinho: quem tem ve o
// botao 👥 Operadores e CADASTRA logins locais de balcao (4 letras + 4
// numeros). Ativar/desativar, remover e desbloquear continuam SO do Master
async function updatePodeCadastrarOperadores(id, valor) {
  const ref = usersRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Acesso não encontrado.');
  if (snap.data().role === 'master') throw new Error('O acesso Master já pode tudo, não precisa dessa permissão.');
  await ref.update({ podeCadastrarOperadores: !!valor });
  invalidarUsuario(id);
  usersCache.invalidar();
  return toPublic(await ref.get());
}

// tag "RH (todas as unidades)": quem tem a secao 'rh' normalmente so cadastra/
// ve as unidades das proprias permissoes (como qualquer secao) - essa tag
// extra libera o time de RH central a cadastrar/decidir/ver candidatos de
// QUALQUER unidade do grupo, sem precisar dar Admin/Master pra pessoa (ver
// podeAcessarUnidadeRh em index.js)
async function updatePodeRhTodasUnidades(id, valor) {
  const ref = usersRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Acesso não encontrado.');
  if (snap.data().role === 'master') throw new Error('O acesso Master já pode tudo, não precisa dessa permissão.');
  await ref.update({ podeRhTodasUnidades: !!valor });
  invalidarUsuario(id);
  usersCache.invalidar();
  return toPublic(await ref.get());
}

// tag "RH: pode cadastrar efetivado direto": sem essa tag, quem tem a secao
// 'rh' (tipicamente o gerente da loja) so cadastra Extra ou Candidato (teste
// de 5 dias) - nao pode pular direto pra "ja efetivado". Com a tag, cadastra
// os 3 tipos - pensado pro time de RH de verdade, nao pra loja
async function updatePodeRhCadastrarEfetivado(id, valor) {
  const ref = usersRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Acesso não encontrado.');
  if (snap.data().role === 'master') throw new Error('O acesso Master já pode tudo, não precisa dessa permissão.');
  await ref.update({ podeRhCadastrarEfetivado: !!valor });
  invalidarUsuario(id);
  usersCache.invalidar();
  return toPublic(await ref.get());
}

// tag de cargo/funcao (Loja, Gerente, Tecnico, Manutencao). Alem de rotulo
// na tela de Usuarios, algumas tem efeito real: Gerente aprova check-out do
// Parque, e a tag define a TELA INICIAL da pessoa ao entrar no app (ver
// index.html): Loja -> Historico de Solicitacoes, Tecnico -> Chamados TI,
// Manutencao -> Manutencao; sem tag -> Painel.
const CARGOS_VALIDOS = ['loja', 'gerente', 'assistente-gerente', 'tecnico', 'suporte', 'manutencao', 'operador'];
// Ass. Ger (assistente de Gerente) tem as MESMAS permissoes de aprovacao do
// Gerente (check-out antecipado do Parque, decidir cortesia, alertas de
// limite do PCD cortesia, etc.) - qualquer checagem de "e gerente" espalhada
// pelo app deve tratar os dois cargos como equivalentes (ver ehCargoGerente)
function ehCargoGerente(cargo) {
  return cargo === 'gerente' || cargo === 'assistente-gerente';
}
async function updateCargo(id, cargo) {
  const limpo = cargo ? String(cargo).toLowerCase() : null;
  if (limpo && !CARGOS_VALIDOS.includes(limpo)) throw new Error('Tag inválida. Use "loja", "gerente", "assistente-gerente", "tecnico", "suporte", "manutencao" ou "operador".');
  const ref = usersRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Acesso não encontrado.');
  if (snap.data().role === 'master') throw new Error('O acesso Master não usa tag de cargo.');
  await ref.update({ cargo: limpo });
  invalidarUsuario(id);
  usersCache.invalidar();
  return toPublic(await ref.get());
}

async function resetPassword(id, password) {
  if (!password || password.length < 8) throw new Error('A senha deve ter pelo menos 8 caracteres.');
  const ref = usersRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Acesso não encontrado.');
  const passwordHash = await bcrypt.hash(password, 12);
  // o Master (ou o Beniboy, quando a pessoa nao lembra a senha - ver
  // suporteBot.js) trocando a senha tambem desbloqueia o acesso (ex: apos 3
  // tentativas erradas) e pede pra trocar no proximo login, ja que essa
  // senha nova foi avisada ao usuario por fora do app (telefone/whatsapp/chat)
  await ref.update({
    passwordHash, locked: false, failedAttempts: 0, precisaTrocarSenha: true, desbloqueadoPeloBotEm: null,
  });
  invalidarUsuario(id);
  usersCache.invalidar();
  // senha nova invalida os locais logados com a antiga - sem isso os tokens
  // ja emitidos continuariam valendo ate as 8h expirarem sozinhas
  await sessions.encerrarTodasDoUsuario(id);
  return { ok: true };
}

// desbloqueio que NAO mexe na senha - a pessoa volta a usar a MESMA senha de
// sempre, sem ser obrigada a trocar (mesma dinamica do operador do
// Abastecimento do Carrinho, ver abastecimentoCarrinho.desbloquearOperador).
// pedirTrocaSenha (opcional, ex: checkbox ao aprovar o ticket automatico de
// bloqueio) e a UNICA forma de tambem forcar troca aqui - sem isso marcado,
// desbloquear NUNCA vira "trocar senha" ou senha padrao tipo "inicial1".
// viaBot marca `desbloqueadoPeloBotEm`: se o MESMO acesso travar de novo
// depois disso, o Beniboy (suporteBot.js) sabe que ja tentou destravar com a
// mesma senha uma vez e muda de estrategia (pergunta se a pessoa lembra a
// senha antes de tentar de novo).
async function desbloquear(id, { pedirTrocaSenha, viaBot } = {}) {
  const ref = usersRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Acesso não encontrado.');
  const patch = { locked: false, failedAttempts: 0, desbloqueadoPeloBotEm: viaBot ? new Date().toISOString() : null };
  if (pedirTrocaSenha) patch.precisaTrocarSenha = true;
  await ref.update(patch);
  invalidarUsuario(id);
  usersCache.invalidar();
  return toPublic(await ref.get());
}

// self-service: o proprio usuario troca a senha (fluxo voluntario, ou
// forcado no primeiro login apos um reset do Master) - exige a senha atual
// pra confirmar que e realmente o dono do acesso
async function alterarSenhaPropria(id, senhaAtual, novaSenha, sessionIdAtual) {
  if (!novaSenha || novaSenha.length < 8) throw new Error('A nova senha deve ter pelo menos 8 caracteres.');
  const ref = usersRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Acesso não encontrado.');
  const atual = snap.data();
  const ok = await bcrypt.compare(String(senhaAtual || ''), atual.passwordHash);
  if (!ok) throw new Error('Senha atual incorreta.');

  const passwordHash = await bcrypt.hash(novaSenha, 12);
  await ref.update({ passwordHash, precisaTrocarSenha: false });
  invalidarUsuario(id);
  usersCache.invalidar();
  // derruba os OUTROS locais logados com a senha antiga, mas preserva a
  // sessao atual (o usuario acabou de trocar a propria senha, nao faz
  // sentido deslogar ele mesmo do dispositivo em que esta agora)
  await sessions.encerrarTodasDoUsuarioExceto(id, sessionIdAtual);
  return { ok: true };
}

async function remove(id) {
  const ref = usersRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) return;
  if (snap.data().role === 'master') throw new Error('O acesso Master não pode ser excluído.');
  await ref.delete();
  invalidarUsuario(id);
  usersCache.invalidar();
}

function toPublic(doc) {
  const data = doc.data();
  return {
    id: doc.id,
    email: data.email,
    username: data.username || null,
    role: data.role,
    active: data.active !== false,
    locked: !!data.locked,
    precisaTrocarSenha: !!data.precisaTrocarSenha,
    permissions: data.role === 'master' ? null : data.permissions || emptyPermissions(),
    horarioPermitido: data.role === 'master' ? null : data.horarioPermitido || { ativo: false, inicio: '', fim: '' },
    isAdmin: data.role === 'master' ? null : !!data.isAdmin,
    podeCatalogoEstoque: data.role === 'master' ? null : !!data.podeCatalogoEstoque,
    podeCatalogoInsumos: data.role === 'master' ? null : !!data.podeCatalogoInsumos,
    podeCadastrarOperadores: data.role === 'master' ? null : !!data.podeCadastrarOperadores,
    podeRhTodasUnidades: data.role === 'master' ? null : !!data.podeRhTodasUnidades,
    podeRhCadastrarEfetivado: data.role === 'master' ? null : !!data.podeRhCadastrarEfetivado,
    sessaoLonga: !!data.sessaoLonga,
    cargo: data.role === 'master' ? null : data.cargo || null,
    qaMaster: data.role === 'master' ? !!data.qaMaster : null,
    qaUser: data.role === 'master' ? null : !!data.qaUser,
    createdAt: data.createdAt,
  };
}

module.exports = {
  VALID_SECTIONS,
  TIPOS_SOLICITACAO,
  CARGOS_VALIDOS,
  ehCargoGerente,
  findByIdentifier,
  list,
  create,
  createQaMaster,
  updateQaUser,
  updatePermissions,
  setActive,
  updateHorarioPermitido,
  updateIsAdmin,
  updatePodeCatalogoEstoque,
  updatePodeCatalogoInsumos,
  updatePodeCadastrarOperadores,
  updatePodeRhTodasUnidades,
  updatePodeRhCadastrarEfetivado,
  updateSessaoLonga,
  updateCargo,
  updateUsername,
  updateUsernamesEmMassa,
  resetPassword,
  desbloquear,
  alterarSenhaPropria,
  remove,
};

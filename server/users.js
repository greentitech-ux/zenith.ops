// users.js
// Gestao dos acessos criados pelo Master: cada usuario tem permissoes
// proprias (secoes do app, unidades, grupos do cofre). So o Master pode
// chamar essas funcoes (aplicado nas rotas via auth.requireMaster).
const bcrypt = require('bcryptjs');
// precisa do require: o `crypto` global do Node 20 e a WebCrypto, que NAO
// tem randomBytes (usado em gerarSenhaTemporaria)
const crypto = require('crypto');
const db = require('./firestore');
const { emptyPermissions, invalidarUsuario } = require('./auth');
const { createCache } = require('./liveCache');
const sessions = require('./sessions');

const usersRef = db.collection('users');
const recuperacoesSenhaRef = db.collection('recuperacoes_senha');
const RECUPERACAO_TTL_MS = 10 * 60 * 1000;

function normalizarPalavraRecuperacao(valor) {
  return String(valor || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
}

function validarPalavraRecuperacao(valor) {
  const palavra = normalizarPalavraRecuperacao(valor);
  // Uma única palavra é mais simples para a operação memorizar e digitar.
  // Aceitamos letras Unicode (inclui acentos), sem espaço, número ou símbolo.
  if (!/^\p{L}{6,}$/u.test(palavra)) {
    throw new Error('Use uma única palavra de recuperação com pelo menos 6 letras.');
  }
  return palavra;
}

const VALID_SECTIONS = ['monitor', 'disputas', 'cofre', 'fechamentos', 'kpis', 'lancamento', 'sangria', 'entregas', 'entregas-lancamento', 'ifood', 'solicitacoes', 'tecnico', 'suporte', 'manutencao', 'inventario', 'parque', 'parque-checkin', 'parque-loja', 'festas', 'abastecimento-carrinho', 'abastecimento-loja', 'ativos-ti', 'central-solucoes', 'rh', 'formularios', 'bonificacao', 'tarefas', 'estacao-salao', 'estacao-caixa', 'estacao-fechamento'];

// a qual vertical de negocio (empresas.TIPOS_NEGOCIO_VALIDOS) cada secao
// pertence - usado pra nao mostrar (no checklist de permissoes e no menu)
// modulo que nao faz sentido pra empresa daquele tipo, ex: uma clinica nao
// vai ver "Sangria" nem uma franquia de comida vai ver "Prontuario" quando
// esse tipo de negocio existir. '*' = secao "de infra", relevante pra
// QUALQUER vertical (suporte, chamados, cofre, formularios administrativos
// etc) - toda secao nova PRECISA entrar aqui tambem, ou fica invisivel pro
// filtro de vertical mesmo estando em VALID_SECTIONS (falha "escondendo",
// nao "vazando" - de proposito).
const SECTION_VERTICAIS = {
  monitor: ['alimentacao'], disputas: ['alimentacao'], fechamentos: ['alimentacao'], kpis: ['alimentacao'],
  lancamento: ['alimentacao'], sangria: ['alimentacao'], entregas: ['alimentacao'],
  'entregas-lancamento': ['alimentacao'], ifood: ['alimentacao'], inventario: ['alimentacao'],
  parque: ['alimentacao'], 'parque-checkin': ['alimentacao'], 'parque-loja': ['alimentacao'],
  festas: ['alimentacao'], 'abastecimento-carrinho': ['alimentacao'], 'abastecimento-loja': ['alimentacao'],
  cofre: ['*'], solicitacoes: ['*'], tecnico: ['*'], suporte: ['*'], manutencao: ['*'],
  'ativos-ti': ['*'], 'central-solucoes': ['*'], rh: ['*'], formularios: ['*'], tarefas: ['*'],
  // Estação da Comida (rodízio com comanda por pessoa - ver estacaoComida.js)
  'estacao-salao': ['alimentacao'], 'estacao-caixa': ['alimentacao'], 'estacao-fechamento': ['alimentacao'],
};
function secoesDaVertical(tipoNegocio) {
  return Object.entries(SECTION_VERTICAIS)
    .filter(([, vs]) => vs.includes('*') || vs.includes(tipoNegocio))
    .map(([s]) => s);
}
function verticalDaSecao(secao) {
  return SECTION_VERTICAIS[secao] || ['*'];
}

// os 7 tipos de card que aparecem na Central - mesma lista de TIPOS_INFO em
// central.html/central-historico.html. Igual ao cofre (vaultSubgroups) e
// unidades: em branco significa SEM restrição (vê todos) - diferente do
// cofre, aqui em branco = "sem restrição" pra não quebrar o acesso de quem
// já usava a Central antes dessa permissão existir; o Master so restringe
// quem precisa ver só alguns tipos (ex: Admin que só cuida de Suporte de TI)
const TIPOS_SOLICITACAO = ['estorno', 'ajuste-fechamento', 'compra', 'manutencao', 'suporte-ti', 'pagamento', 'nota', 'acesso-pessoa', 'adiantamento'];

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

// A personalização é deliberadamente uma lista fechada de perfis que já
// pertencem ao app. Assim não há URL externa, cobrança por geração de imagem
// nem risco de um usuário apontar o perfil para conteúdo de terceiros.
const PERFIS_VISUAIS_VALIDOS = ['', 'saltiverso-rayana'];

function sanitizePerfilVisual(raw) {
  const perfil = String(raw || '').trim();
  if (!PERFIS_VISUAIS_VALIDOS.includes(perfil)) throw new Error('Perfil visual inválido.');
  return perfil || null;
}

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
  if (!snap.empty) return { id: snap.docs[0].id, ...snap.docs[0].data() };
  // A query do Firestore e sensivel a maiuscula/minuscula, e o valor buscado
  // vem sempre em minusculo. Acesso gravado ANTES do sanitizeUsername (ou
  // por importacao/seed) pode ter "MV" no banco - a query nunca acha, e quem
  // chamou conclui "usuario nao existe". Isso ja custou caro uma vez: o
  // relatorio do MV ficava zerado porque o usuario gatilho nao resolvia, sem
  // nenhum erro em lugar nenhum. A lista de usuarios e cacheada (list()),
  // entao a segunda tentativa nao custa leitura em regime.
  const todos = await list().catch(() => []);
  const achado = todos.find((u) => String(u[campo] || '').trim().toLowerCase() === valor);
  if (!achado) return null;
  // list() devolve toPublic (sem hash de senha) - pra quem precisa do
  // registro inteiro, relê pelo id ja conhecido
  const doc = await usersRef.doc(achado.id).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
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

// Visual é uma preferência de apresentação. Não participa de permissões,
// empresa, seção, cargo ou autenticação: trocar/remover nunca amplia acesso.
async function updatePerfilVisual(id, perfilVisual) {
  const ref = usersRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Acesso não encontrado.');
  const perfil = sanitizePerfilVisual(perfilVisual);
  await ref.update({ perfilVisual: perfil });
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

// vincula o acesso a uma EMPRESA (ver empresas.js). É o que limita até onde
// o poder de "ver tudo" de um Admin alcança: Admin da Arcfood manda na
// Arcfood inteira e não enxerga o GBE, e vice-versa. Vazio = sem empresa:
// o acesso volta a valer só pelas unidades marcadas nele, sem atalho
// nenhum (é o lado seguro pra errar - ver escopoDeUnidades em auth.js).
// Não vale pro Master, que atravessa empresa por definição.
async function updateEmpresa(id, empresaId) {
  const ref = usersRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Acesso não encontrado.');
  if (snap.data().role === 'master') throw new Error('O acesso Master enxerga todas as empresas, não fica preso a uma.');
  await ref.update({ empresaId: empresaId ? String(empresaId) : null });
  invalidarUsuario(id);
  usersCache.invalidar();
  return toPublic(await ref.get());
}

// quem está vinculado a uma empresa - o Master vê isso ANTES de arquivar ou
// excluir, pra saber quantos acessos a decisão atinge (ver as rotas de
// arquivar/excluir empresa em index.js)
async function listarPorEmpresa(empresaId) {
  if (!empresaId) return [];
  return (await list()).filter((u) => u.empresaId === empresaId);
}

// solta todo mundo que estava preso a uma empresa. Chamado quando a empresa
// é EXCLUÍDA (não quando é arquivada - arquivar mantém o vínculo gravado
// justamente pra desarquivar devolver tudo como estava). Sem isso os
// acessos ficavam apontando pra um id que não existe mais e, como empresa
// inexistente devolve lista vazia de unidades, a pessoa entrava e não via
// absolutamente nada - sem nenhuma pista do motivo.
async function desvincularEmpresa(empresaId) {
  const presos = await listarPorEmpresa(empresaId);
  await Promise.all(presos.map((u) => usersRef.doc(u.id).update({ empresaId: null })));
  presos.forEach((u) => invalidarUsuario(u.id));
  if (presos.length) usersCache.invalidar();
  return presos.length;
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

// as 2 flags da Bonificação (ver bonificacao.js/bonificacaoPerfis.js): quem
// só tem a seção vê o próprio card ("você recebe R$X"); estas duas abrem
// visão ALÉM disso - faturamento/pool/taxas por trás da conta, e a lista de
// colaboradores nome a nome. Pedido explícito do usuário foi "nunca mostrar
// todos pra todo mundo" - por isso são 2 flags separadas, não uma só.
async function updatePodeBonifVerValorTotal(id, valor) {
  const ref = usersRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Acesso não encontrado.');
  if (snap.data().role === 'master') throw new Error('O acesso Master já pode tudo, não precisa dessa permissão.');
  await ref.update({ podeBonifVerValorTotal: !!valor });
  invalidarUsuario(id);
  usersCache.invalidar();
  return toPublic(await ref.get());
}

async function updatePodeBonifVerColaboradores(id, valor) {
  const ref = usersRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Acesso não encontrado.');
  if (snap.data().role === 'master') throw new Error('O acesso Master já pode tudo, não precisa dessa permissão.');
  await ref.update({ podeBonifVerColaboradores: !!valor });
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
async function updatePodeNoPulsoPrint(id, valor) {
  const ref = usersRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Acesso não encontrado.');
  if (snap.data().role === 'master') throw new Error('O acesso Master já pode tudo, não precisa dessa permissão.');
  await ref.update({ podeNoPulsoPrint: !!valor });
  invalidarUsuario(id);
  usersCache.invalidar();
  return toPublic(await ref.get());
}

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
// 'coordenador-agregador' é quem pausa item e fecha loja no iFood/99food.
// Entrou porque o Beniboy precisa saber A QUEM mandar esse pedido: pausar um
// item no agregador não é coisa que se resolve no chat nem que qualquer
// atendente faça - tem que chegar em quem tem o painel na mão (Master,
// 14/09). Sem um cargo, "o time" é todo mundo, e todo mundo é ninguém.
const CARGOS_VALIDOS = ['loja', 'gerente', 'assistente-gerente', 'tecnico', 'suporte', 'manutencao', 'operador', 'coordenador-agregador'];
// Ass. Ger (assistente de Gerente) tem as MESMAS permissoes de aprovacao do
// Gerente (check-out antecipado do Parque, decidir cortesia, alertas de
// limite do PCD cortesia, etc.) - qualquer checagem de "e gerente" espalhada
// pelo app deve tratar os dois cargos como equivalentes (ver ehCargoGerente)
// Os coordenadores de agregador ATIVOS - quem recebe pausa de item e
// fechamento de loja no iFood/99food quando o Cowork não executa (ver
// push.notifyAgregador). Hoje é só um caso de listarPorTag: a tag pode estar
// junto de outras (o Master designa alguém do Suporte pra cuidar disso).
async function listarCoordenadoresAgregador() {
  const lista = await listarPorTag('coordenador-agregador');
  return lista.map((u) => ({ ...u, temSuporte: u.ehTime || (u.secoes || []).includes('suporte') }));
}

// ---------------------------------------------------------------------------
// TAGS DE CARGO: MAIS DE UMA POR PESSOA
//
// Pedido do Master (14/09/2026): "precisamos poder marcar mais de 1 tag,
// assim eu designo alguém de suporte para cuidar de Agregador". Antes a tag
// era exclusiva (um rádio na tela): quem era Suporte não podia também ser
// Coord. Agregador, e o chamado do agregador não tinha em quem cair.
//
// O dado antigo NÃO foi reescrito (CLAUDE.md §1): `cargo` continua sendo a
// string que já existe em todo acesso e que o app inteiro lê hoje (tela
// inicial em index.html, nav-menu.js, Parque, conciliação, tarefas). O que
// entrou foi `cargos`, o ARRAY com o conjunto completo - e `cargo` passa a
// ser a PRINCIPAL dele (a primeira na ordem canônica de CARGOS_VALIDOS).
// Quem pergunta "essa pessoa é gerente?" continua funcionando sem saber que
// existe array; quem pergunta "quem cuida de agregador?" usa listarPorTag().
//
// Ordem canônica e não a de clique: duas pessoas com as mesmas tags têm a
// mesma principal, sempre - senão a tela inicial de alguém mudaria conforme a
// ordem em que o Master marcou as caixas.
function tagsDe(u) {
  if (!u) return [];
  const brutas = [...(Array.isArray(u.cargos) ? u.cargos : []), ...(u.cargo ? [u.cargo] : [])];
  const limpas = new Set(brutas.map((c) => String(c || '').toLowerCase()).filter((c) => CARGOS_VALIDOS.includes(c)));
  return CARGOS_VALIDOS.filter((c) => limpas.has(c));
}
function temTag(u, tag) {
  return tagsDe(u).includes(String(tag || '').toLowerCase());
}
// a tag principal: é ela que vai pro campo `cargo` (o que o app já lê)
function tagPrincipal(tags) {
  const lista = CARGOS_VALIDOS.filter((c) => (tags || []).includes(c));
  return lista[0] || null;
}

// Quem tem a tag, ativos. Duas consultas de propósito: o acesso ANTIGO só tem
// `cargo` (string) e nunca entraria num array-contains; o novo tem os dois.
// São ~2 leituras de poucos documentos e o alternativo seria reescrever o
// cadastro inteiro numa migração - exatamente o que o CLAUDE.md proíbe.
async function listarPorTag(tag) {
  const alvo = String(tag || '').toLowerCase();
  if (!CARGOS_VALIDOS.includes(alvo)) return [];
  const [porCampo, porArray] = await Promise.all([
    usersRef.where('cargo', '==', alvo).get(),
    usersRef.where('cargos', 'array-contains', alvo).get(),
  ]);
  const porId = new Map();
  for (const d of [...porCampo.docs, ...porArray.docs]) {
    const u = { id: d.id, ...d.data() };
    if (u.active === false) continue;
    porId.set(d.id, u);
  }
  return [...porId.values()]
    .map((u) => ({
      id: u.id,
      nome: u.nome || u.username || u.email,
      email: u.email || null,
      username: u.username || null,
      tags: tagsDe(u),
      // quem NAO abre a tela de destino recebe o push sem link pra ela -
      // clicar e cair em "voce nao tem acesso" e pior que nao ter link
      secoes: u.role === 'master' || u.isAdmin ? null : ((u.permissions || {}).sections) || [],
      ehTime: u.role === 'master' || !!u.isAdmin,
    }))
    // ordem estável: dois ticks da mesma varredura não podem trocar a ordem
    .sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR'));
}

function ehCargoGerente(cargo) {
  return cargo === 'gerente' || cargo === 'assistente-gerente';
}
// Grava o CONJUNTO de tags. Sempre escreve os dois campos juntos - `cargos`
// (o conjunto) e `cargo` (a principal, que é o que o resto do app lê) - pra
// nunca existir um acesso em que os dois discordem.
async function updateCargos(id, cargos) {
  const lista = (Array.isArray(cargos) ? cargos : [cargos]).map((c) => String(c || '').toLowerCase()).filter(Boolean);
  const invalida = lista.find((c) => !CARGOS_VALIDOS.includes(c));
  if (invalida) throw new Error(`Tag inválida: "${invalida}". Use ${CARGOS_VALIDOS.map((c) => `"${c}"`).join(', ')}.`);
  const limpas = CARGOS_VALIDOS.filter((c) => lista.includes(c)); // ordem canônica, sem repetido
  const ref = usersRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Acesso não encontrado.');
  if (snap.data().role === 'master') throw new Error('O acesso Master não usa tag de cargo.');
  await ref.update({ cargos: limpas, cargo: tagPrincipal(limpas) });
  invalidarUsuario(id);
  usersCache.invalidar();
  return toPublic(await ref.get());
}
// a forma antiga (uma tag só) continua valendo: é o que a rota
// PUT /api/users/:id/cargo manda, e trocar a principal não pode apagar em
// silêncio as outras tags que a pessoa já tinha
async function updateCargo(id, cargo) {
  const limpo = cargo ? String(cargo).toLowerCase() : null;
  if (limpo && !CARGOS_VALIDOS.includes(limpo)) throw new Error(`Tag inválida. Use ${CARGOS_VALIDOS.map((c) => `"${c}"`).join(', ')}.`);
  const snap = await usersRef.doc(id).get();
  if (!snap.exists) throw new Error('Acesso não encontrado.');
  const atuais = tagsDe(snap.data()).filter((c) => c !== snap.data().cargo);
  return updateCargos(id, limpo ? [limpo, ...atuais] : atuais);
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

// A palavra é escolhida pela própria pessoa enquanto está autenticada. Só o
// hash vai ao Firestore; nem o Master consegue lê-la depois de salva.
async function definirPalavraRecuperacao(id, senhaAtual, palavra) {
  const frase = validarPalavraRecuperacao(palavra);
  const ref = usersRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Acesso não encontrado.');
  const atual = snap.data();
  if (!await bcrypt.compare(String(senhaAtual || ''), atual.passwordHash)) throw new Error('Senha atual incorreta.');
  if (await bcrypt.compare(frase, atual.passwordHash)) throw new Error('A frase de recuperação não pode ser igual à senha.');
  await ref.update({
    palavraRecuperacaoHash: await bcrypt.hash(frase, 12),
    palavraRecuperacaoDefinidaEm: new Date().toISOString(),
  });
  invalidarUsuario(id);
  usersCache.invalidar();
  return { ok: true };
}

// Esta verificação acontece em uma rota própria do login, nunca no chat do
// Beniboy. O token devolvido é aleatório, de uso único e dura só 10 minutos.
async function iniciarRecuperacaoSenha(identifier, palavra) {
  const alvo = await findByIdentifier(identifier);
  if (!alvo || alvo.active === false || alvo.role === 'master' || !alvo.palavraRecuperacaoHash) return null;
  const frase = normalizarPalavraRecuperacao(palavra);
  if (!frase || !await bcrypt.compare(frase, alvo.palavraRecuperacaoHash)) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  const id = crypto.createHash('sha256').update(token).digest('hex');
  await recuperacoesSenhaRef.doc(id).set({
    userId: alvo.id,
    criadoEm: new Date().toISOString(),
    expiraEmMs: Date.now() + RECUPERACAO_TTL_MS,
    usadoEm: null,
  });
  return token;
}

async function concluirRecuperacaoSenha(token, novaSenha) {
  if (!novaSenha || String(novaSenha).length < 8) throw new Error('A nova senha deve ter pelo menos 8 caracteres.');
  const id = crypto.createHash('sha256').update(String(token || '')).digest('hex');
  const ref = recuperacoesSenhaRef.doc(id);
  let userId = null;
  let usuario = null;
  await db.runTransaction(async (tx) => {
    const recuperacao = await tx.get(ref);
    if (!recuperacao.exists) throw new Error('Essa recuperação não é válida. Inicie novamente.');
    const dados = recuperacao.data();
    if (dados.usadoEm || !dados.expiraEmMs || Number(dados.expiraEmMs) < Date.now()) {
      throw new Error('Essa recuperação expirou. Inicie novamente.');
    }
    const userRef = usersRef.doc(dados.userId);
    const user = await tx.get(userRef);
    if (!user.exists || user.data().active === false) throw new Error('Esse acesso não está disponível para recuperação.');
    const passwordHash = await bcrypt.hash(String(novaSenha), 12);
    tx.update(userRef, { passwordHash, locked: false, failedAttempts: 0, precisaTrocarSenha: false, desbloqueadoPeloBotEm: null });
    tx.update(ref, { usadoEm: new Date().toISOString() });
    userId = user.id;
    usuario = user.data().username || user.data().email || user.id;
  });
  invalidarUsuario(userId);
  usersCache.invalidar();
  await sessions.encerrarTodasDoUsuario(userId);
  return { ok: true, usuario };
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
    temPalavraRecuperacao: !!data.palavraRecuperacaoHash,
    permissions: data.role === 'master' ? null : data.permissions || emptyPermissions(),
    horarioPermitido: data.role === 'master' ? null : data.horarioPermitido || { ativo: false, inicio: '', fim: '' },
    isAdmin: data.role === 'master' ? null : !!data.isAdmin,
    empresaId: data.role === 'master' ? null : data.empresaId || null,
    podeCatalogoEstoque: data.role === 'master' ? null : !!data.podeCatalogoEstoque,
    podeCatalogoInsumos: data.role === 'master' ? null : !!data.podeCatalogoInsumos,
    podeCadastrarOperadores: data.role === 'master' ? null : !!data.podeCadastrarOperadores,
    // NoPulsoPrint no celular: o atalho do computador é por MÁQUINA (cadastro
    // do computador); celular não tem cadastro de máquina, então aqui é por
    // PESSOA. As duas marcas convivem e não se substituem.
    podeNoPulsoPrint: data.role === 'master' ? null : !!data.podeNoPulsoPrint,
    podeRhTodasUnidades: data.role === 'master' ? null : !!data.podeRhTodasUnidades,
    podeRhCadastrarEfetivado: data.role === 'master' ? null : !!data.podeRhCadastrarEfetivado,
    podeBonifVerValorTotal: data.role === 'master' ? null : !!data.podeBonifVerValorTotal,
    podeBonifVerColaboradores: data.role === 'master' ? null : !!data.podeBonifVerColaboradores,
    sessaoLonga: !!data.sessaoLonga,
    cargo: data.role === 'master' ? null : data.cargo || null,
    // o conjunto inteiro; `cargo` acima continua sendo a principal (tagsDe)
    cargos: data.role === 'master' ? [] : tagsDe(data),
    qaMaster: data.role === 'master' ? !!data.qaMaster : null,
    qaUser: data.role === 'master' ? null : !!data.qaUser,
    perfilVisual: data.perfilVisual || null,
    createdAt: data.createdAt,
  };
}

// ---------------------------------------------------------------
// SUGESTAO DE ACESSO (botao "Criar acesso" do ticket de Suporte de TI,
// ver central-historico.html). Monta email + usuario livres a partir do
// nome da pessoa, sem gravar nada.
//
// Regra do usuario, definida pelo Master:
//   1) so o primeiro nome              -> priscila
//   2) se ocupado, so o sobrenome      -> pereira
//   3) se ocupado, inicial + sobrenome -> ppereira
//   4) se ocupado, sufixo numerico     -> ppereira2, ppereira3...
// O email e sempre nome.sobrenome@dominio, com o mesmo sufixo numerico
// quando ja existir.
//
// IMPORTANTE: isso so OLHA o que esta livre agora. Quem grava e o
// create(), que confere email e usuario DE NOVO dentro da transacao -
// entao dois Masters pedindo sugestao ao mesmo tempo nao conseguem criar
// dois acessos iguais; o segundo recebe "Já existe um acesso com esse
// usuário" e pede outra sugestao.
// ---------------------------------------------------------------
function semAcento(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function soLetras(s) {
  return semAcento(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// "Priscila Pereira" -> {nome:'Priscila', sobrenome:'Pereira'}
// "Maria da Silva Santos" -> {nome:'Maria', sobrenome:'Santos'}
// Conectivos (de/da/do/das/dos/e) nunca viram sobrenome.
const CONECTIVOS = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);
function separarNome(completo) {
  const partes = String(completo == null ? '' : completo).trim().split(/\s+/).filter(Boolean);
  const nome = partes[0] || '';
  let sobrenome = '';
  for (let i = partes.length - 1; i >= 1; i--) {
    if (!CONECTIVOS.has(soLetras(partes[i]))) { sobrenome = partes[i]; break; }
  }
  return { nome, sobrenome };
}

function gerarSenhaTemporaria() {
  // 12 caracteres url-safe. O Master le no card e repassa por fora do app -
  // mesmo fluxo que ja existe quando ele cria um acesso na mao (o create()
  // marca precisaTrocarSenha, entao ela troca no primeiro login).
  return crypto.randomBytes(9).toString('base64url');
}

const DOMINIO_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

async function sugerirAcesso({ nome, sobrenome, nomeCompleto, dominio }) {
  if (nomeCompleto && !nome) ({ nome, sobrenome } = separarNome(nomeCompleto));
  const n = soLetras(nome);
  const s = soLetras(sobrenome);
  if (n.length < 2) throw new Error('Informe o primeiro nome (pelo menos 2 letras).');

  const dom = String(dominio == null ? '' : dominio).trim().toLowerCase().replace(/^@/, '');
  if (!DOMINIO_RE.test(dom)) throw new Error('Domínio inválido (ex: grupobravoempresarial.com).');

  const todos = await list();
  const usernamesUsados = new Set(todos.map((u) => (u.username || '').toLowerCase()).filter(Boolean));
  const emailsUsados = new Set(todos.map((u) => (u.email || '').toLowerCase()).filter(Boolean));

  const candidatos = [n];
  if (s) candidatos.push(s, n[0] + s);
  const tentativas = candidatos
    .map((c) => c.slice(0, 30))
    .filter((c) => c.length >= 2)
    .map((c) => ({ usuario: c, livre: !usernamesUsados.has(c) }));

  let username = (tentativas.find((t) => t.livre) || {}).usuario || '';
  if (!username) { // 4) todas ocupadas: sufixo numerico na ultima forma
    const base = (s ? n[0] + s : n).slice(0, 27);
    for (let i = 2; i < 1000 && !username; i++) {
      if (!usernamesUsados.has(base + i)) username = base + i;
    }
  }

  const baseEmail = s ? `${n}.${s}` : n;
  let email = `${baseEmail}@${dom}`;
  for (let i = 2; i < 1000 && emailsUsados.has(email); i++) email = `${baseEmail}${i}@${dom}`;

  return { nome, sobrenome, dominio: dom, email, username, tentativas, senha: gerarSenhaTemporaria() };
}

// Cria o acesso copiando as PERMISSOES de um usuario que ja existe.
//
// De proposito copia so o bloco `permissions` (seções, unidades, subgrupos
// do cofre, tipos de solicitação). NAO copia isAdmin, qaUser, cargo nem os
// pode* (catálogo de estoque/insumos, cadastrar operadores, RH todas as
// unidades...). Esses sao privilegios extras, e herdar em silencio um
// "Admin" so porque o modelo era Admin e do tipo de coisa que ninguem
// percebe ate dar errado. Se precisar, o Master liga depois em Usuários.
async function criarCopiandoDe({ modeloId, email, username, senha }) {
  const todos = await list();
  const modelo = todos.find((u) => u.id === modeloId);
  if (!modelo) throw new Error('Usuário-modelo não encontrado.');
  if (modelo.role === 'master') throw new Error('Não dá pra copiar de um acesso Master. Escolha um usuário comum que já tenha o acesso certo.');
  if (!modelo.permissions || !(modelo.permissions.sections || []).length) {
    throw new Error(`O modelo (${modelo.username || modelo.email}) não tem nenhuma seção liberada - o acesso novo nasceria sem poder abrir nada.`);
  }
  const criado = await create({ email, password: senha, username, permissions: modelo.permissions });
  return {
    usuario: criado,
    copiadoDe: { id: modelo.id, email: modelo.email, username: modelo.username },
    naoCopiado: { isAdmin: !!modelo.isAdmin, cargo: modelo.cargo || null },
  };
}

module.exports = {
  listarCoordenadoresAgregador,
  VALID_SECTIONS,
  SECTION_VERTICAIS,
  secoesDaVertical,
  verticalDaSecao,
  separarNome,
  soLetras,
  sugerirAcesso,
  criarCopiandoDe,
  TIPOS_SOLICITACAO,
  CARGOS_VALIDOS,
  tagsDe, temTag, tagPrincipal, listarPorTag, updateCargos,
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
  updateEmpresa,
  listarPorEmpresa,
  desvincularEmpresa,
  updatePodeCatalogoEstoque,
  updatePodeCatalogoInsumos,
  updatePodeCadastrarOperadores,
  updatePodeNoPulsoPrint,
  updatePodeRhTodasUnidades,
  updatePodeRhCadastrarEfetivado,
  updatePodeBonifVerValorTotal,
  updatePodeBonifVerColaboradores,
  updateSessaoLonga,
  updateCargo,
  updateUsername,
  updatePerfilVisual,
  updateUsernamesEmMassa,
  resetPassword,
  desbloquear,
  alterarSenhaPropria,
  validarPalavraRecuperacao,
  definirPalavraRecuperacao,
  iniciarRecuperacaoSenha,
  concluirRecuperacaoSenha,
  remove,
  invalidar: () => usersCache.invalidar(),
};

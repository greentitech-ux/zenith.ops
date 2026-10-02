// Cadastro operacional de entregadores. Nao apaga pessoas: uma exclusao
// vira solicitacao e o Master decide, preservando o vinculo dos lancamentos
// antigos com o nome que existia no dia.
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('entregadoresEntregas');
const SOLICITACOES = db.collection('entregadoresEntregasSolicitacoes');

const TIPOS_VALIDOS = new Set(['MOOVERY_FIXO', 'MOOVERY_NUVEM', 'OUTRO']);
const PADROES = {
  'Dominos Campina Grande': [
    ['MOOVERY FIXO 01', 'MOOVERY_FIXO'], ['MOOVERY FIXO 02', 'MOOVERY_FIXO'],
    ['MOOVERY FIXO 03', 'MOOVERY_FIXO'], ['MOOVERY FIXO 04', 'MOOVERY_FIXO'],
    ['MOOVERY NUVEM', 'MOOVERY_NUVEM'],
  ],
};

function texto(v, max = 80) { return String(v || '').trim().replace(/\s+/g, ' ').slice(0, max); }
function chaveNome(nome) {
  return texto(nome).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function idPara(unidade, nome) { return `${String(unidade)}__${chaveNome(nome)}`.slice(0, 140); }
function tipoValido(tipo) { return TIPOS_VALIDOS.has(tipo) ? tipo : 'OUTRO'; }

async function listarBruto() {
  const snap = await COLLECTION.get();
  return snap.docs.map((d) => d.data());
}
const cache = createCache(listarBruto, 60 * 1000);

async function listarTodos(unidade) {
  const registrados = (await cache.cached()).filter((e) => e.unidade === unidade);
  const porChave = new Map(registrados.map((e) => [chaveNome(e.nome), e]));
  const padroes = (PADROES[unidade] || []).map(([nome, tipo]) => {
    const existente = porChave.get(chaveNome(nome));
    return existente || { id: `padrao:${idPara(unidade, nome)}`, unidade, nome, tipo, ativo: true, padrao: true };
  });
  const adicionais = registrados.filter((e) => !PADROES[unidade]?.some(([nome]) => chaveNome(nome) === chaveNome(e.nome)));
  return [...padroes, ...adicionais]
    .filter((e) => e.excluido !== true)
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

async function listarAtivos(unidade) {
  return (await listarTodos(unidade)).filter((e) => e.ativo !== false);
}

async function encontrarAtivo(unidade, nome) {
  const chave = chaveNome(nome);
  if (!chave) return null;
  return (await listarAtivos(unidade)).find((e) => chaveNome(e.nome) === chave) || null;
}

function validarNomeCompleto(nome) {
  return texto(nome).split(' ').filter((parte) => parte.length >= 2).length >= 2;
}

function limparTelefone(telefone) {
  const informado = texto(telefone, 30);
  if (!informado) return null;
  const digitos = informado.replace(/\D/g, '');
  if (digitos.length < 10 || digitos.length > 11) throw new Error('Informe um telefone válido com DDD, ou deixe o campo vazio.');
  return digitos;
}

async function criar({ unidade, nome, telefone, tipo, porId, porEmail }) {
  const nomeLimpo = texto(nome);
  if (!validarNomeCompleto(nomeLimpo)) throw new Error('Informe o nome e o sobrenome do entregador.');
  const telefoneLimpo = limparTelefone(telefone);
  const id = idPara(unidade, nomeLimpo);
  if (!id || id.endsWith('__')) throw new Error('Nome do entregador inválido.');
  const existente = await COLLECTION.doc(id).get();
  if (existente.exists && existente.data().ativo !== false) throw new Error('Esse entregador já está cadastrado nesta unidade.');
  const agora = new Date().toISOString();
  const dadosExistentes = existente.exists ? existente.data() : {};
  const registro = {
    id, unidade, nome: nomeLimpo, telefone: telefoneLimpo || dadosExistentes.telefone || null,
    tipo: tipoValido(tipo), ativo: true, excluido: false,
    criadoEm: dadosExistentes.criadoEm || agora,
    criadoPorId: dadosExistentes.criadoPorId || porId,
    criadoPorEmail: dadosExistentes.criadoPorEmail || porEmail,
    reativadoEm: existente.exists ? agora : null,
    atualizadoEm: agora, atualizadoPorEmail: porEmail,
  };
  await COLLECTION.doc(id).set(registro, { merge: true });
  cache.invalidar();
  return registro;
}

async function definirAtivo({ unidade, id, ativo, porEmail }) {
  const encontrado = (await listarTodos(unidade)).find((item) => item.id === id);
  if (!encontrado) throw new Error('Entregador não encontrado nesta unidade.');
  const idReal = String(id).startsWith('padrao:') ? idPara(unidade, encontrado.nome) : id;
  const agora = new Date().toISOString();
  const alteracao = {
    id: idReal, unidade, nome: encontrado.nome, telefone: encontrado.telefone || null,
    tipo: tipoValido(encontrado.tipo), ativo: Boolean(ativo), excluido: false,
    atualizadoEm: agora, atualizadoPorEmail: porEmail,
    ...(ativo ? { reativadoEm: agora } : { desativadoEm: agora, desativadoPorEmail: porEmail }),
  };
  await COLLECTION.doc(idReal).set(alteracao, { merge: true });
  cache.invalidar();
  return alteracao;
}

async function solicitarExclusao({ unidade, entregador, motivo, solicitadoPorId, solicitadoPorEmail }) {
  const ativo = (await listarTodos(unidade)).find((item) => chaveNome(item.nome) === chaveNome(entregador));
  if (!ativo) throw new Error('Entregador não encontrado nesta unidade.');
  const motivoLimpo = texto(motivo, 500);
  if (!motivoLimpo) throw new Error('Explique o motivo da exclusão.');
  const pendentes = await SOLICITACOES.where('unidade', '==', unidade).where('entregadorChave', '==', chaveNome(ativo.nome)).where('status', '==', 'PENDENTE').get();
  if (!pendentes.empty) throw new Error('Já existe uma solicitação de exclusão pendente para este entregador.');
  const ref = SOLICITACOES.doc();
  const pedido = {
    id: ref.id, unidade, entregador: ativo.nome, entregadorChave: chaveNome(ativo.nome),
    motivo: motivoLimpo, status: 'PENDENTE', solicitadoPorId, solicitadoPorEmail,
    criadoEm: new Date().toISOString(), decididoEm: null, decididoPorEmail: null, motivoDecisao: null,
  };
  await ref.set(pedido);
  return pedido;
}

async function listarSolicitacoes({ unidade = null, solicitadoPorId = null } = {}) {
  const snap = await SOLICITACOES.orderBy('criadoEm', 'desc').get();
  return snap.docs.map((d) => d.data()).filter((p) =>
    (!unidade || p.unidade === unidade) && (!solicitadoPorId || p.solicitadoPorId === solicitadoPorId));
}

async function decidirExclusao(id, status, { decididoPorEmail, motivoDecisao }) {
  if (!['APROVADO', 'REJEITADO'].includes(status)) throw new Error('Status inválido.');
  const ref = SOLICITACOES.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  const pedido = snap.data();
  if (pedido.status !== 'PENDENTE') throw new Error('Essa solicitação já foi decidida.');
  const agora = new Date().toISOString();
  await ref.update({ status, decididoEm: agora, decididoPorEmail, motivoDecisao: texto(motivoDecisao, 500) || null });
  if (status === 'APROVADO') {
    const idEntregador = idPara(pedido.unidade, pedido.entregador);
    const atual = await COLLECTION.doc(idEntregador).get();
    const tipoAtual = atual.exists ? tipoValido(atual.data().tipo) : null;
    const tipoPadrao = (PADROES[pedido.unidade] || [])
      .find(([nome]) => chaveNome(nome) === chaveNome(pedido.entregador))?.[1];
    await COLLECTION.doc(idEntregador).set({
      id: idEntregador, unidade: pedido.unidade, nome: pedido.entregador,
      tipo: tipoAtual || tipoPadrao || 'OUTRO', ativo: false, excluido: true, excluidoEm: agora, excluidoPorEmail: decididoPorEmail,
      motivoDesativacao: pedido.motivo, atualizadoEm: agora, atualizadoPorEmail: decididoPorEmail,
    }, { merge: true });
    cache.invalidar();
  }
  return { ...pedido, status, decididoEm: agora, decididoPorEmail };
}

module.exports = { TIPOS_VALIDOS, listarTodos, listarAtivos, encontrarAtivo, criar, definirAtivo, solicitarExclusao, listarSolicitacoes, decidirExclusao, chaveNome, idPara, invalidar: () => cache.invalidar() };

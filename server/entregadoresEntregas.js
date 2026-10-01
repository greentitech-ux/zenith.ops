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

async function listarAtivos(unidade) {
  const registrados = (await cache.cached()).filter((e) => e.unidade === unidade);
  const porChave = new Map(registrados.map((e) => [chaveNome(e.nome), e]));
  const padroes = (PADROES[unidade] || []).map(([nome, tipo]) => {
    const existente = porChave.get(chaveNome(nome));
    return existente || { id: `padrao:${idPara(unidade, nome)}`, unidade, nome, tipo, ativo: true, padrao: true };
  });
  const adicionais = registrados.filter((e) => !PADROES[unidade]?.some(([nome]) => chaveNome(nome) === chaveNome(e.nome)));
  return [...padroes, ...adicionais]
    .filter((e) => e.ativo !== false)
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

async function encontrarAtivo(unidade, nome) {
  const chave = chaveNome(nome);
  if (!chave) return null;
  return (await listarAtivos(unidade)).find((e) => chaveNome(e.nome) === chave) || null;
}

async function criar({ unidade, nome, tipo, porId, porEmail }) {
  const nomeLimpo = texto(nome);
  if (nomeLimpo.length < 3) throw new Error('Informe o nome do entregador.');
  const id = idPara(unidade, nomeLimpo);
  if (!id || id.endsWith('__')) throw new Error('Nome do entregador inválido.');
  const existente = await COLLECTION.doc(id).get();
  if (existente.exists && existente.data().ativo !== false) throw new Error('Esse entregador já está cadastrado nesta unidade.');
  const agora = new Date().toISOString();
  const registro = {
    id, unidade, nome: nomeLimpo, tipo: tipoValido(tipo), ativo: true,
    criadoEm: existente.exists ? existente.data().criadoEm : agora,
    criadoPorId: existente.exists ? existente.data().criadoPorId : porId,
    criadoPorEmail: existente.exists ? existente.data().criadoPorEmail : porEmail,
    reativadoEm: existente.exists ? agora : null,
    atualizadoEm: agora, atualizadoPorEmail: porEmail,
  };
  await COLLECTION.doc(id).set(registro, { merge: true });
  cache.invalidar();
  return registro;
}

async function solicitarExclusao({ unidade, entregador, motivo, solicitadoPorId, solicitadoPorEmail }) {
  const ativo = await encontrarAtivo(unidade, entregador);
  if (!ativo) throw new Error('Entregador ativo não encontrado nesta unidade.');
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
      tipo: tipoAtual || tipoPadrao || 'OUTRO', ativo: false, desativadoEm: agora, desativadoPorEmail: decididoPorEmail,
      motivoDesativacao: pedido.motivo, atualizadoEm: agora, atualizadoPorEmail: decididoPorEmail,
    }, { merge: true });
    cache.invalidar();
  }
  return { ...pedido, status, decididoEm: agora, decididoPorEmail };
}

module.exports = { TIPOS_VALIDOS, listarAtivos, encontrarAtivo, criar, solicitarExclusao, listarSolicitacoes, decidirExclusao, chaveNome, idPara, invalidar: () => cache.invalidar() };

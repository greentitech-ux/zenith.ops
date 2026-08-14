// qaAprovacoes.js
// Fila de aprovação das ações "sensíveis" tentadas por um acesso QA Master
// (ver users.js/auth.js: req.isQaMaster). QA Master tem 100% do acesso de
// um Master de verdade - as rotas continuam sendo as mesmas de sempre, só
// que index.js (ver interceptarQaMaster) desvia um conjunto específico de
// rotas (exclusões + configuração global: Usuários, Grupos, Unidades,
// estrutura do Cofre) pra cá em vez de executar na hora. A ação fica
// PARADA aqui até um Master de verdade (não QA Master) aprovar ou
// rejeitar - só assim o executor de verdade roda (ver EXECUTORES_QA em
// index.js). Isso é proteção real: como o próprio QA Master não pode
// decidir sobre a própria solicitação (ver rota de aprovar/rejeitar,
// exige requireMaster e barra quem é QA Master), ele não consegue
// contornar sozinho.
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('qaAprovacoes');

async function listUncached() {
  const snap = await COLLECTION.orderBy('criadoEm', 'desc').limit(300).get();
  return snap.docs.map((d) => d.data());
}
const cache = createCache(listUncached, 5 * 1000);
const listar = cache.cached;

async function listarPendentes() {
  const todas = await listar();
  return todas.filter((a) => a.status === 'pendente');
}

async function obter(id) {
  const snap = await COLLECTION.doc(id).get();
  return snap.exists ? snap.data() : null;
}

// registra a ação parada - "payload" é o que o executor vai precisar pra
// rodar de verdade quando aprovado (ver EXECUTORES_QA em index.js), nunca
// exposto fora de rotas de Master (pode conter dado sensível, ex: nova
// senha de reset)
async function criar({
  tipo, resumo, payload, criadoPorId, criadoPorEmail,
}) {
  const ref = COLLECTION.doc();
  const registro = {
    id: ref.id,
    tipo,
    resumo: String(resumo || '').slice(0, 300),
    payload: payload || {},
    status: 'pendente',
    criadoPorId: criadoPorId || null,
    criadoPorEmail: criadoPorEmail || null,
    criadoEm: new Date().toISOString(),
    decididoPorEmail: null,
    decididoEm: null,
    motivoRejeicao: null,
    erroExecucao: null,
  };
  await ref.set(registro);
  cache.invalidar();
  return registro;
}

// 'aprovado' (executor rodou com sucesso) | 'rejeitado' (Master recusou,
// nunca executa) | 'erro' (Master aprovou mas o executor falhou - fica
// visível pro Master decidir se tenta aprovar de novo ou rejeita)
async function marcarDecidido(id, {
  status, decididoPorEmail, motivoRejeicao, erroExecucao,
}) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação de aprovação não encontrada.');
  const patch = {
    status,
    decididoPorEmail: decididoPorEmail || null,
    decididoEm: new Date().toISOString(),
    motivoRejeicao: motivoRejeicao || null,
    erroExecucao: erroExecucao || null,
  };
  await ref.update(patch);
  cache.invalidar();
  return { ...snap.data(), ...patch };
}

module.exports = {
  listar, listarPendentes, obter, criar, marcarDecidido,
};

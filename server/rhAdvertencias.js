// rhAdvertencias.js
// Fluxo de solicitacao de advertencia disciplinar - so pra colaborador
// EFETIVADO (extra e candidato em teste de 5 dias nao tem essa opcao, ver
// gate em index.js). O gerente da unidade abre o pedido com motivo +
// evidencias (fotos); precisa de aprovacao do RH (tag "RH todas as
// unidades")/Admin/Master pra seguir. Uma vez aprovado, abre um prazo de
// 48h pro RH anexar o arquivo formal de advertencia (documento) pro
// colaborador assinar - o gerente baixa esse arquivo, colhe a assinatura
// e sobe de volta o assinado, fechando o ciclo:
//
//   pendente -> aguardando_documento -> aguardando_assinatura -> concluida
//           \-> recusada
//
// Duvidas no meio do processo rolam no chat generico (ver centralChat.js,
// reaproveitado aqui com tipo 'rh-advertencia' em vez de duplicar um chat).
// Baixo trafego esperado (evento raro), por isso sem cache - mesmo
// raciocinio de centralChat.js.
const db = require('./firestore');

const COLLECTION = db.collection('rhAdvertencias');

const PRAZO_DOCUMENTO_MS = 48 * 60 * 60 * 1000;

function limpar(v, max) {
  return String(v || '').trim().slice(0, max);
}

async function criar({
  funcionarioId, funcionarioNome, unidade, motivo, evidencias, solicitadoPorId, solicitadoPorEmail,
}) {
  const motivoOk = limpar(motivo, 1000);
  if (!motivoOk) throw new Error('Descreva o motivo da advertência.');
  const ref = COLLECTION.doc();
  const agora = new Date().toISOString();
  const registro = {
    id: ref.id,
    funcionarioId,
    funcionarioNome,
    unidade,
    motivo: motivoOk,
    evidencias: evidencias || [],
    solicitadoPorId: solicitadoPorId || null,
    solicitadoPorEmail: solicitadoPorEmail || null,
    status: 'pendente',
    decisao: null,
    prazoDocumentoAte: null,
    alertaPrazoVencidoEnviadoEm: null,
    documento: null,
    documentoAssinado: null,
    criadoEm: agora,
    atualizadoEm: agora,
  };
  await ref.set(registro);
  return registro;
}

async function getOne(id) {
  const doc = await COLLECTION.doc(id).get();
  return doc.exists ? doc.data() : null;
}

async function listAll() {
  const snap = await COLLECTION.orderBy('criadoEm', 'desc').limit(1000).get();
  return snap.docs.map((d) => d.data());
}

async function listByUnidades(unidades) {
  const todos = await listAll();
  if (unidades == null) return todos;
  if (!unidades.length) return [];
  const alvo = new Set(unidades);
  return todos.filter((r) => alvo.has(r.unidade));
}

async function decidir(id, { aprovado, motivoRecusa, porEmail }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  const atual = snap.data();
  if (atual.status !== 'pendente') throw new Error('Essa solicitação já foi decidida.');
  const agora = new Date().toISOString();
  const merge = {
    decisao: {
      aprovado: !!aprovado,
      motivoRecusa: aprovado ? null : limpar(motivoRecusa, 500),
      porEmail: porEmail || null,
      decididoEm: agora,
    },
    status: aprovado ? 'aguardando_documento' : 'recusada',
    prazoDocumentoAte: aprovado ? new Date(Date.now() + PRAZO_DOCUMENTO_MS).toISOString() : null,
    atualizadoEm: agora,
  };
  await ref.update(merge);
  return { ...atual, ...merge };
}

async function anexarDocumento(id, { documento, porEmail }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  const atual = snap.data();
  if (atual.status !== 'aguardando_documento') throw new Error('Essa solicitação não está aguardando documento.');
  const agora = new Date().toISOString();
  const merge = {
    documento: { ...documento, anexadoPorEmail: porEmail || null, anexadoEm: agora },
    status: 'aguardando_assinatura',
    atualizadoEm: agora,
  };
  await ref.update(merge);
  return { ...atual, ...merge };
}

async function enviarAssinado(id, { documento, porEmail }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  const atual = snap.data();
  if (atual.status !== 'aguardando_assinatura') throw new Error('Essa solicitação não está aguardando assinatura.');
  const agora = new Date().toISOString();
  const merge = {
    documentoAssinado: { ...documento, enviadoPorEmail: porEmail || null, enviadoEm: agora },
    status: 'concluida',
    atualizadoEm: agora,
  };
  await ref.update(merge);
  return { ...atual, ...merge };
}

// job periodico (ver rodarAlertaAdvertenciaVencida em index.js): quem
// passou do prazo de 48h sem documento anexado e ainda sem alerta de
// atraso enviado - dispara 1x, mesmo padrao de alertaTesteEnviadoEm em rh.js
async function verificarPrazosVencidos() {
  const todos = await listAll();
  const agora = new Date().toISOString();
  return todos.filter((r) => (
    r.status === 'aguardando_documento' && r.prazoDocumentoAte && r.prazoDocumentoAte < agora && !r.alertaPrazoVencidoEnviadoEm
  ));
}

async function marcarAlertaPrazoVencidoEnviado(id) {
  await COLLECTION.doc(id).update({ alertaPrazoVencidoEnviadoEm: new Date().toISOString() });
}

module.exports = {
  criar, getOne, listAll, listByUnidades, decidir, anexarDocumento, enviarAssinado,
  verificarPrazosVencidos, marcarAlertaPrazoVencidoEnviado,
};

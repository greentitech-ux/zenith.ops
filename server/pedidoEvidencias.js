// Link público de evidência de pedido: o Monitor gera uma credencial curta,
// compartilhável e de uso único. A pessoa decide autorizar a câmera e a
// localização no navegador; o segredo nunca é guardado em texto no Firestore.
const crypto = require('crypto');
const db = require('./firestore');

const COLLECTION = db.collection('pedidoEvidencias');
const VALIDADE_MS = 24 * 60 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function tokenNovo() {
  return crypto.randomBytes(24).toString('base64url');
}

async function criar({ pedidoId, unidade, cliente, valor, criadoPor }) {
  const token = tokenNovo();
  const agora = new Date();
  const expiraEm = new Date(agora.getTime() + VALIDADE_MS).toISOString();
  const doc = COLLECTION.doc();
  await doc.set({
    id: doc.id,
    tokenHash: hashToken(token),
    pedidoId: String(pedidoId || '').slice(0, 80),
    unidade: String(unidade || '').slice(0, 120) || null,
    cliente: String(cliente || '').slice(0, 120) || null,
    valor: Number.isFinite(Number(valor)) ? Number(valor) : null,
    criadoPor: String(criadoPor || '').slice(0, 180) || null,
    criadoEm: agora.toISOString(),
    expiraEm,
    estado: 'PENDENTE',
    usadoEm: null,
    disputeId: null,
  });
  return { token, expiraEm, id: doc.id };
}

async function porToken(token) {
  if (!/^[A-Za-z0-9_-]{24,}$/.test(String(token || ''))) return null;
  const snap = await COLLECTION.where('tokenHash', '==', hashToken(token)).limit(1).get();
  if (snap.empty) return null;
  return snap.docs[0].data();
}

function estadoPublico(registro) {
  if (!registro) return 'INVALIDO';
  if (registro.estado === 'USADO') return 'USADO';
  if (registro.estado === 'EM_PROCESSAMENTO') return 'PROCESSANDO';
  if (!registro.expiraEm || new Date(registro.expiraEm).getTime() <= Date.now()) return 'EXPIRADO';
  return 'PENDENTE';
}

async function reservar(id) {
  const ref = COLLECTION.doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const registro = snap.exists ? snap.data() : null;
    if (estadoPublico(registro) !== 'PENDENTE') return false;
    tx.update(ref, { estado: 'EM_PROCESSAMENTO', processamentoEm: new Date().toISOString() });
    return true;
  });
}

async function concluir(id, disputeId) {
  const usadoEm = new Date().toISOString();
  await COLLECTION.doc(id).update({ estado: 'USADO', usadoEm, disputeId: disputeId || null });
  return { usadoEm };
}

async function liberar(id) {
  await COLLECTION.doc(id).update({ estado: 'PENDENTE', processamentoEm: null });
}

module.exports = { criar, porToken, estadoPublico, reservar, concluir, liberar, VALIDADE_MS };

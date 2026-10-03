// O Master original configurado no servidor é a única autoridade superior.
// O ID é persistido uma vez: mudar o e-mail não transfere a autoridade.
const db = require('./firestore');
const ref = db.collection('config').doc('masterPrincipal');
let idResolvido = null;
let resolvendo = null;
async function resolverId() {
  if (idResolvido) return idResolvido;
  if (resolvendo) return resolvendo;
  resolvendo = (async () => {
    const salvo = await ref.get();
    if (salvo.exists && salvo.data()?.usuarioId) return salvo.data().usuarioId;
    const email = String(process.env.MASTER_EMAIL || '').trim().toLowerCase();
    if (!email) return null; // não promover o primeiro Master encontrado
    const snap = await db.collection('users').where('email', '==', email).get();
    const candidatos = snap.docs.filter(d=>d.data().role==='master' && !d.data().qaMaster);
    if (candidatos.length !== 1) return null;
    const usuarioId = candidatos[0].id;
    return db.runTransaction(async tx=>{
      const atual = await tx.get(ref);
      if (atual.exists && atual.data()?.usuarioId) return atual.data().usuarioId;
      tx.set(ref, {usuarioId, criadoEm:new Date().toISOString()});
      return usuarioId;
    });
  })();
  try { idResolvido = await resolvendo; return idResolvido; }
  finally { resolvendo = null; }
}
async function ehPrincipal(usuario) {
  if (!usuario || usuario.role !== 'master' || usuario.qaMaster) return false;
  const id = await resolverId();
  return !!id && usuario.id === id;
}
async function exigirGerenciaMaster(alvo, ator) {
  if (alvo?.role !== 'master') return;
  if (!await ehPrincipal(ator)) throw new Error('Somente o Master principal pode gerenciar outra conta Master.');
}
module.exports = {resolverId,ehPrincipal,exigirGerenciaMaster};

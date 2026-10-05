'use strict';

// Histórico enxuto de entradas no NoPulso. O aviso original em avisosLogin.js
// é só SSE: desaparece se nenhum Master estiver conectado. Este módulo guarda
// somente o mínimo necessário para auditoria (quando, quem e onde), sem senha,
// IP, user-agent ou qualquer dado de sessão.
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('historicoEntradasUsuarios');
const LIMITE_PADRAO = 50;
const LIMITE_MAXIMO = 100;

function limiteSeguro(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return LIMITE_PADRAO;
  return Math.max(1, Math.min(Math.trunc(n), LIMITE_MAXIMO));
}

function entradaPublica(dados) {
  return {
    id: dados.id,
    ordem: dados.ordem,
    em: dados.em,
    usuario: dados.usuario,
    metodo: dados.metodo,
    unidade: dados.unidade || null,
    unidadeCodigo: dados.unidadeCodigo || null,
    maquina: dados.maquina || null,
  };
}

async function listarRecentesSemCache() {
  const snap = await COLLECTION.orderBy('ordem', 'desc').limit(LIMITE_PADRAO).get();
  return snap.docs.map((doc) => entradaPublica(doc.data()));
}

// A tela é aberta só pelo Master e não faz polling. Ainda assim, este cache
// compartilha uma mesma leitura recente entre atualizações manuais e abas.
const recentesCache = createCache(listarRecentesSemCache, 5 * 60 * 1000);

async function listar({ antes = null, limite = LIMITE_PADRAO } = {}) {
  const tamanho = limiteSeguro(limite);
  const cursor = String(antes || '').trim();
  if (!cursor && tamanho === LIMITE_PADRAO) return recentesCache.cached();

  let consulta = COLLECTION.orderBy('ordem', 'desc').limit(tamanho);
  if (cursor) {
    // Intervalo e ordenação são pelo mesmo campo: não exige índice composto.
    consulta = COLLECTION.where('ordem', '<', cursor).orderBy('ordem', 'desc').limit(tamanho);
  }
  const snap = await consulta.get();
  return snap.docs.map((doc) => entradaPublica(doc.data()));
}

async function registrar({ usuario, metodo, computador = null, nomeUnidade = null } = {}) {
  if (!usuario?.id || !['senha', 'biometria'].includes(metodo)) return null;
  const ref = COLLECTION.doc();
  const em = new Date().toISOString();
  const registro = {
    id: ref.id,
    // A combinação de data ISO e id torna a paginação estável mesmo se duas
    // pessoas entrarem no mesmo milissegundo.
    ordem: `${em}_${ref.id}`,
    em,
    usuarioId: String(usuario.id),
    usuario: String(usuario.username || usuario.nome || usuario.email || 'Usuário').slice(0, 160),
    metodo,
    unidade: computador?.codigo ? String(nomeUnidade || computador.codigo).slice(0, 160) : null,
    unidadeCodigo: computador?.codigo ? String(computador.codigo).slice(0, 100) : null,
    maquina: computador?.posto ? String(computador.posto).slice(0, 160) : null,
  };
  await ref.set(registro);
  recentesCache.invalidar();
  return entradaPublica(registro);
}

module.exports = { listar, registrar, LIMITE_PADRAO, LIMITE_MAXIMO };

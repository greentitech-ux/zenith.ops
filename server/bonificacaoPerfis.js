// bonificacaoPerfis.js
// Perfil de bonificação = um conjunto salvo de percentuais + métricas com
// peso, aplicado a uma LISTA EXPLÍCITA de unidades. Existe separado do
// "grupo" (rede/franquia, ver grupos.js) porque a granularidade é outra:
// uma mesma rede (GBE) já mistura marcas diferentes (Domino's, Spoleto),
// e o Master pediu pra configurar por marca - e até abrir exceção pra uma
// unidade específica dentro da marca (regra geral "Domino's" + uma
// exceção "Domino's Caruaru"). Nome do perfil é livre de propósito: quem
// cadastra decide o que faz sentido pra operação, o sistema não tenta
// adivinhar "marca" a partir do código da unidade.
'use strict';

const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('bonificacaoPerfis');

// mesmo teto de segurança de campos extras em grupos.js - nao tem cenario
// real com mais que isso, e protege de payload gigante por engano
const MAX_UNIDADES = 200;
const MAX_METRICAS = 20;

function sanitizarPercentual(v, padrao) {
  const n = Number(v);
  if (!Number.isFinite(n)) return padrao;
  return Math.max(0, Math.min(100, n));
}

// mesmo formato de sanitizarCamposExtras em grupos.js, mas so campo/label/
// peso - bonificacao nao tem tipo/soma-em/operacao, cada metrica so entra
// com um peso (%) que decide quanto ela pesa na taxa de cumprimento
function sanitizarMetricas(lista) {
  if (!Array.isArray(lista)) return [];
  const usados = new Set();
  return lista
    .map((m) => {
      const label = String(m?.label || '').trim().slice(0, 60);
      if (!label) return null;
      let campo = String(m?.campo || '').trim();
      if (!campo) campo = label.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '').toLowerCase() || 'metrica';
      let base = campo;
      let n = 2;
      while (usados.has(campo)) { campo = base + n; n += 1; }
      usados.add(campo);
      return { campo, label, peso: sanitizarPercentual(m?.peso, 0) };
    })
    .filter(Boolean)
    .slice(0, MAX_METRICAS);
}

function sanitizarUnidades(lista) {
  if (!Array.isArray(lista)) return [];
  return [...new Set(lista.map((u) => String(u || '').trim()).filter(Boolean))].slice(0, MAX_UNIDADES);
}

async function listUncached() {
  const snap = await COLLECTION.orderBy('nome', 'asc').get();
  return snap.docs.map((d) => d.data());
}
const perfisCache = createCache(listUncached, 5 * 60 * 1000);
const listar = perfisCache.cached;

async function obter(id) {
  const doc = await COLLECTION.doc(id).get();
  return doc.exists ? doc.data() : null;
}

// o perfil cuja lista de unidades contem o codigo - null se nenhum cobre
// (a apuracao trata null como "sem configuracao", nunca cai num default
// generico - ver bonificacao.js)
async function perfilDaUnidade(unidade) {
  if (!unidade) return null;
  const todos = await listar();
  return todos.find((p) => (p.unidades || []).includes(unidade)) || null;
}

// tira a unidade de qualquer OUTRO perfil que a tivesse - e o que garante
// o invariante "uma unidade so pertence a um perfil por vez", mesma ideia
// de grupoDaUnidade em grupos.js (uma unidade so pertence a uma rede).
// Roda ANTES de gravar o perfil novo/editado, nunca depois - senao uma
// falha no meio do caminho deixaria a unidade em dois perfis ao mesmo tempo.
async function liberarUnidadesDeOutrosPerfis(unidades, idIgnorado) {
  if (!unidades.length) return;
  const todos = await listar();
  const alvo = new Set(unidades);
  const afetados = todos.filter((p) => p.id !== idIgnorado && (p.unidades || []).some((u) => alvo.has(u)));
  for (const p of afetados) {
    const restantes = (p.unidades || []).filter((u) => !alvo.has(u));
    await COLLECTION.doc(p.id).update({ unidades: restantes, atualizadoEm: new Date().toISOString() });
  }
}

async function criar({ nome, unidades, ativa, percentualPool, splitMetasOutras, splitGerente, splitGerenteOutras, metricasGerente, metricasColaboradores, criadoPorEmail }) {
  const nomeLimpo = String(nome || '').trim().slice(0, 60);
  if (!nomeLimpo) throw new Error('Informe o nome do perfil.');
  const unidadesOk = sanitizarUnidades(unidades);
  await liberarUnidadesDeOutrosPerfis(unidadesOk, null);

  const ref = COLLECTION.doc();
  const agora = new Date().toISOString();
  const registro = {
    id: ref.id,
    nome: nomeLimpo,
    unidades: unidadesOk,
    ativa: ativa !== false,
    percentualPool: sanitizarPercentual(percentualPool, 1),
    splitMetasOutras: sanitizarPercentual(splitMetasOutras, 70),
    splitGerente: sanitizarPercentual(splitGerente, 60),
    splitGerenteOutras: sanitizarPercentual(splitGerenteOutras, 25),
    metricasGerente: sanitizarMetricas(metricasGerente),
    metricasColaboradores: sanitizarMetricas(metricasColaboradores),
    criadoPorEmail: criadoPorEmail || null,
    criadoEm: agora,
    atualizadoPorEmail: criadoPorEmail || null,
    atualizadoEm: agora,
  };
  await ref.set(registro);
  perfisCache.invalidar();
  return registro;
}

async function atualizar(id, { nome, unidades, ativa, percentualPool, splitMetasOutras, splitGerente, splitGerenteOutras, metricasGerente, metricasColaboradores, atualizadoPorEmail }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Perfil não encontrado.');

  const patch = { atualizadoEm: new Date().toISOString(), atualizadoPorEmail: atualizadoPorEmail || null };
  if (nome != null) {
    const nomeLimpo = String(nome).trim().slice(0, 60);
    if (!nomeLimpo) throw new Error('Informe o nome do perfil.');
    patch.nome = nomeLimpo;
  }
  if (unidades != null) {
    const unidadesOk = sanitizarUnidades(unidades);
    await liberarUnidadesDeOutrosPerfis(unidadesOk, id);
    patch.unidades = unidadesOk;
  }
  if (ativa != null) patch.ativa = !!ativa;
  if (percentualPool != null) patch.percentualPool = sanitizarPercentual(percentualPool, 1);
  if (splitMetasOutras != null) patch.splitMetasOutras = sanitizarPercentual(splitMetasOutras, 70);
  if (splitGerente != null) patch.splitGerente = sanitizarPercentual(splitGerente, 60);
  if (splitGerenteOutras != null) patch.splitGerenteOutras = sanitizarPercentual(splitGerenteOutras, 25);
  if (metricasGerente != null) patch.metricasGerente = sanitizarMetricas(metricasGerente);
  if (metricasColaboradores != null) patch.metricasColaboradores = sanitizarMetricas(metricasColaboradores);

  await ref.update(patch);
  perfisCache.invalidar();
  return obter(id);
}

async function remover(id) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Perfil não encontrado.');
  await ref.delete();
  perfisCache.invalidar();
}

module.exports = { listar, obter, criar, atualizar, remover, perfilDaUnidade };

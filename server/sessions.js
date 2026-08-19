// sessions.js
// Uma sessao por token de login emitido - existe pra responder "quantos
// locais estao logados com esse usuario, e desde quando cada um esta ativo"
// (usuarios.html) e pra permitir o Master encerrar um acesso especifico sem
// precisar trocar a senha (o que derrubaria TODOS os locais de uma vez).
// Colecao pequena por natureza: cada sessao expira sozinha (mesma janela de
// 8h do token JWT, ver auth.js) e a limpeza acontece de gracinha no proximo
// login do mesmo usuario - nao precisa de job/cron separado.
const crypto = require('crypto');
const db = require('./firestore');
const { createCache, createKeyedCache } = require('./liveCache');

const COLLECTION = db.collection('sessions');
const DURACAO_MS = 8 * 60 * 60 * 1000; // mesma janela do JWT (auth.js: expiresIn '8h')
const ONLINE_JANELA_MS = 5 * 60 * 1000; // atividade a menos de 5min = "online agora"
const TOQUE_MIN_INTERVALO_MS = 60 * 1000; // nao regrava ultimaAtividadeEm a cada request

// duracaoMs opcional: usado pelos acessos com "sessaoLonga" (ver auth.js/
// users.js) - conta compartilhada de loja/terminal que nao pode ficar
// pedindo login de novo no meio do turno. Sem isso, cai no padrao de 8h.
async function criar({ userId, userAgent, ip, duracaoMs }) {
  const agora = Date.now();
  const duracao = Number(duracaoMs) > 0 ? Number(duracaoMs) : DURACAO_MS;

  // aproveita a escrita nova pra limpar as sessoes ja vencidas desse mesmo
  // usuario - assim a colecao nunca cresce sem limite
  const antigas = await COLLECTION.where('userId', '==', userId).get();
  const vencidas = antigas.docs.filter((d) => (d.data().expiraEm || 0) < agora);
  await Promise.all(vencidas.map((d) => d.ref.delete()));
  vencidas.forEach((d) => esquecerSessao(d.id));

  const doc = COLLECTION.doc(crypto.randomUUID());
  const registro = {
    id: doc.id,
    userId,
    userAgent: String(userAgent || '').slice(0, 300),
    ip: String(ip || '').slice(0, 100),
    criadoEm: new Date(agora).toISOString(),
    ultimaAtividadeEm: new Date(agora).toISOString(),
    expiraEm: agora + duracao,
  };
  await doc.set(registro);
  sessionsCache.invalidar();
  return registro;
}

// throttle em memoria (nao no Firestore) pra nao regravar a cada uma das
// ~90 rotas autenticadas que cada tela dispara - so escreve de novo depois
// de passado TOQUE_MIN_INTERVALO_MS desde a ultima escrita real
const ultimoToqueEmMemoria = new Map(); // sessionId -> epoch ms
function tocar(sessionId) {
  if (!sessionId) return;
  const agora = Date.now();
  const ultimo = ultimoToqueEmMemoria.get(sessionId) || 0;
  if (agora - ultimo < TOQUE_MIN_INTERVALO_MS) return;
  ultimoToqueEmMemoria.set(sessionId, agora);
  COLLECTION.doc(sessionId)
    .update({ ultimaAtividadeEm: new Date(agora).toISOString() })
    .catch(() => {}); // sessao pode ter sido encerrada/expirada entre o check e a escrita - ignora
  // DE PROPOSITO nao invalida cache nenhum aqui - era isso que fazia o custo
  // de leitura explodir (ver sessaoCache abaixo). O unico campo que esta
  // escrita muda e ultimaAtividadeEm, que:
  //   - o caminho quente (existeEValida) nao le - ele so olha expiraEm, e
  //     esse tocar() nunca mexe nele;
  //   - as telas de admin leem so pra dizer "online agora", com janela de
  //     5min (ONLINE_JANELA_MS) - o TTL de 10s do sessionsCache ja da uma
  //     precisao muito acima do necessario pra esse indicador.
}

// leitura da colecao INTEIRA - usada so pelas telas de administracao
// (listarDoUsuario/resumoPorUsuario, ambas em usuarios.html). NUNCA use isso
// no caminho de autenticacao: ver sessaoCache logo abaixo.
async function listAllUncached() {
  const snap = await COLLECTION.get();
  return snap.docs.map((d) => d.data());
}
const sessionsCache = createCache(listAllUncached, 10 * 1000);

// cache POR SESSAO do caminho quente (existeEValida, chamado pelo requireAuth
// em TODA requisicao autenticada - ~90 rotas). Antes isso lia a colecao
// inteira por um cache unico compartilhado por todo mundo, e o resultado era
// duplamente ruim:
//   1) cada miss custava N leituras (1 por sessao ativa) pra responder uma
//      pergunta sobre UMA sessao - o documento e buscado direto pelo id, nao
//      precisa varrer a colecao;
//   2) esse cache unico era invalidado pelo tocar() de QUALQUER usuario (1x
//      por minuto por sessao ativa). Com dezenas de acessos simultaneos, as
//      invalidacoes se sobrepunham e o TTL de 10s praticamente nunca era
//      aproveitado - na pratica quase toda requisicao autenticada de todo
//      mundo pagava uma releitura completa da colecao.
// Agora e 1 leitura de 1 documento por sessao a cada TTL, e a atividade de
// uma sessao nao derruba mais o cache das outras. Mesmo TTL/estrategia do
// usuarioCache (auth.js), que ja gateia exatamente as mesmas requisicoes -
// e igual la, o TTL e so um piso: encerrar()/encerrarTodas* invalidam na
// hora, entao o Master derrubando um acesso continua tendo efeito imediato.
const sessaoCache = createKeyedCache(async (sessionId) => {
  const doc = await COLLECTION.doc(sessionId).get();
  return doc.exists ? doc.data() : null;
}, 15 * 1000);

function estaOnline(sessao, agora = Date.now()) {
  return agora - new Date(sessao.ultimaAtividadeEm).getTime() < ONLINE_JANELA_MS;
}

// chamado pelo requireAuth em toda requisicao - true se o token ainda
// corresponde a uma sessao ativa (nao encerrada pelo Master, nem vencida)
async function existeEValida(sessionId) {
  if (!sessionId) return false;
  const sessao = await sessaoCache.cached(sessionId);
  return !!sessao && sessao.expiraEm > Date.now();
}

async function listarDoUsuario(userId) {
  const todas = await sessionsCache.cached();
  const agora = Date.now();
  return todas
    .filter((s) => s.userId === userId && s.expiraEm > agora)
    .map((s) => ({ ...s, online: estaOnline(s, agora) }))
    .sort((a, b) => b.ultimaAtividadeEm.localeCompare(a.ultimaAtividadeEm));
}

// resumo pra tabela de Usuarios (contagem de locais + online agora), sem
// precisar abrir o modal de sessoes pra cada linha
async function resumoPorUsuario() {
  const todas = await sessionsCache.cached();
  const agora = Date.now();
  const porUsuario = {};
  todas.forEach((s) => {
    if (s.expiraEm <= agora) return;
    const atual = porUsuario[s.userId] || { locais: 0, online: false, ultimaAtividadeEm: null };
    atual.locais += 1;
    atual.online = atual.online || estaOnline(s, agora);
    if (!atual.ultimaAtividadeEm || s.ultimaAtividadeEm > atual.ultimaAtividadeEm) atual.ultimaAtividadeEm = s.ultimaAtividadeEm;
    porUsuario[s.userId] = atual;
  });
  return porUsuario;
}

// Qualquer caminho que APAGUE uma sessao tem que invalidar as DUAS camadas
// de cache: a da colecao inteira (telas de admin) e a POR SESSAO (caminho de
// auth). Esquecer a segunda faria um acesso revogado continuar passando no
// requireAuth ate o TTL vencer - o oposto do que "encerrar sessao" promete.
function esquecerSessao(sessionId) {
  ultimoToqueEmMemoria.delete(sessionId);
  sessaoCache.invalidar(sessionId);
}

async function encerrar(sessionId) {
  await COLLECTION.doc(sessionId).delete();
  esquecerSessao(sessionId);
  sessionsCache.invalidar();
}

// chamado quando a senha e trocada/reset ou o acesso e desativado - sem isso
// um token emitido antes continuaria valido ate as 8h expirarem sozinhas
async function encerrarTodasDoUsuario(userId) {
  const snap = await COLLECTION.where('userId', '==', userId).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
  snap.docs.forEach((d) => esquecerSessao(d.id));
  sessionsCache.invalidar();
}

// mesma coisa, mas preserva a sessao atual - usado quando o proprio usuario
// troca a senha (nao faz sentido derrubar o dispositivo de onde ele acabou
// de trocar; so os OUTROS locais logados com a senha antiga)
async function encerrarTodasDoUsuarioExceto(userId, sessionIdExcluir) {
  const snap = await COLLECTION.where('userId', '==', userId).get();
  const apagadas = snap.docs.filter((d) => d.id !== sessionIdExcluir);
  await Promise.all(apagadas.map((d) => d.ref.delete()));
  apagadas.forEach((d) => esquecerSessao(d.id));
  sessionsCache.invalidar();
}

// Os dois estados em memoria deste modulo sao indexados por sessionId, e
// sessionId nunca se repete (crypto.randomUUID a cada login) - ou seja, os
// dois crescem pra sempre num processo de vida longa, guardando entradas de
// sessoes que ja expiraram ha muito tempo. Ninguem "vaza" de verdade porque
// o processo reinicia com frequencia (deploy no Render), mas contar com isso
// e frágil. Faxina periodica:
//   - ultimoToqueEmMemoria: descarta quem nao tem atividade ha mais que a
//     maior sessao possivel - passado isso o token ja expirou de qualquer
//     jeito, entao a entrada nunca mais vai ser consultada;
//   - sessaoCache: limpa por inteiro. Custa no maximo 1 releitura de 1
//     documento por sessao ATIVA (as inativas nem voltam pro cache), o que
//     e ordens de grandeza menor que o que esse cache economiza - e em
//     troca o mapa fica com um teto garantido.
// unref() pra esse timer nunca segurar o processo vivo no encerramento.
const FAXINA_INTERVALO_MS = 30 * 60 * 1000;
// teto de duracao de sessao, so pra dimensionar a faxina - espelha o
// DURACAO_SESSAO_LONGA_MS do auth.js (30d), que nao da pra importar aqui sem
// criar dependencia circular (auth.js ja depende deste modulo). Errar esse
// numero e inofensivo nos dois sentidos: pra menos, uma sessao ainda viva
// perde o registro de throttle e escreve ultimaAtividadeEm uma vez a mais;
// pra mais, a entrada morta so demora um pouco mais pra sair da memoria.
const MAIOR_SESSAO_MS = 30 * 24 * 60 * 60 * 1000;
function faxinaMemoria(agora = Date.now()) {
  const corte = agora - Math.max(DURACAO_MS, MAIOR_SESSAO_MS);
  for (const [sessionId, ultimo] of ultimoToqueEmMemoria) {
    if (ultimo < corte) ultimoToqueEmMemoria.delete(sessionId);
  }
  sessaoCache.invalidar();
}
setInterval(faxinaMemoria, FAXINA_INTERVALO_MS).unref();

module.exports = {
  criar, tocar, existeEValida, listarDoUsuario, resumoPorUsuario, encerrar, encerrarTodasDoUsuario, encerrarTodasDoUsuarioExceto,
  faxinaMemoria,
};

// preferencias.js
// Preferencias de TELA por usuario, gravadas no servidor (nao no navegador).
//
// POR QUE ISSO EXISTE: o seletor 🧩 Colunas do Fechamento guardava a ordem /
// visibilidade das colunas so em localStorage, ou seja, "salvo neste
// navegador". Quem monta a ordem no celular nao via ela no computador, e
// qualquer limpeza de cache do app/navegador (comum em webview de celular)
// zerava tudo. A regra pedida pelo Master e clara: uma vez confirmada, a
// ordem passa a ser A PADRAO - sobrevive a atualizar a pagina, a fechar o
// app, e vale tanto pra exibicao quanto pros relatorios.
//
// A preferencia e POR USUARIO (nao global): a escolha de layout de uma
// pessoa nao muda o relatorio que outra exporta.
//
// Guarda valor JSON generico por chave, pra proxima tela que precisar
// persistir preferencia nao ter que criar uma colecao nova. Cache em memoria
// com o mesmo padrao dos outros modulos (ver liveCache.js) pra nao adicionar
// uma leitura de Firestore a cada abertura de tela.
const db = require('./firestore');
const { createKeyedCache } = require('./liveCache');

const COLLECTION = db.collection('preferenciasUsuario');

// tamanho maximo do JSON gravado - a preferencia e uma lista de chaves de
// coluna, nao um lugar pra guardar dado de verdade
const LIMITE_BYTES = 64 * 1024;

async function lerUncached(userId) {
  const snap = await COLLECTION.doc(userId).get();
  return snap.exists ? snap.data() : {};
}
const prefCache = createKeyedCache(lerUncached, 60 * 1000);

// devolve o valor de UMA chave (ex: 'fechamentoColunas') ou null se a pessoa
// nunca salvou nada - o null e significativo pra tela: "sem preferencia
// no servidor, usa o que estiver no navegador" (ver fechamentos.html)
async function obter(userId, chave) {
  if (!userId || !chave) return null;
  const doc = await prefCache.cached(userId);
  const valor = (doc.valores || {})[chave];
  return valor === undefined ? null : valor;
}

async function salvar(userId, chave, valor) {
  if (!userId || !chave) return null;
  if (JSON.stringify(valor || null).length > LIMITE_BYTES) {
    throw new Error('Preferência grande demais.');
  }
  // merge por chave: salvar a preferencia de uma tela nao pode apagar a de
  // outra tela que o mesmo usuario ja tinha. A juncao e feita AQUI (le o doc
  // atual e reescreve o mapa inteiro) em vez de delegar pro merge do
  // Firestore - o merge dele so funde mapa aninhado, e depender disso
  // deixaria o comportamento sem como ser testado fora do Firestore real.
  const atual = await lerUncached(userId);
  await COLLECTION.doc(userId).set({
    id: userId,
    valores: { ...(atual.valores || {}), [chave]: valor },
    atualizadoEm: new Date().toISOString(),
  }, { merge: true });
  prefCache.invalidar(userId);
  return valor;
}

module.exports = { obter, salvar };

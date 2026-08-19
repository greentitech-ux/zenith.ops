// bravoMapa.js
// Decisoes do Master sobre CADA COLUNA da planilha do Grupo Bravo: criar campo
// novo no Zenith, unificar com um campo que ja existe (mesmo com nome
// diferente/parecido), ou ignorar.
//
// Existe porque a lista de colunas do importador era 100% fixa no codigo
// (MODELOS em bravoImport.js). Toda vez que uma aba era reorganizada e uma
// coluna mudava de nome, o valor dela virava zero em silencio - e a unica
// forma de corrigir era editar codigo e fazer deploy. Agora a decisao e dado,
// nao codigo: o Master aprova na tela e a proxima importacao ja usa.
//
// A analise que PROPOE as decisoes vive em bravoImport.analisarColunas(); aqui
// so fica o armazenamento do que ja foi decidido.
const db = require('./firestore');
const { createCache } = require('./liveCache');

const DOC = db.collection('bravoImportMapa').doc('principal');

// Destinos possiveis pra uma coluna nova. Sao os tres tipos de campo extra
// que o cadastro do grupo entende (ver grupos.js) - nao ha um quarto.
const DESTINOS = ['canal', 'forma', 'kpi'];
const ACOES = ['criar', 'unificar', 'ignorar'];

// A chave e o nome da coluna NORMALIZADO (sem acento/caixa/pontuacao). Assim
// uma decisao sobrevive a "TEF Credito" virar "TEF Crédito" ou "tef credito"
// numa reorganizacao futura da planilha - que e justamente o tipo de mudanca
// que vinha quebrando a importacao.
function chaveColuna(nome) {
  return String(nome || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ').trim().toLowerCase();
}

async function lerUncached() {
  const snap = await DOC.get();
  return snap.exists ? (snap.data() || {}) : {};
}
// muda so quando o Master decide algo - TTL folgado de proposito
const cache = createCache(lerUncached, 5 * 60 * 1000);

async function obter() {
  const dados = await cache.cached();
  return dados.colunas || {};
}

// Grava as decisoes MESCLANDO com o que ja existe: decidir 3 colunas hoje nao
// pode apagar as 40 decididas semana passada.
async function salvarDecisoes(decisoes, porEmail) {
  if (!Array.isArray(decisoes) || !decisoes.length) {
    throw new Error('Nenhuma decisão enviada.');
  }
  const atuais = await obter();
  const agora = new Date().toISOString();
  const novas = { ...atuais };

  for (const d of decisoes) {
    const coluna = String(d.coluna || '').trim();
    if (!coluna) throw new Error('Decisão sem o nome da coluna.');
    const acao = String(d.acao || '').trim();
    if (!ACOES.includes(acao)) throw new Error(`Ação inválida para "${coluna}": ${acao}`);

    const registro = { coluna, acao, decididoEm: agora, decididoPorEmail: porEmail || null };

    if (acao === 'unificar') {
      // campo e o identificador interno do campo JA existente no grupo - sem
      // ele a unificacao nao tem pra onde apontar e o valor se perderia
      const campo = String(d.campo || '').trim();
      if (!campo) throw new Error(`"${coluna}": unificar exige o campo de destino.`);
      registro.campo = campo;
      registro.label = String(d.label || '').trim() || coluna;
      registro.destino = DESTINOS.includes(d.destino) ? d.destino : null;
    } else if (acao === 'criar') {
      if (!DESTINOS.includes(d.destino)) {
        throw new Error(`"${coluna}": criar exige destino (canal, forma ou kpi).`);
      }
      registro.destino = d.destino;
      registro.label = String(d.label || '').trim() || coluna;
      // o campo (slug) e derivado do label na hora de cadastrar, ver
      // bravoImport.cadastrarCampos - nao vem do cliente
    }

    novas[chaveColuna(coluna)] = registro;
  }

  await DOC.set({ colunas: novas, atualizadoEm: agora }, { merge: true });
  cache.invalidar();
  return { salvas: decisoes.length, total: Object.keys(novas).length };
}

// desfaz UMA decisao (o Master mudou de ideia antes de gravar)
async function esquecer(coluna) {
  const atuais = await obter();
  const chave = chaveColuna(coluna);
  if (!(chave in atuais)) return { removida: false };
  const novas = { ...atuais };
  delete novas[chave];
  await DOC.set({ colunas: novas, atualizadoEm: new Date().toISOString() }, { merge: false });
  cache.invalidar();
  return { removida: true };
}

module.exports = { obter, salvarDecisoes, esquecer, chaveColuna, DESTINOS, ACOES, invalidarCache: cache.invalidar };

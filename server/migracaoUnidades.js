// migracaoUnidades.js
// Tabela de código ANTIGO -> código UNIFICADO das unidades, usada o tempo
// todo em runtime: normalizarCodigoUnidade() na ingestão (normalize.js,
// reportImport.js, entregasSync.js) faz todo dado NOVO já nascer com o
// código certo, e o fold de construirUnidadesMapa() (index.js) funde
// qualquer código antigo que ainda apareça solto na hora de exibir.
//
// O nome do arquivo é histórico: aqui também moravam os scripts que
// corrigiram de uma vez o que já estava gravado no Firestore. Rodaram em
// produção em 2026-08-18 e foram removidos depois - só os mapas abaixo
// seguem valendo, e esses são pra sempre (todo código antigo que reaparecer
// por qualquer caminho continua sendo dobrado no unificado).
//
// POR QUE ISSO EXISTE: a mesma loja física tinha DOIS códigos - um no espaço
// de Fechamento ("Dominos Bessa") e outro no de Entregas ("Bessa"), ver
// comentário de UNIDADES_APELIDOS em index.js -, o que fazia ela aparecer
// como 2 cadastros separados no painel de Unidades. Decisão do Master: o
// código de FECHAMENTO é o principal (é o dado mais importante do sistema);
// o de Entregas morre e tudo que usava ele passa a usar o de Fechamento.

const MAPA_CODIGO_ENTREGAS_PARA_FECHAMENTO = {
  Bessa: 'Dominos Bessa',
  Caruaru: 'Dominos Caruaru',
  Garanhuns: 'Dominos Garanhuns',
};

// segunda migração (mesma decisão do Master, mesmo dia): o espaço de
// Monitor/Disputas (merchantAccountCode que a Adyen manda em cada
// transação/webhook - formato fora do nosso controle) também duplicava
// cadastro com o de Fechamento pra loja que tem os dois. Mais arriscado que
// a migração de Entregas (dado financeiro/fraude, não só operacional) -
// cobre as 9 unidades ARCFOOD/GBE que hoje tem os dois códigos (inclui
// DOM19940/Dominos Tirol, achado numa revisão anterior - já usada em
// produção, ver fechamentos.html UNIDADES_IDPULSE, mas faltava no
// GBE_MONITOR/index.js), MAIS "Tirol Natal" -> "MMTirol Natal": mesmo caso,
// só que essa loja não tem código de Fechamento (só Entregas, ver comentário
// no topo do arquivo) - aqui o "principal" pro qual o código Monitor migra
// é o de Entregas mesmo, não Fechamento (nome do mapa continua
// "PARA_FECHAMENTO" pelas outras 9 entradas, mas o destino é sempre "o
// código que já tem o cadastro de verdade", não necessariamente Fechamento)
const MAPA_CODIGO_MONITOR_PARA_FECHAMENTO = {
  Mooca: '19888', DOM___19888: '19888',
  Tatuape: '19889', DOM_19889: '19889',
  'Sao Miguel': '19821', DOM__19821: '19821',
  Carrao: '19855', DOM__19855: '19855',
  DOM_19798: 'Dominos Caruaru',
  DOM19911: 'Dominos Garanhuns',
  DOM_19706: 'Dominos Bessa',
  DOM_19633: 'Dominos Campina Grande',
  DOM19940: 'Dominos Tirol',
  'Tirol Natal': 'MMTirol Natal',
};

// mapa combinado, pra normalizar QUALQUER codigo bruto que chegue na
// ingestao (webhook Adyen, planilha de Entregas) direto pro codigo
// unificado - usado por normalize.js/reportImport.js pra toda transacao
// NOVA já nascer com o código certo, sem depender de rodar a migração de
// novo a cada nova transação antiga reaparecendo
const MAPA_CODIGO_UNIFICADO = { ...MAPA_CODIGO_ENTREGAS_PARA_FECHAMENTO, ...MAPA_CODIGO_MONITOR_PARA_FECHAMENTO };
function normalizarCodigoUnidade(bruto) {
  return MAPA_CODIGO_UNIFICADO[bruto] || bruto;
}

// unidades que NAO EXISTEM - o Master mandou excluir em definitivo (nao é
// "loja fechada com histórico", é cadastro que não corresponde a loja
// nenhuma). Tirar da lista fixa NÃO basta: construirUnidadesMapa (index.js)
// também descobre código a partir do DADO - transação em cache da Adyen,
// linha da planilha de Entregas que ainda não foi limpa, fechamento antigo.
// Sem esta lista o código voltava sozinho na tela seguinte, agora sem nome
// bonito nenhum, como órfão em "Outras" - pior do que antes de excluir.
//
// Pra desfazer (se a loja passar a existir de verdade): tire o código
// daqui, recoloque em ENTREGAS_UNIDADES_NOMES/UNIDADES_APELIDOS no index.js
// e marque a unidade na empresa dona dela na tela de Grupos.
//
// 'MMTirol Natal' era o único código de Entregas que sobrou sem par no
// Fechamento depois da unificação de 2026-08-18; 'Tirol Natal' é como a
// Adyen mandava a mesma coisa (por isso os dois saem juntos - deixar só um
// faria o outro reaparecer sozinho pelo caminho do MAPA_CODIGO_UNIFICADO).
const CODIGOS_REMOVIDOS = new Set(['MMTirol Natal', 'Tirol Natal']);

function unidadeFoiRemovida(codigo) {
  return CODIGOS_REMOVIDOS.has(String(codigo == null ? '' : codigo).trim());
}

module.exports = {
  MAPA_CODIGO_ENTREGAS_PARA_FECHAMENTO, MAPA_CODIGO_MONITOR_PARA_FECHAMENTO, MAPA_CODIGO_UNIFICADO,
  normalizarCodigoUnidade, CODIGOS_REMOVIDOS, unidadeFoiRemovida,
};

// rhCamposConfig.js
// Quais campos do cadastro de Extra/Candidato são DIGITADOS NA MÃO em vez de
// virem da leitura do documento (ver documentoIdentidadeOcr.js).
//
// Mesmo desenho do "digitado na mão" dos Canais/Formas no fechamento (ver
// `manual` em grupos.js): quem marca é o Master, no cadastro; a loja só
// encontra o campo já liberado ou já travado. A diferença é o alcance - lá
// a marcação é por grupo de lojas, aqui é uma só pro RH inteiro, porque o
// que decide não é a bandeira e sim o documento: RG antigo não traz CPF,
// CNH velha não traz nome da mãe, e isso não muda de loja pra loja.
//
// Existe porque a alternativa era pior: sem isso, um documento que
// simplesmente NÃO tem o campo travava o cadastro pra sempre - a pessoa
// ficava sem entrar no sistema por um dado que não existe no papel dela.
const db = require('./firestore');
const { createCache } = require('./liveCache');

const DOC = db.collection('rhCamposConfig').doc('config');

// Só os campos que hoje vêm do documento fazem sentido aqui - contato,
// cargo e datas de admissão nunca foram lidos, sempre foram digitados.
const CAMPOS_DO_DOCUMENTO = ['nome', 'dataNascimento', 'cpf', 'rg', 'nomeMae'];
const LABEL = {
  nome: 'Nome completo',
  dataNascimento: 'Data de nascimento',
  cpf: 'CPF',
  rg: 'RG',
  nomeMae: 'Nome da mãe',
};

// Nasce com NENHUM campo manual: o pedido era que o documento mandasse.
// Liberar um campo é uma decisão consciente do Master, não um padrão.
const PADRAO = { camposManuais: [], atualizadoEm: null, atualizadoPorEmail: null };

async function lerUncached() {
  const snap = await DOC.get();
  if (!snap.exists) return { ...PADRAO };
  const dados = snap.data() || {};
  return {
    ...PADRAO,
    ...dados,
    camposManuais: sanitizar(dados.camposManuais),
  };
}
const cache = createCache(lerUncached, 5 * 60 * 1000);

function sanitizar(lista) {
  if (!Array.isArray(lista)) return [];
  // campo desconhecido é descartado em vez de gravado: se um dia um campo
  // sair da lista do documento, a config velha não volta a "liberar" um
  // campo que não existe mais
  return CAMPOS_DO_DOCUMENTO.filter((c) => lista.includes(c));
}

async function obter() {
  return cache.cached();
}

async function salvar(camposManuais, { porEmail } = {}) {
  const registro = {
    camposManuais: sanitizar(camposManuais),
    atualizadoEm: new Date().toISOString(),
    atualizadoPorEmail: porEmail || null,
  };
  await DOC.set(registro);
  cache.invalidar();
  return registro;
}

// o que a leitura do documento deve preencher: tudo menos o que o Master
// liberou pra digitação. Campo manual sai da lista mandada pro modelo pelo
// mesmo motivo do fechamento - listar um campo que sabidamente não está no
// documento é só dar ao modelo a chance de casar qualquer coisa com ele.
async function camposLidosDoDocumento() {
  const { camposManuais } = await obter();
  return CAMPOS_DO_DOCUMENTO.filter((c) => !camposManuais.includes(c));
}

module.exports = { obter, salvar, camposLidosDoDocumento, CAMPOS_DO_DOCUMENTO, LABEL };

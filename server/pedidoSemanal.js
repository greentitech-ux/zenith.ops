// pedidoSemanal.js
// Lembrete do PEDIDO SEMANAL de insumos que cada loja precisa fazer.
//
// O problema que isso resolve: o pedido semanal e uma tarefa que nao tem tela
// nenhuma no Zenith - e feito fora, no sistema do fornecedor. Quem esquece so
// descobre na semana seguinte, quando falta produto. Nao da pra "puxar" essa
// informacao de lugar nenhum, entao o desenho e o inverso: o sistema cobra, e
// a loja responde ANEXANDO o pedido. O anexo e o que transforma um lembrete
// (que qualquer um clica pra sumir) em prova de que o pedido existiu.
//
// Tres decisoes que valem explicar:
//
// 1) SEMANAL POR DIA DA SEMANA, nao por data. O Master escolhe "toda terca" e
//    o sistema vai apontando pra proxima data sozinho. Data avulsa obrigaria
//    alguem a recadastrar toda semana - e a semana que ninguem recadastrasse
//    seria justamente a que o lembrete nao apareceria.
//
// 2) A SEMANA E IDENTIFICADA PELA DATA DO PEDIDO (o proximo dia-da-semana
//    escolhido, hoje incluso). E isso que serve de chave da confirmacao:
//    confirmar duas vezes na mesma semana e o mesmo documento, e a semana que
//    vem nasce pendente sozinha, sem nenhum job pra "virar" nada.
//
// 3) NEM TODA UNIDADE FAZ ESSE PEDIDO. Sao Braz, Saltiverso e Milky Moo tem
//    fornecimento proprio; a Administrativa nem loja e. Ficam de fora por
//    padrao, e a lista e editavel - loja nova que nao faz pedido nao precisa
//    de deploy pra sair da cobranca.
const db = require('./firestore');
const { createCache } = require('./liveCache');

const CONFIG = db.collection('pedidoSemanalConfig').doc('config');
const CONFIRMACOES = db.collection('pedidoSemanalConfirmacoes');

const FUSO_BR = 'America/Sao_Paulo';
const DIAS_NOME = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];

// Unidades que NAO fazem o pedido semanal (decisao do Master, 2026-08-17).
// Sao codigos, nao nomes - o codigo e o que fica gravado em tudo (ver
// unidades.js). So o PADRAO: a lista real vive na config e e editavel.
const EXCLUIDAS_PADRAO = [
  'São Braz IL',       // fornecimento proprio
  'Saltiverso Patteo', // parque, nao e loja de comida
  'Milky Moo Tirol',   // rede propria, pedido por fora
  'Administrativa',    // escritorio - nao opera loja
];

const PADRAO = {
  ativo: false,
  diaSemana: 2,             // 0=domingo ... 2=terca
  diasAntecedencia: 2,      // de quantos dias antes o lembrete aparece
  titulo: 'Pedido semanal',
  instrucoes: '',
  unidadesExcluidas: EXCLUIDAS_PADRAO,
  // desde quando a cobranca vale. Impede que ligar o lembrete hoje acuse
  // como "atrasadas" semanas em que ele nem existia.
  vigenteDesde: null,
  atualizadoEm: null,
  atualizadoPorEmail: null,
};

// ---------------------------------------------------------------
// datas (tudo em horario de Brasilia, sem depender do fuso do servidor)
// ---------------------------------------------------------------
// 'sv-SE' devolve exatamente AAAA-MM-DD - mesmo truque ja usado no
// abastecimentoPrevisao.js pra nao carregar uma lib de data
const hojeBrasiliaISO = () => new Date().toLocaleDateString('sv-SE', { timeZone: FUSO_BR });

// meio-dia UTC: qualquer conta de dia feita a partir daqui atravessa
// mudanca de horario sem cair no dia anterior/seguinte
const comoData = (iso) => new Date(`${iso}T12:00:00Z`);
const paraISO = (d) => d.toISOString().slice(0, 10);
function somarDias(iso, n) {
  const d = comoData(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return paraISO(d);
}
const diffDias = (de, ate) => Math.round((comoData(ate) - comoData(de)) / 86400000);

// A data do pedido DESTA semana: a proxima ocorrencia do dia escolhido,
// contando hoje. No proprio dia do pedido a resposta e hoje - e o que faz o
// lembrete ficar "vence hoje" em vez de pular pra semana que vem de manha.
function proximaData(diaSemana, hojeISO = hojeBrasiliaISO()) {
  const alvo = Number(diaSemana);
  const hoje = comoData(hojeISO);
  const falta = (((alvo - hoje.getUTCDay()) % 7) + 7) % 7;
  return somarDias(hojeISO, falta);
}

// ---------------------------------------------------------------
// config (documento unico)
// ---------------------------------------------------------------
function sanitizarConfig(dados = {}, anterior = PADRAO) {
  const dia = Number(dados.diaSemana);
  const antec = Number(dados.diasAntecedencia);
  const ativo = !!dados.ativo;
  return {
    ativo,
    diaSemana: Number.isInteger(dia) && dia >= 0 && dia <= 6 ? dia : anterior.diaSemana,
    // teto de 6: com 7 o lembrete nunca sairia da tela, e aviso que fica
    // sempre aceso e aviso que ninguem le
    diasAntecedencia: Number.isInteger(antec) && antec >= 0 && antec <= 6 ? antec : anterior.diasAntecedencia,
    titulo: String(dados.titulo == null ? anterior.titulo : dados.titulo).trim().slice(0, 60) || PADRAO.titulo,
    instrucoes: String(dados.instrucoes == null ? anterior.instrucoes : dados.instrucoes).trim().slice(0, 600),
    unidadesExcluidas: Array.isArray(dados.unidadesExcluidas)
      ? [...new Set(dados.unidadesExcluidas.map((c) => String(c || '').trim()).filter(Boolean))].slice(0, 200)
      : anterior.unidadesExcluidas,
    // so carimba na virada desligado -> ligado. Reativar depois de uma pausa
    // recomeça a contagem: cobrar retroativo uma semana em que o lembrete
    // estava desligado seria cobrar por algo que ninguem viu.
    vigenteDesde: ativo ? (anterior.ativo && anterior.vigenteDesde ? anterior.vigenteDesde : hojeBrasiliaISO()) : null,
  };
}

async function lerConfigUncached() {
  const snap = await CONFIG.get();
  if (!snap.exists) return { ...PADRAO };
  return { ...PADRAO, ...(snap.data() || {}) };
}
const cacheConfig = createCache(lerConfigUncached, 5 * 60 * 1000);

async function obterConfig() {
  return cacheConfig.cached();
}

async function salvarConfig(dados, { porEmail } = {}) {
  const anterior = await obterConfig();
  const registro = {
    ...sanitizarConfig(dados, anterior),
    atualizadoEm: new Date().toISOString(),
    atualizadoPorEmail: porEmail || null,
  };
  await CONFIG.set(registro);
  cacheConfig.invalidar();
  return registro;
}

// ---------------------------------------------------------------
// confirmacoes (1 doc por unidade x semana)
// ---------------------------------------------------------------
// id determinista: confirmar de novo sobrescreve em vez de criar duplicata,
// e a busca da semana e um find em memoria, sem query no Firestore
const idDe = (unidade, dataPedido) => `${String(unidade).replace(/\//g, '_')}__${dataPedido}`;

async function listarUncached() {
  const snap = await CONFIRMACOES.get();
  return snap.docs.map((d) => d.data());
}
const cacheConfirmacoes = createCache(listarUncached, 5 * 60 * 1000);
const listarConfirmacoes = cacheConfirmacoes.cached;

// arquivo e OBRIGATORIO: sem ele isso vira um botao de "ok, li" - que a
// pessoa clica pro aviso sumir mesmo sem ter feito o pedido
async function confirmar({ unidade, unidadeNome, dataPedido, arquivo, porEmail, porNome }) {
  if (!unidade) throw new Error('Unidade não informada.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dataPedido || ''))) throw new Error('Semana do pedido inválida.');
  if (!arquivo || !arquivo.path) throw new Error('Anexe o arquivo do pedido pra confirmar.');
  const id = idDe(unidade, dataPedido);
  const registro = {
    id,
    unidade,
    unidadeNome: unidadeNome || unidade,
    dataPedido,
    confirmadoEm: new Date().toISOString(),
    porEmail: porEmail || null,
    porNome: porNome || null,
    arquivo: {
      path: arquivo.path,
      nome: String(arquivo.nome || 'pedido').slice(0, 160),
      tipo: arquivo.tipo || null,
      tamanho: Number(arquivo.tamanho) || null,
    },
  };
  await CONFIRMACOES.doc(id).set(registro);
  cacheConfirmacoes.invalidar();
  return registro;
}

async function buscarConfirmacao(unidade, dataPedido) {
  const lista = await listarConfirmacoes();
  return lista.find((c) => c.unidade === unidade && c.dataPedido === dataPedido) || null;
}

// ---------------------------------------------------------------
// status por unidade - conta PURA (testavel sem Firestore)
// ---------------------------------------------------------------
// base: [{codigo, nome}] - todas as unidades candidatas (quem monta e o
// index.js, que e onde vivem as listas fixas de unidade).
//
// Estados possiveis pra semana ATUAL:
//   feito    - ja confirmou (com anexo) o pedido desta semana
//   hoje     - vence hoje e nao confirmou
//   proximo  - vence em N dias, dentro da antecedencia configurada
//   fora     - ainda longe demais pra encher a tela
// `atraso` e separado do estado: e a semana ANTERIOR que fechou sem
// confirmacao. Vem junto porque uma loja pode estar em dia com a semana que
// vem e devendo a passada - sao duas informacoes, nao uma.
function statusDasUnidades(base, { config, confirmacoes = [], hoje = hojeBrasiliaISO() } = {}) {
  const cfg = { ...PADRAO, ...(config || {}) };
  if (!cfg.ativo) return [];
  const excluidas = new Set(cfg.unidadesExcluidas || []);
  const dataPedido = proximaData(cfg.diaSemana, hoje);
  const dataAnterior = somarDias(dataPedido, -7);
  const diasRestantes = diffDias(hoje, dataPedido);
  const janelaAberta = diasRestantes <= cfg.diasAntecedencia;
  // so cobra a semana passada se o lembrete ja estava ligado nela - senao
  // ligar hoje acusaria todo mundo de um atraso que nunca existiu
  const cobraAnterior = !!cfg.vigenteDesde && dataAnterior >= cfg.vigenteDesde;

  return (base || [])
    .filter((u) => u && u.codigo && !excluidas.has(u.codigo))
    .map((u) => {
      const daSemana = confirmacoes.find((c) => c.unidade === u.codigo && c.dataPedido === dataPedido) || null;
      const daAnterior = confirmacoes.find((c) => c.unidade === u.codigo && c.dataPedido === dataAnterior) || null;
      const atraso = cobraAnterior && !daAnterior ? dataAnterior : null;
      const estado = daSemana ? 'feito' : (diasRestantes === 0 ? 'hoje' : (janelaAberta ? 'proximo' : 'fora'));
      return {
        codigo: u.codigo,
        nome: u.nome || u.codigo,
        dataPedido,
        diasRestantes,
        estado,
        atraso,
        // a loja so precisa ver quando ha o que fazer (ou o que consertar);
        // "feito" aparece dentro da janela pra dar o retorno de que entrou
        visivel: janelaAberta || !!atraso,
        confirmacao: daSemana ? {
          confirmadoEm: daSemana.confirmadoEm,
          porNome: daSemana.porNome || daSemana.porEmail || null,
          arquivoNome: daSemana.arquivo ? daSemana.arquivo.nome : null,
        } : null,
      };
    });
}

module.exports = {
  DIAS_NOME, EXCLUIDAS_PADRAO, PADRAO,
  obterConfig, salvarConfig,
  listarConfirmacoes, confirmar, buscarConfirmacao,
  statusDasUnidades, proximaData, hojeBrasiliaISO, somarDias,
  invalidar: () => { cacheConfig.invalidar(); cacheConfirmacoes.invalidar(); },
};

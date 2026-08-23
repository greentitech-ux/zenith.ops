// pedidoSemanal.js
// Lembrete do PEDIDO SEMANAL de insumos que cada loja precisa fazer.
//
// O problema que isso resolve: o pedido semanal e uma tarefa que nao tem tela
// nenhuma no NoPulso - e feito fora, no sistema do fornecedor. Quem esquece so
// descobre na semana seguinte, quando falta produto. Nao da pra "puxar" essa
// informacao de lugar nenhum, entao o desenho e o inverso: o sistema cobra, e
// a loja responde ANEXANDO o pedido. O anexo e o que transforma um lembrete
// (que qualquer um clica pra sumir) em prova de que o pedido existiu.
//
// POR REGRA, nao por configuracao unica. Cada REGRA diz: estas lojas (ou este
// grupo/franquia) fazem pedido em tal dia da semana. Isso existe porque
// fornecedor e dia de pedido mudam por rede: as Domino's podem pedir na
// terca e a Spoleto na quinta, e uma loja nova entra na regra do grupo dela
// sem ninguem lembrar de mexer em lista nenhuma.
//
// Duas decisoes que valem explicar:
//
// 1) SEMANAL POR DIA DA SEMANA, nao por data. A regra diz "toda terca" e o
//    sistema aponta pra proxima data sozinho. Data avulsa obrigaria alguem a
//    recadastrar toda semana - e a semana que ninguem recadastrasse seria
//    justamente a que o lembrete nao apareceria.
//
// 2) A SEMANA E IDENTIFICADA PELA DATA DO PEDIDO (o proximo dia-da-semana da
//    regra, hoje incluso). E isso que serve de chave da confirmacao:
//    confirmar duas vezes na mesma semana e o mesmo documento, e a semana que
//    vem nasce pendente sozinha, sem nenhum job pra "virar" nada.
//
// Loja que nao esta em regra nenhuma simplesmente nao e cobrada - e assim que
// Sao Braz, Saltiverso e Milky Moo (fornecimento proprio) ficam de fora, sem
// precisar de lista de excecao.
const db = require('./firestore');
const { createCache } = require('./liveCache');

const REGRAS = db.collection('pedidoSemanalRegras');
const CONFIRMACOES = db.collection('pedidoSemanalConfirmacoes');
// documento da versao anterior (config unica) - so pra migrar uma vez
const CONFIG_ANTIGA = db.collection('pedidoSemanalConfig').doc('config');

const FUSO_BR = 'America/Sao_Paulo';
const DIAS_NOME = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];

const PADRAO_REGRA = {
  nome: 'Pedido semanal',
  ativo: true,
  alvoTipo: 'unidades',     // 'grupo' (franquia inteira) | 'unidades' (lojas escolhidas)
  grupoId: null,
  unidades: [],
  diaSemana: 2,             // 0=domingo ... 2=terca
  diasAntecedencia: 2,      // de quantos dias antes o lembrete aparece
  titulo: 'Pedido semanal',
  instrucoes: '',
  // desde quando esta regra cobra. Impede que criar a regra hoje acuse como
  // "atrasadas" semanas em que ela nem existia.
  vigenteDesde: null,
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
// regras
// ---------------------------------------------------------------
function sanitizarRegra(dados = {}, anterior = PADRAO_REGRA) {
  const dia = Number(dados.diaSemana);
  const antec = Number(dados.diasAntecedencia);
  const ativo = dados.ativo === undefined ? anterior.ativo : !!dados.ativo;
  const alvoTipo = dados.alvoTipo === 'grupo' ? 'grupo' : 'unidades';
  const nome = String(dados.nome == null ? anterior.nome : dados.nome).trim().slice(0, 60);
  return {
    nome: nome || PADRAO_REGRA.nome,
    ativo,
    alvoTipo,
    // guarda os dois lados sempre: trocar de "grupo" pra "lojas" e voltar
    // nao deve fazer a selecao anterior evaporar no meio da edicao
    grupoId: alvoTipo === 'grupo' ? (String(dados.grupoId || '').trim() || null) : (dados.grupoId ? String(dados.grupoId) : anterior.grupoId),
    unidades: Array.isArray(dados.unidades)
      ? [...new Set(dados.unidades.map((c) => String(c || '').trim()).filter(Boolean))].slice(0, 200)
      : (anterior.unidades || []),
    diaSemana: Number.isInteger(dia) && dia >= 0 && dia <= 6 ? dia : anterior.diaSemana,
    // teto de 6: com 7 o lembrete nunca sairia da tela, e aviso que fica
    // sempre aceso e aviso que ninguem le
    diasAntecedencia: Number.isInteger(antec) && antec >= 0 && antec <= 6 ? antec : anterior.diasAntecedencia,
    titulo: String(dados.titulo == null ? anterior.titulo : dados.titulo).trim().slice(0, 60) || PADRAO_REGRA.titulo,
    instrucoes: String(dados.instrucoes == null ? anterior.instrucoes : dados.instrucoes).trim().slice(0, 600),
    // so carimba na virada desligada -> ligada. Reativar depois de uma pausa
    // recomeça a contagem: cobrar retroativo uma semana em que a regra estava
    // desligada seria cobrar por algo que ninguem viu.
    vigenteDesde: ativo ? (anterior.ativo && anterior.vigenteDesde ? anterior.vigenteDesde : hojeBrasiliaISO()) : null,
  };
}

async function listarUncached() {
  const snap = await REGRAS.orderBy('nome', 'asc').get();
  const regras = snap.docs.map((d) => ({ ...PADRAO_REGRA, ...d.data(), id: d.id }));
  if (regras.length) return regras;
  return migrarConfigAntiga();
}
const cacheRegras = createCache(listarUncached, 5 * 60 * 1000);
const listarRegras = cacheRegras.cached;

// A primeira versao deste modulo tinha UMA config global com lista de
// excecoes. Se ela existir e ainda nao houver regra nenhuma, vira uma regra
// unica cobrindo todas as unidades menos as excluidas - senao o Master
// perderia em silencio o que tinha acabado de configurar.
async function migrarConfigAntiga() {
  const snap = await CONFIG_ANTIGA.get().catch(() => null);
  if (!snap || !snap.exists) return [];
  const velha = snap.data() || {};
  if (!velha.ativo) return [];
  const ref = REGRAS.doc();
  const registro = {
    ...PADRAO_REGRA,
    id: ref.id,
    nome: 'Pedido semanal (migrado)',
    ativo: true,
    alvoTipo: 'unidades',
    // a config velha era "todas menos estas". Como regra, ela vira "estas
    // unidades" - mas quem sabe a lista completa e o index.js, entao guardo
    // as EXCLUIDAS aqui e resolvo na hora (ver resolverUnidades).
    unidadesExcluidasLegado: velha.unidadesExcluidas || [],
    diaSemana: velha.diaSemana != null ? velha.diaSemana : PADRAO_REGRA.diaSemana,
    diasAntecedencia: velha.diasAntecedencia != null ? velha.diasAntecedencia : PADRAO_REGRA.diasAntecedencia,
    titulo: velha.titulo || PADRAO_REGRA.titulo,
    instrucoes: velha.instrucoes || '',
    vigenteDesde: velha.vigenteDesde || null,
    criadoEm: new Date().toISOString(),
  };
  await ref.set(registro);
  await CONFIG_ANTIGA.delete().catch(() => {});
  return [registro];
}

async function criarRegra(dados, { porEmail } = {}) {
  const ref = REGRAS.doc();
  const registro = {
    ...sanitizarRegra(dados, { ...PADRAO_REGRA, ativo: false }),
    id: ref.id,
    criadoEm: new Date().toISOString(),
    atualizadoEm: new Date().toISOString(),
    atualizadoPorEmail: porEmail || null,
  };
  if (!registro.unidades.length && !registro.grupoId) {
    throw new Error('Escolha o grupo ou pelo menos uma loja pra essa regra.');
  }
  await ref.set(registro);
  cacheRegras.invalidar();
  return registro;
}

async function atualizarRegra(id, dados, { porEmail } = {}) {
  const ref = REGRAS.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Regra não encontrada.');
  const anterior = { ...PADRAO_REGRA, ...snap.data() };
  const registro = {
    ...anterior,
    ...sanitizarRegra(dados, anterior),
    id,
    atualizadoEm: new Date().toISOString(),
    atualizadoPorEmail: porEmail || null,
  };
  if (!registro.unidades.length && !registro.grupoId) {
    throw new Error('Escolha o grupo ou pelo menos uma loja pra essa regra.');
  }
  await ref.set(registro);
  cacheRegras.invalidar();
  return registro;
}

async function removerRegra(id) {
  const snap = await REGRAS.doc(id).get();
  if (!snap.exists) throw new Error('Regra não encontrada.');
  await REGRAS.doc(id).delete();
  cacheRegras.invalidar();
  return snap.data();
}

// ---------------------------------------------------------------
// confirmacoes (1 doc por unidade x semana)
// ---------------------------------------------------------------
// id determinista: confirmar de novo sobrescreve em vez de criar duplicata,
// e a busca da semana e um find em memoria, sem query no Firestore
const idDe = (unidade, dataPedido) => `${String(unidade).replace(/\//g, '_')}__${dataPedido}`;

async function listarConfirmacoesUncached() {
  const snap = await CONFIRMACOES.get();
  return snap.docs.map((d) => d.data());
}
const cacheConfirmacoes = createCache(listarConfirmacoesUncached, 5 * 60 * 1000);
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
// resolucao: qual regra cobra cada unidade
// ---------------------------------------------------------------
// grupos: [{id, unidades:[...]}] (vem de grupos.js). base: todas as unidades
// candidatas [{codigo, nome}], montada pelo index.js - e la que vivem as
// listas fixas de unidade.
//
// Uma unidade cai em UMA regra so. Regra por LOJA ganha de regra por GRUPO:
// a escolha a dedo e sempre mais especifica que a herdada da franquia, entao
// e ela que representa a excecao ("essa loja aqui pede na quinta").
function unidadesDaRegra(regra, base, grupos = []) {
  if (regra.alvoTipo === 'grupo') {
    const g = grupos.find((x) => x.id === regra.grupoId);
    return new Set(g ? (g.unidades || []) : []);
  }
  // regra migrada da config antiga: era "todas menos estas"
  if (Array.isArray(regra.unidadesExcluidasLegado)) {
    const fora = new Set(regra.unidadesExcluidasLegado);
    return new Set((base || []).map((u) => u.codigo).filter((c) => !fora.has(c)));
  }
  return new Set(regra.unidades || []);
}

function regraDeCadaUnidade(base, regras, grupos) {
  const ativas = (regras || []).filter((r) => r.ativo);
  const porLoja = ativas.filter((r) => r.alvoTipo !== 'grupo');
  const porGrupo = ativas.filter((r) => r.alvoTipo === 'grupo');
  const mapa = new Map();
  // grupo primeiro, loja por cima: assim a regra especifica sobrescreve
  [...porGrupo, ...porLoja].forEach((regra) => {
    unidadesDaRegra(regra, base, grupos).forEach((codigo) => mapa.set(codigo, regra));
  });
  return mapa;
}

// ---------------------------------------------------------------
// status por unidade - conta PURA (testavel sem Firestore)
// ---------------------------------------------------------------
// Estados possiveis pra semana ATUAL:
//   feito    - ja confirmou (com anexo) o pedido desta semana
//   hoje     - vence hoje e nao confirmou
//   proximo  - vence em N dias, dentro da antecedencia da regra
//   fora     - ainda longe demais pra encher a tela
// `atraso` e separado do estado: e a semana ANTERIOR que fechou sem
// confirmacao. Vem junto porque uma loja pode estar em dia com a semana que
// vem e devendo a passada - sao duas informacoes, nao uma.
function statusDasUnidades(base, { regras = [], grupos = [], confirmacoes = [], hoje = hojeBrasiliaISO() } = {}) {
  const porUnidade = regraDeCadaUnidade(base, regras, grupos);
  return (base || [])
    .filter((u) => u && u.codigo && porUnidade.has(u.codigo))
    .map((u) => {
      const regra = porUnidade.get(u.codigo);
      const dataPedido = proximaData(regra.diaSemana, hoje);
      const dataAnterior = somarDias(dataPedido, -7);
      const diasRestantes = diffDias(hoje, dataPedido);
      const janelaAberta = diasRestantes <= regra.diasAntecedencia;
      // so cobra a semana passada se a regra ja estava valendo nela - senao
      // criar a regra hoje acusaria todo mundo de um atraso que nunca existiu
      const cobraAnterior = !!regra.vigenteDesde && dataAnterior >= regra.vigenteDesde;

      const daSemana = confirmacoes.find((c) => c.unidade === u.codigo && c.dataPedido === dataPedido) || null;
      const daAnterior = confirmacoes.find((c) => c.unidade === u.codigo && c.dataPedido === dataAnterior) || null;
      const atraso = cobraAnterior && !daAnterior ? dataAnterior : null;
      const estado = daSemana ? 'feito' : (diasRestantes === 0 ? 'hoje' : (janelaAberta ? 'proximo' : 'fora'));
      return {
        codigo: u.codigo,
        nome: u.nome || u.codigo,
        regraId: regra.id || null,
        regraNome: regra.nome,
        titulo: regra.titulo,
        instrucoes: regra.instrucoes,
        diaSemana: regra.diaSemana,
        diaSemanaNome: DIAS_NOME[regra.diaSemana] || '',
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
  DIAS_NOME, PADRAO_REGRA,
  listarRegras, criarRegra, atualizarRegra, removerRegra,
  listarConfirmacoes, confirmar, buscarConfirmacao,
  statusDasUnidades, regraDeCadaUnidade, proximaData, hojeBrasiliaISO, somarDias,
  invalidar: () => { cacheRegras.invalidar(); cacheConfirmacoes.invalidar(); },
};

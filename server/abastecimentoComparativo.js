// abastecimentoComparativo.js
// PIZZA QUE A LOJA ENVIOU x PIZZA QUE O CARRINHO LANCOU NO FECHAMENTO DELE.
//
// SAO DUAS PONTAS DIFERENTES, e confundi-las ja custou uma versao errada
// deste comentario. Conferido no codigo, ponta por ponta:
//
//   ENVIADO  = soma dos registros ENVIO. `origem: 'LOJA'` em
//              abastecimentoCarrinho.js - quem registra e a LOJA (Dominos
//              Praca Aeroporto Recife), dizendo o que mandou.
//   LANCADO  = KPI Extra do Fechamento da unidade "Domino's Carrinho
//              Aeroporto Recife" - o fechamento do CARRINHO, lancado por
//              quem fecha o carrinho no fim do dia.
//
// O carrinho PEDE (PEDIDO), recebe e confere; ele nao manda nada. Regra do
// Master sobre de quem se cobra: "o sistema que faz o envio das pizzas e a
// LOJA, o carrinho so PEDE... sempre iremos cobrar da LOJA os envios
// corretos pois o carrinho e quem recebe".
//
// Isso decide como o relatorio FALA: o texto cobra o ENVIO, tendo o
// fechamento do carrinho como referencia, e nomeia as DUAS pontas na mesma
// frase ("a loja ENVIOU 8 a mais do que o carrinho lancou no fechamento").
// Dizer so "do que lancou" faria parecer que quem lancou tambem foi a loja
// - que e' exatamente o erro que este cabecalho ja teve.
//
// POR QUE ISSO VIROU MODULO: a conta ja existia solta dentro da rota de UM
// dia (/api/abastecimento/comparativo-fechamento). O Master pediu o mesmo
// numero por PERIODO, dia a dia, em PDF e CSV, com o nome de quem lancou.
// Duas copias da mesma regra de casamento de sabor divergiriam no primeiro
// ajuste - entao a regra passa a morar aqui, e a rota de um dia usa esta.
//
// O QUE NAO E' DIVERGENCIA, e por isso sai separado:
//   - dia SEM fechamento lancado: nao da pra comparar. Vira 'nao lancou',
//     nao "diferenca de -58". Tratar ausencia como divergencia inflaria o
//     numero de quem ainda nem tinha lancado.
//   - KPI do sabor nao configurado no Grupo: idem - 'sem KPI'. E' problema
//     de cadastro, nao de operacao, e a pessoa do lancamento nao tem culpa.
'use strict';

const FUSO_BR = 'America/Sao_Paulo';
const diaDe = (iso) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: FUSO_BR });
// mesmo formato do reportUtil.fmtDataBR: 'YYYY-MM-DD' -> 'DD/MM/YYYY'.
// Repetido aqui de proposito pra este modulo nao depender da camada de
// relatorio - ele e' quem decide a regra, nao quem desenha o PDF.
const fmtDataBR = (d) => String(d || '').split('-').reverse().join('/');

// ---------------------------------------------------------------
// casar o sabor com o KPI que o Master cadastrou na mao
// ---------------------------------------------------------------
// O rotulo do KPI e' digitado em grupos.html, entao um typo ("Calabress")
// nao pode fazer o comparativo simplesmente nao achar o campo e mostrar o
// dia inteiro como se nao tivesse KPI.
function normalizar(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

// bate se o sabor aparece como substring (rotulo mais descritivo, ex:
// "Pizza Calabresa Grande") OU se alguma palavra esta a no maximo 2 edicoes
// do nome do sabor (tolera erro de digitacao)
function bateComSabor(texto, sabor) {
  const norm = normalizar(texto);
  if (norm.includes(sabor)) return true;
  return norm.split(/[^a-z0-9]+/).some((palavra) => palavra.length >= 4 && levenshtein(palavra, sabor) <= 2);
}

function kpiDoSabor(kpisDef, sabor) {
  return (kpisDef || []).find((k) => bateComSabor(k.campo, sabor) || bateComSabor(k.label, sabor)) || null;
}

// ---------------------------------------------------------------
// um dia
// ---------------------------------------------------------------
// `enviadoPorDia` e' o mapa {dia: {sabor: qtd}} montado uma vez pro periodo
// inteiro - assim 30 dias nao viram 30 varreduras da lista de registros.
function comparativoDoDia({ sabores, enviado, fechamento, kpisDef }) {
  return sabores.map((sabor) => {
    const def = kpiDoSabor(kpisDef, sabor);
    const env = Number(enviado && enviado[sabor]) || 0;
    // sem fechamento OU sem KPI cadastrado: nao da pra comparar. null, e nao
    // zero - zero afirmaria que a loja lancou zero, o que e' outra coisa.
    const registrado = (fechamento && def)
      ? (Number(fechamento.kpisExtras && fechamento.kpisExtras[def.campo]) || 0)
      : null;
    return {
      sabor,
      enviado: env,
      registrado,
      diferenca: registrado != null ? registrado - env : null,
      kpiEncontrado: !!def,
    };
  });
}

// quem assinou o fechamento DO CARRINHO naquele dia (nao o da loja - ver o
// cabecalho). Dois nomes porque sao coisas diferentes: `gerente` e' o nome
// digitado no formulario (quem assina), e `criadoPorEmail` e' quem estava
// logado no app (quem apertou o botao). Numa cobranca os dois importam, e
// quase sempre sao a mesma pessoa.
function quemLancou(fechamento) {
  if (!fechamento) return { assinou: null, logado: null };
  return {
    assinou: String(fechamento.gerente || '').trim() || null,
    logado: fechamento.criadoPorEmail || null,
  };
}

// ---------------------------------------------------------------
// o periodo, dia a dia
// ---------------------------------------------------------------
// NAO soma os dias: o Master pediu "1 abaixo do outro e nao somado". Um mes
// somado esconde o dia em que faltaram 12 - que e' justamente o dia que
// precisa de conversa.
function comparativoPeriodo({ regs, fechamentos, kpisDef, sabores, inicio, fim }) {
  // envios agrupados por dia, numa passada so
  const enviadoPorDia = new Map();
  // ENVIO que a loja mandou sem pedido nenhum do carrinho. O vinculo e o
  // campo atendePedidoId (opcional no cadastro, ver abastecimentoCarrinho):
  // vazio quer dizer que ninguem pediu aquilo. E' a segunda metade do que o
  // Master cobra da loja - "enviou sem pedido ser feito pelo carrinho" - e
  // fica em contador PROPRIO, nao somado a diferenca: sao erros diferentes
  // e um nao explica o outro.
  const semPedidoPorDia = new Map();
  for (const r of regs || []) {
    if (r.tipo !== 'ENVIO') continue;
    const dia = diaDe(r.criadoEm);
    if (dia < inicio || dia > fim) continue;
    if (!enviadoPorDia.has(dia)) enviadoPorDia.set(dia, Object.fromEntries(sabores.map((s) => [s, 0])));
    const alvo = enviadoPorDia.get(dia);
    for (const s of sabores) alvo[s] += Number(r.pizzas && r.pizzas[s]) || 0;
    if (!r.atendePedidoId) semPedidoPorDia.set(dia, (semPedidoPorDia.get(dia) || 0) + 1);
  }
  const fechamentoPorDia = new Map();
  for (const f of fechamentos || []) {
    if (!f || !f.data || f.data < inicio || f.data > fim) continue;
    fechamentoPorDia.set(f.data, f);
  }

  // todo dia do periodo entra, mesmo sem movimento nenhum - "os 30 dias",
  // como ele pediu. Dia vazio aparece como vazio, e isso e' informacao.
  const dias = [];
  const cursor = new Date(`${inicio}T12:00:00`);
  const fimData = new Date(`${fim}T12:00:00`);
  while (cursor <= fimData) {
    const dia = cursor.toISOString().slice(0, 10);
    const fechamento = fechamentoPorDia.get(dia) || null;
    const enviado = enviadoPorDia.get(dia) || Object.fromEntries(sabores.map((s) => [s, 0]));
    const itens = comparativoDoDia({ sabores, enviado, fechamento, kpisDef });
    const comDivergencia = itens.filter((i) => i.diferenca != null && i.diferenca !== 0);
    const totalEnviado = itens.reduce((s, i) => s + i.enviado, 0);
    dias.push({
      dia,
      temFechamento: !!fechamento,
      quemLancou: quemLancou(fechamento),
      itens,
      totalEnviado,
      enviosSemPedido: semPedidoPorDia.get(dia) || 0,
      // soma dos MODULOS: +3 num sabor e -3 noutro nao e' "zero divergencia",
      // sao dois erros que se cancelam por acaso
      divergenciaAbsoluta: comDivergencia.reduce((s, i) => s + Math.abs(i.diferenca), 0),
      qtdSaboresDivergentes: comDivergencia.length,
      // dia sem envio E sem fechamento nao e' problema de ninguem - e' dia
      // sem operacao. Separado de "enviou e ninguem lancou".
      semMovimento: !fechamento && totalEnviado === 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  // ranking de quem lanca - e o que o Master vai usar pra cobrar
  const porPessoa = new Map();
  for (const d of dias) {
    if (!d.temFechamento) continue;
    const nome = d.quemLancou.assinou || d.quemLancou.logado || 'não identificado';
    if (!porPessoa.has(nome)) porPessoa.set(nome, { nome, lancamentos: 0, diasComDivergencia: 0, divergenciaAbsoluta: 0 });
    const p = porPessoa.get(nome);
    p.lancamentos += 1;
    if (d.qtdSaboresDivergentes) p.diasComDivergencia += 1;
    p.divergenciaAbsoluta += d.divergenciaAbsoluta;
  }
  const responsaveis = [...porPessoa.values()]
    .map((p) => ({
      ...p,
      // % dos lancamentos DELE que sairam com divergencia. Ao lado do numero
      // absoluto de proposito: quem lanca todo dia sempre aparece pior que
      // quem lancou tres vezes, e a apresentacao mentiria.
      taxaDivergencia: p.lancamentos ? Math.round((p.diasComDivergencia / p.lancamentos) * 1000) / 10 : null,
    }))
    .sort((a, b) => b.divergenciaAbsoluta - a.divergenciaAbsoluta
      || b.diasComDivergencia - a.diasComDivergencia
      || String(a.nome).localeCompare(String(b.nome), 'pt-BR'));

  const comMovimento = dias.filter((d) => !d.semMovimento);
  return {
    periodo: { inicio, fim, dias: dias.length },
    dias,
    responsaveis,
    indicadores: {
      diasNoPeriodo: dias.length,
      diasComMovimento: comMovimento.length,
      diasComFechamento: dias.filter((d) => d.temFechamento).length,
      // enviou pizza e ninguem lancou o fechamento: buraco de conferencia,
      // e nao divergencia - fica no proprio contador
      diasEnviouSemLancar: dias.filter((d) => !d.temFechamento && d.totalEnviado > 0).length,
      diasComDivergencia: dias.filter((d) => d.qtdSaboresDivergentes > 0).length,
      divergenciaAbsoluta: dias.reduce((s, d) => s + d.divergenciaAbsoluta, 0),
      enviosSemPedido: dias.reduce((s, d) => s + d.enviosSemPedido, 0),
    },
  };
}

// ---------------------------------------------------------------
// as linhas do relatorio
// ---------------------------------------------------------------
// Moram AQUI, e nao na rota, porque o texto da coluna Situacao E' a regra:
// ele decide quem o relatorio cobra. Com a frase numa rota e a regra noutro
// arquivo, a primeira mudanca de uma das duas deixaria o documento dizendo
// uma coisa e o modulo calculando outra - e o documento e o que vai pra
// reuniao. Aqui tambem da pra testar a frase sem subir rota nenhuma.
// uma linha por DIA x SABOR - e' o formato que pivota no Excel e que deixa
// o dia problematico visivel sem somar nada
function linhasComparativo(r, soDivergencias) {
  const rotulo = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const linhas = [];
  for (const d of r.dias) {
    if (soDivergencias && !d.qtdSaboresDivergentes) continue;
    const quem = d.quemLancou.assinou || d.quemLancou.logado || (d.temFechamento ? 'não identificado' : '—');
    for (const i of d.itens) {
      if (soDivergencias && (i.diferenca == null || i.diferenca === 0)) continue;
      // QUEM ENVIA E' A LOJA (ver abastecimentoComparativo.js): o carrinho
      // so pede e confere. Entao o texto cobra o ENVIO, com o fechamento
      // como referencia. Antes dizia "lancou A MAIS do que saiu", que poe o
      // lancamento no banco dos reus e deixa o envio parecendo de outra
      // ponta - e ele e' da loja tambem.
      let situacao;
      if (!d.temFechamento) situacao = d.totalEnviado > 0 ? 'A LOJA ENVIOU E O CARRINHO NÃO LANÇOU O FECHAMENTO' : 'sem movimento';
      else if (!i.kpiEncontrado) situacao = 'KPI do sabor não cadastrado no Grupo';
      else if (i.diferenca === 0) situacao = 'confere';
      else if (i.diferenca < 0) situacao = `a loja ENVIOU ${Math.abs(i.diferenca)} a MAIS do que o carrinho lançou no fechamento`;
      else situacao = `a loja ENVIOU ${i.diferenca} a MENOS do que o carrinho lançou no fechamento`;
      // "enviou sem o carrinho pedir" é o outro erro que ele cobra da loja.
      // Vai só na PRIMEIRA linha do dia: é do dia, não do sabor, e repetir
      // em cada sabor triplicaria o mesmo aviso.
      if (d.enviosSemPedido && i.sabor === d.itens[0].sabor) {
        situacao += ` · ⚠ ${d.enviosSemPedido} envio(s) sem pedido do carrinho`;
      }
      linhas.push({
        data: fmtDataBR(d.dia),
        sabor: rotulo(i.sabor),
        enviado: String(i.enviado),
        fechamento: i.registrado == null ? '—' : String(i.registrado),
        diferenca: i.diferenca == null ? '—' : (i.diferenca > 0 ? `+${i.diferenca}` : String(i.diferenca)),
        quem,
        // por dia, nao por sabor: repete nas 3 linhas do dia de proposito,
        // pra a planilha conseguir filtrar/pivotar por esse criterio
        sem_pedido: String(d.enviosSemPedido || 0),
        situacao,
      });
    }
  }
  return linhas;
}

module.exports = {
  comparativoPeriodo, comparativoDoDia, kpiDoSabor, bateComSabor, quemLancou, diaDe,
  linhasComparativo,
};

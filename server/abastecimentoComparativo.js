// abastecimentoComparativo.js
// PIZZA QUE SAIU DA LOJA x PIZZA QUE A LOJA LANCOU NO FECHAMENTO.
//
// O carrinho recebe pizza da loja (registro ENVIO). No fim do dia a loja
// lanca no Fechamento quantas pizzas foram pro carrinho (KPI Extra por
// sabor). Os dois numeros TEM que bater. Quando nao batem, ou o envio nao
// foi registrado, ou o lancamento saiu errado - e quem lanca e' quem
// responde por isso.
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

// quem responde pelo lancamento daquele dia. Dois nomes porque sao coisas
// diferentes: `gerente` e' o nome digitado no formulario (quem assina), e
// `criadoPorEmail` e' quem estava logado no app (quem apertou o botao).
// Numa cobranca os dois importam, e quase sempre sao a mesma pessoa.
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
  for (const r of regs || []) {
    if (r.tipo !== 'ENVIO') continue;
    const dia = diaDe(r.criadoEm);
    if (dia < inicio || dia > fim) continue;
    if (!enviadoPorDia.has(dia)) enviadoPorDia.set(dia, Object.fromEntries(sabores.map((s) => [s, 0])));
    const alvo = enviadoPorDia.get(dia);
    for (const s of sabores) alvo[s] += Number(r.pizzas && r.pizzas[s]) || 0;
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
    },
  };
}

module.exports = {
  comparativoPeriodo, comparativoDoDia, kpiDoSabor, bateComSabor, quemLancou, diaDe,
};

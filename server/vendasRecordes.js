// vendasRecordes.js
// Recordes de venda por loja (maior/menor dia, maior/menor semana) e quem
// bateu recorde recentemente - a base do painel de metas: o usuario quer
// puxar plano de meta pras unidades que acabaram de bater a maior venda do
// dia ou da semana, e pra isso precisa primeiro saber QUAL e o recorde de
// cada uma e SE o mais recente foi agora ha pouco.
//
// Modulo PURO de proposito (nao le Firestore nem Sheets, nao conhece
// req/res): recebe a lista ja combinada de fechamentos (fechamentosData +
// fechamentosLive + sangrias, do mesmo jeito que fechamentosFiltrados() em
// index.js monta pra tela de Fechamentos) e devolve o que o painel mostra.
// Toda a regra de semana/recorde/recente da pra testar sem Firestore nem
// planilha - ver teste-vendas-recordes.js.
'use strict';

const FUSO_BR = 'America/Sao_Paulo';
const hojeBrasiliaISO = () => new Date().toLocaleDateString('sv-SE', { timeZone: FUSO_BR });

// uma "semana" so conta pro recorde com os 7 dias lancados - loja que abriu
// ha 3 dias tem uma "semana" de 2 lancamentos que somada da um total baixo
// SO porque falta dado, nao porque vendeu pouco. Sem essa trava a menor
// venda semanal seria sempre a primeira semana de toda loja nova.
const DIAS_PARA_SEMANA_VALIDA = 7;

const soData = (iso) => (iso ? String(iso).slice(0, 10) : null);

function diasEntre(de, ate) {
  const a = soData(de); const b = soData(ate);
  if (!a || !b) return null;
  const partes = (s) => s.split('-').map(Number);
  const [ay, am, ad] = partes(a); const [by, bm, bd] = partes(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// segunda-feira da semana ISO de uma data (AAAA-MM-DD), tambem em ISO -
// chave de agrupamento da semana. getDay(): 0=domingo..6=sabado
function segundaDaSemana(dataISO) {
  const [y, m, d] = dataISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const diaSemana = dt.getUTCDay();
  const voltar = diaSemana === 0 ? 6 : diaSemana - 1;
  dt.setUTCDate(dt.getUTCDate() - voltar);
  return dt.toISOString().slice(0, 10);
}
function somarDiasISO(dataISO, dias) {
  const [y, m, d] = dataISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + dias);
  return dt.toISOString().slice(0, 10);
}

function diasNoMes(chaveMes) {
  const [ano, mes] = String(chaveMes || '').split('-').map(Number);
  return ano && mes ? new Date(Date.UTC(ano, mes, 0)).getUTCDate() : 0;
}

// agrupa os fechamentos por unidade+dia, somando faturamento de lançamentos
// duplicados no mesmo dia (ex: fechamento + sangria do mesmo dia contam pro
// dia, mas o dia so entra UMA vez no historico) - mesmo espirito do
// mesclarLancamentosDoMesmoDia que ja roda antes disso em index.js, so que
// aqui e so a soma que interessa pro recorde, nao o registro inteiro
function porDia(fechamentos) {
  const mapa = new Map(); // "unidade|data" -> { unidade, unidadeNome, grupo, data, faturamento }
  (fechamentos || []).forEach((f) => {
    const data = soData(f.data);
    if (!f.unidade || !data) return;
    const chave = `${f.unidade}|${data}`;
    const atual = mapa.get(chave);
    const faturamento = Number(f.faturamento) || 0;
    if (atual) { atual.faturamento += faturamento; if (!atual.grupo && f.grupo) atual.grupo = f.grupo; }
    else mapa.set(chave, { unidade: f.unidade, unidadeNome: f.unidadeNome || f.unidade, grupo: f.grupo || null, data, faturamento });
  });
  return [...mapa.values()];
}

// extremos (maior/menor) de uma lista de {valor,...}, ignorando faturamento
// <= 0: dia com faturamento zerado quase sempre e loja fechada/dado ainda
// nao lancado, nao uma venda real de R$0 - contar isso como "menor venda"
// premiaria buraco no lancamento, nao o pior dia de venda de verdade
function extremos(itens, campoValor) {
  const validos = itens.filter((i) => i[campoValor] > 0);
  if (!validos.length) return { maior: null, menor: null };
  let maior = validos[0]; let menor = validos[0];
  validos.forEach((i) => {
    if (i[campoValor] > maior[campoValor]) maior = i;
    if (i[campoValor] < menor[campoValor]) menor = i;
  });
  return { maior, menor };
}

// soma por semana (segunda a domingo) de uma unidade - so entram semanas com
// os 7 dias lancados (ver DIAS_PARA_SEMANA_VALIDA)
function semanasDaUnidade(diasDaUnidade) {
  const porSemana = new Map(); // segunda -> { inicio, fim, faturamento, dias }
  diasDaUnidade.forEach((d) => {
    const inicio = segundaDaSemana(d.data);
    const atual = porSemana.get(inicio) || { inicio, fim: somarDiasISO(inicio, 6), faturamento: 0, dias: 0 };
    atual.faturamento += d.faturamento;
    atual.dias += 1;
    porSemana.set(inicio, atual);
  });
  return [...porSemana.values()].filter((s) => s.dias >= DIAS_PARA_SEMANA_VALIDA);
}

// Mes tambem precisa ser comparavel: um mes ainda aberto (ou com dias sem
// fechamento) nao pode disputar ranking com um mes inteiro. A regra e a mesma
// da semana: so entram todos os dias de calendario daquele mes.
function mesesDaUnidade(diasDaUnidade) {
  const porMes = new Map();
  diasDaUnidade.forEach((d) => {
    const mes = String(d.data || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(mes)) return;
    const atual = porMes.get(mes) || { inicio: `${mes}-01`, fim: `${mes}-${String(diasNoMes(mes)).padStart(2, '0')}`, faturamento: 0, dias: 0 };
    atual.faturamento += d.faturamento;
    atual.dias += 1;
    porMes.set(mes, atual);
  });
  return [...porMes.values()].filter((m) => m.dias >= diasNoMes(m.inicio.slice(0, 7)));
}

// recordes de UMA unidade a partir dos dias ja agrupados dela
function recordesDaUnidade(unidade, unidadeNome, diasDaUnidade, hoje, janelaDias) {
  const { maior: diaMaior, menor: diaMenor } = extremos(diasDaUnidade, 'faturamento');
  const semanas = semanasDaUnidade(diasDaUnidade);
  const { maior: semanaMaior, menor: semanaMenor } = extremos(semanas, 'faturamento');
  const meses = mesesDaUnidade(diasDaUnidade);
  const { maior: mesMaior } = extremos(meses, 'faturamento');

  const recente = (dataFim) => dataFim != null && diasEntre(dataFim, hoje) <= janelaDias;

  return {
    unidade,
    unidadeNome,
    diasComLancamento: diasDaUnidade.length,
    semanasCompletas: semanas.length,
    diaRecorde: diaMaior ? { data: diaMaior.data, valor: diaMaior.faturamento } : null,
    diaMenor: diaMenor ? { data: diaMenor.data, valor: diaMenor.faturamento } : null,
    semanaRecorde: semanaMaior ? { inicio: semanaMaior.inicio, fim: semanaMaior.fim, valor: semanaMaior.faturamento } : null,
    semanaMenor: semanaMenor ? { inicio: semanaMenor.inicio, fim: semanaMenor.fim, valor: semanaMenor.faturamento } : null,
    mesRecorde: mesMaior ? { inicio: mesMaior.inicio, fim: mesMaior.fim, valor: mesMaior.faturamento } : null,
    diaRecordeRecente: !!diaMaior && recente(diaMaior.data),
    semanaRecordeRecente: !!semanaMaior && recente(semanaMaior.fim),
  };
}

// Ranking e sempre descendente: primeiro o maior faturamento. Em empate, o
// periodo mais recente vem antes; se ainda empatar, o nome da loja estabiliza
// a ordem para a tela nao ficar variando entre recargas.
function topTres(itens, campoData) {
  return (itens || [])
    .filter((i) => Number(i.valor) > 0)
    .sort((a, b) => Number(b.valor) - Number(a.valor)
      || String(b[campoData] || '').localeCompare(String(a[campoData] || ''))
      || String(a.unidadeNome || '').localeCompare(String(b.unidadeNome || ''), 'pt-BR'))
    .slice(0, 3);
}

// o "geral": o melhor/pior dia e a melhor/pior semana OLHANDO TODAS AS
// LOJAS JUNTAS, dizendo qual loja fez aquilo - complementa a lista por
// unidade com "qual e o recorde da rede inteira"
function recordesGerais(dias, todasSemanas) {
  const { maior: diaMaior, menor: diaMenor } = extremos(dias, 'faturamento');
  const { maior: semanaMaior, menor: semanaMenor } = extremos(todasSemanas, 'faturamento');
  const comUnidade = (item) => item && { unidade: item.unidade, unidadeNome: item.unidadeNome, ...item };
  return {
    diaRecorde: diaMaior ? { unidade: diaMaior.unidade, unidadeNome: diaMaior.unidadeNome, data: diaMaior.data, valor: diaMaior.faturamento } : null,
    diaMenor: diaMenor ? { unidade: diaMenor.unidade, unidadeNome: diaMenor.unidadeNome, data: diaMenor.data, valor: diaMenor.faturamento } : null,
    semanaRecorde: semanaMaior ? { unidade: semanaMaior.unidade, unidadeNome: semanaMaior.unidadeNome, inicio: semanaMaior.inicio, fim: semanaMaior.fim, valor: semanaMaior.faturamento } : null,
    semanaMenor: semanaMenor ? { unidade: semanaMenor.unidade, unidadeNome: semanaMenor.unidadeNome, inicio: semanaMenor.inicio, fim: semanaMenor.fim, valor: semanaMenor.faturamento } : null,
  };
}

// ponto de entrada: fechamentos crus (ja filtrados por permissao/unidades
// por quem chama) -> o que o painel desenha. janelaDias decide o que conta
// como "bateu recorde AGORA" pro plano de meta (default 30 - ~1 mes de
// janela pra reagir ao recorde sem a lista ficar vazia toda semana)
function montar(fechamentos, { hoje = hojeBrasiliaISO(), janelaDias = 30 } = {}) {
  const dias = porDia(fechamentos);
  const porUnidade = new Map();
  dias.forEach((d) => {
    if (!porUnidade.has(d.unidade)) porUnidade.set(d.unidade, { unidadeNome: d.unidadeNome, grupo: d.grupo || null, dias: [] });
    const info = porUnidade.get(d.unidade);
    if (!info.grupo && d.grupo) info.grupo = d.grupo;
    info.dias.push(d);
  });

  // grupo por unidade vai junto pra tela decidir sozinha se mostra o seletor de
  // Grupo: quem só tem loja de uma rede não precisa dele (ver vendas-recordes.html)
  const unidades = [...porUnidade.entries()]
    .map(([unidade, info]) => ({ ...recordesDaUnidade(unidade, info.unidadeNome, info.dias, hoje, janelaDias), grupo: info.grupo }))
    .sort((a, b) => (a.unidadeNome || '').localeCompare(b.unidadeNome || ''));

  const todasSemanas = unidades.flatMap((u) => {
    const info = porUnidade.get(u.unidade);
    return semanasDaUnidade(info.dias).map((s) => ({ ...s, unidade: u.unidade, unidadeNome: u.unidadeNome }));
  });
  const todosMeses = unidades.flatMap((u) => {
    const info = porUnidade.get(u.unidade);
    return mesesDaUnidade(info.dias).map((m) => ({ ...m, unidade: u.unidade, unidadeNome: u.unidadeNome, valor: m.faturamento }));
  });
  const todosDias = dias.map((d) => ({ ...d, valor: d.faturamento }));
  const semanasComValor = todasSemanas.map((s) => ({ ...s, valor: s.faturamento }));

  // candidatos a plano de meta: quem bateu o recorde de DIA e/ou de SEMANA
  // dentro da janela - e a lista que responde "quem eu premio agora"
  const candidatosMeta = unidades
    .filter((u) => u.diaRecordeRecente || u.semanaRecordeRecente)
    .map((u) => ({
      unidade: u.unidade,
      unidadeNome: u.unidadeNome,
      motivo: u.diaRecordeRecente && u.semanaRecordeRecente ? 'dia+semana' : (u.diaRecordeRecente ? 'dia' : 'semana'),
      diaRecorde: u.diaRecordeRecente ? u.diaRecorde : null,
      semanaRecorde: u.semanaRecordeRecente ? u.semanaRecorde : null,
    }))
    .sort((a, b) => {
      // dia+semana primeiro (dobrou a meta), depois pela data mais recente
      if ((a.motivo === 'dia+semana') !== (b.motivo === 'dia+semana')) return a.motivo === 'dia+semana' ? -1 : 1;
      const dataA = (a.diaRecorde || a.semanaRecorde || {}).data || (a.semanaRecorde || {}).fim || '';
      const dataB = (b.diaRecorde || b.semanaRecorde || {}).data || (b.semanaRecorde || {}).fim || '';
      return dataB.localeCompare(dataA);
    });

  return {
    hoje,
    janelaDias,
    geral: recordesGerais(dias, todasSemanas),
    unidades,
    candidatosMeta,
    rankings: {
      dias: topTres(todosDias, 'data'),
      semanas: topTres(semanasComValor, 'fim'),
      meses: topTres(todosMeses, 'fim'),
    },
  };
}

module.exports = {
  DIAS_PARA_SEMANA_VALIDA, hojeBrasiliaISO, diasEntre, segundaDaSemana, somarDiasISO,
  porDia, semanasDaUnidade, mesesDaUnidade, diasNoMes, topTres, recordesDaUnidade, recordesGerais, montar,
};

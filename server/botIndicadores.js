// botIndicadores.js
// Monta o resumo de indicadores que a rota GET /api/bot/indicadores devolve
// pro assistente do gestor de operacoes (Claude, rodando fora do app, sem
// sessao de usuario - mesmo esquema do robo de cobrancas em
// POST /api/bot/solicitacoes: token fixo em env var, ver index.js).
//
// SO LEITURA. Este modulo nao escreve em lugar nenhum e nao recebe o `db`:
// tudo que ele usa chega pronto de quem chama (fechamentos, pedido semanal,
// alertas, solicitacoes), vindo dos caches que as telas ja usam. Zero
// leitura extra no Firestore alem do que o painel ja faz.
//
// O que sai daqui e SO o que o codigo ja produz (ver CLAUDE.md §6): nao
// existe "meta do mes" nem "faturamento de hoje" - fechamento e lancado
// quando a loja fecha, entao o dia mais recente com dado completo e ONTEM.
// Comparacao e sempre periodo x periodo anterior do mesmo tamanho.

// campos do fechamento que valem pro gestor (o registro completo tem ~40;
// email, caixaInicial, deposito etc ficam de fora - nao ajudam a decidir e
// so engordam a resposta)
const CAMPOS_FECHAMENTO = [
  'unidade', 'unidadeNome', 'data', 'gerente', 'faturamento', 'totalDeclarado', 'diferenca', 'quebra', 'obsDif',
  'delivery', 'carryout', 'pickup', 'loja', 'ifood', 'food99', 'adyen', 'pix', 'pixCnpj', 'outros',
  'somaMaq', 'somaPOS', 'entradaDinheiro', 'totalSaida', 'tc', 'cancelados', 'observacao',
];

const DIAS_PADRAO = 7;
const DIAS_MAXIMO = 92;

function somarDiasISO(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function arredondar(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

function variacaoPct(atual, anterior) {
  if (!anterior) return null;
  return Math.round(((atual - anterior) / anterior) * 1000) / 10;
}

function enxugarFechamento(f) {
  const o = {};
  CAMPOS_FECHAMENTO.forEach((c) => { if (f[c] !== undefined) o[c] = f[c]; });
  return o;
}

// quantidade de pedidos de UM fechamento. Duas fontes, nesta ordem:
// 1. `tc` fixo (planilhas antigas: coluna "TC"/"Quantidade de Pedidos", ver
//    sheetsSync.js) - NAO e ticket medio, e contagem;
// 2. os KPIs extras do grupo marcados com `pedidos: true` na tela de Grupos
//    (ver grupos.js sanitizarCamposExtras). Cada rede chama de um jeito
//    ("Quantidade de Pedidos", "Total", "C Total Clientes"), por isso o
//    vinculo e o marcador, nunca o nome. `kpiPedidosPorUnidade` e
//    { codigoUnidade: ['campo', ...] } montado por quem chama.
// Sem nenhuma das duas, o dia nao tem pedidos (0) e nao entra no ticket medio.
function pedidosDoDia(f, kpiPedidosPorUnidade) {
  if (Number(f.tc) > 0) return Number(f.tc);
  const campos = (kpiPedidosPorUnidade || {})[f.unidade] || [];
  const extras = f.kpisExtras || {};
  return campos.reduce((s, campo) => s + (Number(extras[campo]) > 0 ? Number(extras[campo]) : 0), 0);
}

// agrega uma lista de fechamentos por unidade: total, dias lancados, media
// por dia lancado, quebra acumulada, pedidos e cancelados. O ticket medio
// sai daqui: faturamento / pedidos, so nos dias em que houve contagem de
// pedidos (senao um dia sem TC puxaria a media pra baixo).
function agregarPorUnidade(lista, nomesUnidades, kpiPedidosPorUnidade) {
  const porUnidade = new Map();
  lista.forEach((f) => {
    const chave = f.unidade;
    if (!porUnidade.has(chave)) {
      porUnidade.set(chave, {
        unidade: chave,
        unidadeNome: nomesUnidades[chave] || f.unidadeNome || chave,
        faturamento: 0, diasLancados: 0, quebra: 0, cancelados: 0, pedidos: 0, faturamentoComTc: 0,
        delivery: 0, carryout: 0, pickup: 0, loja: 0, ifood: 0,
      });
    }
    const a = porUnidade.get(chave);
    a.faturamento += Number(f.faturamento) || 0;
    a.diasLancados += 1;
    a.quebra += Number(f.quebra) || 0;
    a.cancelados += Number(f.cancelados) || 0;
    ['delivery', 'carryout', 'pickup', 'loja', 'ifood'].forEach((c) => { a[c] += Number(f[c]) || 0; });
    const pedidos = pedidosDoDia(f, kpiPedidosPorUnidade);
    if (pedidos > 0) { a.pedidos += pedidos; a.faturamentoComTc += Number(f.faturamento) || 0; }
  });
  return [...porUnidade.values()].map((a) => ({
    unidade: a.unidade,
    unidadeNome: a.unidadeNome,
    faturamento: arredondar(a.faturamento),
    diasLancados: a.diasLancados,
    mediaDiaria: a.diasLancados ? arredondar(a.faturamento / a.diasLancados) : 0,
    quebra: arredondar(a.quebra),
    cancelados: arredondar(a.cancelados),
    pedidos: a.pedidos,
    ticketMedio: a.pedidos ? arredondar(a.faturamentoComTc / a.pedidos) : null,
    delivery: arredondar(a.delivery),
    carryout: arredondar(a.carryout),
    pickup: arredondar(a.pickup),
    loja: arredondar(a.loja),
    ifood: arredondar(a.ifood),
  })).sort((x, y) => y.faturamento - x.faturamento);
}

// `unidadesLoja`: { codigo: nomeCurto } - so as lojas que entram no resumo
// (o filtro de grupo/franquia e decidido por quem chama, em index.js).
// `hoje`: YYYY-MM-DD em Brasilia (index.js ja tem hojeBrasiliaISO).
// `compacto`: modo do briefing diario - so agregados. Tira `fechamentos[]`
// (as linhas dia a dia, que sao ~80% do JSON), so lista quem tem pendencia
// no pedido semanal, e encurta alertas/solicitacoes. Quem precisa do
// detalhe pede sem o parametro.
function montarIndicadores({
  fechamentos = [], unidadesLoja = {}, pedidoSemanal = [], alertas = [], solicitacoes = [],
  hoje, dias = DIAS_PADRAO, compacto = false, limiteAlertas, limiteSolicitacoes, kpiPedidosPorUnidade = {},
}) {
  if (limiteAlertas == null) limiteAlertas = compacto ? 15 : 30;
  if (limiteSolicitacoes == null) limiteSolicitacoes = compacto ? 20 : 40;
  const n = Math.min(Math.max(parseInt(dias, 10) || DIAS_PADRAO, 1), DIAS_MAXIMO);
  const ontem = somarDiasISO(hoje, -1);
  const inicio = somarDiasISO(ontem, -(n - 1));
  const inicioAnterior = somarDiasISO(inicio, -n);
  const fimAnterior = somarDiasISO(inicio, -1);

  const codigos = new Set(Object.keys(unidadesLoja));
  const soLojas = fechamentos.filter((f) => f && f.data && codigos.has(f.unidade));

  const doPeriodo = soLojas.filter((f) => f.data >= inicio && f.data <= ontem);
  const doAnterior = soLojas.filter((f) => f.data >= inicioAnterior && f.data <= fimAnterior);
  const deOntem = doPeriodo.filter((f) => f.data === ontem);

  const porUnidade = agregarPorUnidade(doPeriodo, unidadesLoja, kpiPedidosPorUnidade);
  const anteriorPorUnidade = new Map(agregarPorUnidade(doAnterior, unidadesLoja, kpiPedidosPorUnidade).map((a) => [a.unidade, a]));
  porUnidade.forEach((a) => {
    const ant = anteriorPorUnidade.get(a.unidade);
    a.faturamentoPeriodoAnterior = ant ? ant.faturamento : 0;
    a.variacaoPct = variacaoPct(a.faturamento, ant ? ant.faturamento : 0);
  });

  const totalPeriodo = arredondar(doPeriodo.reduce((s, f) => s + (Number(f.faturamento) || 0), 0));
  const totalAnterior = arredondar(doAnterior.reduce((s, f) => s + (Number(f.faturamento) || 0), 0));
  const totalOntem = arredondar(deOntem.reduce((s, f) => s + (Number(f.faturamento) || 0), 0));
  const pedidosPeriodo = porUnidade.reduce((s, u) => s + u.pedidos, 0);
  const pedidosOntem = deOntem.reduce((s, f) => s + pedidosDoDia(f, kpiPedidosPorUnidade), 0);
  // ontem, loja a loja - o briefing precisa disso mesmo no modo compacto
  // (e uma linha por loja, nao as 7x14 do periodo)
  const ontemPorUnidade = deOntem.map((f) => {
    const pedidos = pedidosDoDia(f, kpiPedidosPorUnidade);
    return {
      unidade: f.unidade, unidadeNome: unidadesLoja[f.unidade] || f.unidadeNome || f.unidade,
      faturamento: arredondar(f.faturamento), pedidos,
      ticketMedio: pedidos > 0 ? arredondar((Number(f.faturamento) || 0) / pedidos) : null,
      quebra: arredondar(f.quebra), cancelados: arredondar(f.cancelados), gerente: f.gerente || null,
    };
  }).sort((x, y) => y.faturamento - x.faturamento);

  const lancaramOntem = new Set(deOntem.map((f) => f.unidade));
  const naoLancaramOntem = [...codigos]
    .filter((c) => !lancaramOntem.has(c))
    .map((c) => ({ unidade: c, unidadeNome: unidadesLoja[c] }))
    .sort((x, y) => x.unidadeNome.localeCompare(y.unidadeNome, 'pt-BR'));

  // quebra de caixa relevante: mesmo criterio de sinal do fechamento (quebra
  // negativa = faltou dinheiro). Lista o que passou de R$ 50 em modulo, em
  // qualquer dia do periodo, pra o gestor cobrar.
  const quebrasRelevantes = doPeriodo
    .filter((f) => Math.abs(Number(f.quebra) || 0) >= 50)
    .map((f) => ({ unidade: f.unidade, unidadeNome: unidadesLoja[f.unidade], data: f.data, quebra: arredondar(f.quebra), obsDif: f.obsDif || null, gerente: f.gerente || null }))
    .sort((x, y) => Math.abs(y.quebra) - Math.abs(x.quebra));

  const pedidos = (pedidoSemanal || [])
    .filter((u) => codigos.has(u.codigo))
    .map((u) => ({
      unidade: u.codigo, unidadeNome: unidadesLoja[u.codigo] || u.nome, regra: u.regraNome || null,
      diaSemana: u.diaSemanaNome || null, dataPedido: u.dataPedido, diasRestantes: u.diasRestantes,
      estado: u.estado, atraso: u.atraso || null,
      confirmadoEm: u.confirmacao ? u.confirmacao.confirmadoEm : null,
      confirmadoPor: u.confirmacao ? u.confirmacao.porNome : null,
    }));

  const alertasAbertos = (alertas || [])
    .filter((a) => a && !a.atendidoEm)
    .slice(0, limiteAlertas)
    .map((a) => ({ id: a.id, tipo: a.tipo, titulo: a.titulo, resumo: a.resumo || null, critico: !!a.critico, criadoEm: a.criadoEm, url: a.url || null }));

  const pendentes = (solicitacoes || []).filter((s) => s && s.status === 'PENDENTE');
  const pendentesPorTipo = {};
  pendentes.forEach((s) => { pendentesPorTipo[s.tipo || 'outro'] = (pendentesPorTipo[s.tipo || 'outro'] || 0) + 1; });
  const solicitacoesPendentes = pendentes
    .slice()
    .sort((x, y) => String(x.criadoEm || '').localeCompare(String(y.criadoEm || '')))
    .slice(0, limiteSolicitacoes)
    .map((s) => ({
      numeroTicket: s.numeroTicket, tipo: s.tipo, unidadeNome: s.unidadeNome || s.unidade || null, titulo: s.titulo,
      valorEstimado: s.valorEstimado == null ? null : Number(s.valorEstimado), vencimento: s.vencimento || null,
      criadoEm: s.criadoEm, criadoPorEmail: s.criadoPorEmail || null,
    }));

  return {
    geradoEm: new Date().toISOString(),
    compacto: !!compacto,
    hoje,
    ontem,
    periodo: { inicio, fim: ontem, dias: n },
    periodoAnterior: { inicio: inicioAnterior, fim: fimAnterior },
    unidades: Object.entries(unidadesLoja).map(([codigo, nome]) => ({ codigo, nome })),
    resumo: {
      faturamentoPeriodo: totalPeriodo,
      faturamentoPeriodoAnterior: totalAnterior,
      variacaoPct: variacaoPct(totalPeriodo, totalAnterior),
      faturamentoOntem: totalOntem,
      pedidosPeriodo,
      pedidosOntem,
      lojasLancaramOntem: lancaramOntem.size,
      lojasTotal: codigos.size,
      naoLancaramOntem,
    },
    ontemPorUnidade,
    porUnidade,
    quebrasRelevantes,
    fechamentos: compacto ? undefined : doPeriodo.map(enxugarFechamento).sort((x, y) => (y.data.localeCompare(x.data) || x.unidadeNome.localeCompare(y.unidadeNome, 'pt-BR'))),
    pedidoSemanal: {
      total: pedidos.length,
      feitos: pedidos.filter((p) => p.estado === 'feito').length,
      atrasados: pedidos.filter((p) => p.atraso).length,
      // compacto: so quem tem o que fazer (atraso ou pedido ainda nao feito)
      unidades: compacto ? pedidos.filter((p) => p.atraso || p.estado !== 'feito') : pedidos,
    },
    alertasCentral: { abertos: alertasAbertos.length, lista: alertasAbertos },
    solicitacoes: { pendentes: pendentes.length, porTipo: pendentesPorTipo, lista: solicitacoesPendentes },
  };
}

function escaparHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function brl(v) {
  return 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// E-mail diario com o MESMO JSON da rota, pra quem le por caixa de entrada
// (o assistente do gestor le pelo Gmail; o ambiente dele nao alcanca o
// NoPulso direto). Cabecalho legivel por humano + o JSON integral dentro de
// <pre id="indicadores-json">, que e o que a maquina extrai. Nada aqui e
// calculado de novo: e o objeto de montarIndicadores() serializado.
function montarEmailHtml(ind) {
  const r = ind.resumo || {};
  const faltaram = (r.naoLancaramOntem || []).map((u) => u.unidadeNome).join(', ') || 'ninguém';
  const linhas = (ind.porUnidade || []).slice(0, 20).map((u) =>
    `<tr><td>${escaparHtml(u.unidadeNome)}</td><td align="right">${brl(u.faturamento)}</td><td align="right">${u.pedidos}</td><td align="right">${u.ticketMedio == null ? '—' : brl(u.ticketMedio)}</td><td align="right">${u.variacaoPct == null ? '—' : (u.variacaoPct > 0 ? '+' : '') + u.variacaoPct + '%'}</td></tr>`).join('');
  const html = [
    '<div style="font-family:Arial,sans-serif;font-size:14px;color:#111">',
    `<h2 style="margin:0 0 8px">NoPulso · indicadores até ${escaparHtml(ind.ontem)}</h2>`,
    `<p style="margin:0 0 12px">Período ${escaparHtml(ind.periodo.inicio)} a ${escaparHtml(ind.periodo.fim)} (${ind.periodo.dias} dias): <b>${brl(r.faturamentoPeriodo)}</b>`
      + (r.variacaoPct == null ? '' : ` (${r.variacaoPct > 0 ? '+' : ''}${r.variacaoPct}% vs. período anterior)`)
      + ` · ${r.pedidosPeriodo || 0} pedidos.<br>Ontem: <b>${brl(r.faturamentoOntem)}</b> · ${r.pedidosOntem || 0} pedidos · ${r.lojasLancaramOntem} de ${r.lojasTotal} lojas lançaram. Não lançaram: ${escaparHtml(faltaram)}.</p>`,
    '<p style="margin:12px 0 4px"><b>Ontem, por loja</b></p>',
    '<table cellpadding="4" style="border-collapse:collapse;font-size:13px"><tr><th align="left">Loja</th><th>Faturamento</th><th>Pedidos</th><th>Ticket médio</th><th>Quebra</th></tr>',
    (ind.ontemPorUnidade || []).map((u) =>
      `<tr><td>${escaparHtml(u.unidadeNome)}</td><td align="right">${brl(u.faturamento)}</td><td align="right">${u.pedidos}</td><td align="right">${u.ticketMedio == null ? '—' : brl(u.ticketMedio)}</td><td align="right">${u.quebra ? brl(u.quebra) : '—'}</td></tr>`).join(''),
    '</table>',
    `<p style="margin:12px 0 4px"><b>Período (${ind.periodo.dias} dias), por loja</b></p>`,
    '<table cellpadding="4" style="border-collapse:collapse;font-size:13px"><tr><th align="left">Loja</th><th>Faturamento</th><th>Pedidos</th><th>Ticket médio</th><th>Var.</th></tr>',
    linhas,
    '</table>',
    `<p style="margin:12px 0 4px;color:#555">Quebras ≥ R$ 50: ${(ind.quebrasRelevantes || []).length} · Pedido semanal atrasado: ${(ind.pedidoSemanal || {}).atrasados || 0} · Alertas abertos: ${(ind.alertasCentral || {}).abertos || 0} · Solicitações pendentes: ${(ind.solicitacoes || {}).pendentes || 0}</p>`,
    '<p style="margin:16px 0 4px;color:#555">Dados completos (lidos pelo assistente):</p>',
    `<pre id="indicadores-json" style="font-size:11px;white-space:pre-wrap;background:#f4f4f4;padding:8px">${escaparHtml(JSON.stringify(ind))}</pre>`,
    '</div>',
  ].join('\n');
  return html;
}

// caminho inverso do montarEmailHtml: acha o JSON no HTML do e-mail
function extrairJsonDoEmail(html) {
  const m = /<pre id="indicadores-json"[^>]*>([\s\S]*?)<\/pre>/.exec(String(html || ''));
  if (!m) return null;
  const texto = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  try { return JSON.parse(texto); } catch (e) { return null; }
}

module.exports = { montarIndicadores, pedidosDoDia, montarEmailHtml, extrairJsonDoEmail, somarDiasISO, CAMPOS_FECHAMENTO, DIAS_PADRAO, DIAS_MAXIMO };

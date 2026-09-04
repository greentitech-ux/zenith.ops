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

// agrega uma lista de fechamentos por unidade: total, dias lancados, media
// por dia lancado, quebra acumulada, pedidos e cancelados.
// `tc` no fechamento e "TC" = Quantidade de Pedidos (ver sheetsSync.js:
// get('TC') ?? get('Quantidade de Pedidos')), NAO ticket medio. O ticket
// medio sai daqui: faturamento / pedidos, so nos dias em que o TC foi
// lancado (senao um dia sem TC puxaria a media pra baixo).
function agregarPorUnidade(lista, nomesUnidades) {
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
    if (Number(f.tc) > 0) { a.pedidos += Number(f.tc); a.faturamentoComTc += Number(f.faturamento) || 0; }
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
  hoje, dias = DIAS_PADRAO, compacto = false, limiteAlertas, limiteSolicitacoes,
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

  const porUnidade = agregarPorUnidade(doPeriodo, unidadesLoja);
  const anteriorPorUnidade = new Map(agregarPorUnidade(doAnterior, unidadesLoja).map((a) => [a.unidade, a]));
  porUnidade.forEach((a) => {
    const ant = anteriorPorUnidade.get(a.unidade);
    a.faturamentoPeriodoAnterior = ant ? ant.faturamento : 0;
    a.variacaoPct = variacaoPct(a.faturamento, ant ? ant.faturamento : 0);
  });

  const totalPeriodo = arredondar(doPeriodo.reduce((s, f) => s + (Number(f.faturamento) || 0), 0));
  const totalAnterior = arredondar(doAnterior.reduce((s, f) => s + (Number(f.faturamento) || 0), 0));
  const totalOntem = arredondar(deOntem.reduce((s, f) => s + (Number(f.faturamento) || 0), 0));
  const pedidosPeriodo = porUnidade.reduce((s, u) => s + u.pedidos, 0);
  const pedidosOntem = deOntem.reduce((s, f) => s + (Number(f.tc) > 0 ? Number(f.tc) : 0), 0);

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

module.exports = { montarIndicadores, somarDiasISO, CAMPOS_FECHAMENTO, DIAS_PADRAO, DIAS_MAXIMO };

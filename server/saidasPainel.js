// saidasPainel.js
// Junta as duas fontes de "dinheiro que saiu do caixa" (pedido do usuario:
// "Painel das Saidas, Sangrias/Depositos") numa lista so, cada item com uma
// "chave" estavel e um estado de verificacao (conferencia contra
// extrato/comprovante, feita por Master ou Admin - ver index.js):
//
//   - Sangria/Deposito: coleção própria (sangrias.js), já tem id e já
//     guarda o próprio estado de verificação.
//   - "Outras saídas" avulsas do Fechamento (detalhesSaidas, ver
//     fechamentosLive.js): array sem id próprio - o estado de verificação
//     mora em verificacoesSaida.js, referenciado por chave
//     `${fechamentoId}::${indice}`.
//
// So leitura (listar/filtrar) + o dispatch de marcarVerificada pra cada
// fonte - a validacao/gravacao de verdade continua em cada modulo dono do
// dado (sangrias.js / verificacoesSaida.js), este arquivo so junta e roteia.
const fechamentosLive = require('./fechamentosLive');
const sangrias = require('./sangrias');
const verificacoesSaida = require('./verificacoesSaida');

function linhaDeSangria(s) {
  return {
    chave: `sangria::${s.id}`,
    origem: 'sangria',
    unidade: s.unidade,
    unidadeNome: s.unidadeNome,
    grupo: s.grupo,
    data: s.data,
    descricao: s.descricao || 'Sangria/Depósito',
    valor: s.valor,
    criadoPorEmail: s.criadoPorEmail,
    criadoEm: s.criadoEm,
    verificada: !!s.verificada,
    verificadaPorEmail: s.verificadaPorEmail || null,
    verificadaEm: s.verificadaEm || null,
    // esperado/divergencia sao SOBRESCRITOS por recalcularDivergencias na
    // leitura (janela desde a retirada anterior). O que fica aqui e' o que o
    // sistema apurou NA HORA - preservado em esperadoNaHora/divergenciaNaHora,
    // porque e' o numero que a loja assinou e o documento nunca e' reescrito.
    esperado: s.esperado != null ? s.esperado : null,
    divergencia: s.divergencia != null ? s.divergencia : null,
    motivoDivergencia: s.motivoDivergencia || null,
    temDivergencia: sangrias.temDivergencia(s),
    esperadoNaHora: s.esperado != null ? s.esperado : null,
    divergenciaNaHora: s.divergencia != null ? s.divergencia : null,
    extra: { periodoInicio: s.periodoInicio, periodoFim: s.periodoFim, nomeDepositante: s.nomeDepositante, diasSemFechamento: s.diasSemFechamento || 0 },
  };
}

// "Sangria" que a planilha antiga lancou como uma "outra saida" qualquer
// (ver reclassificar em verificacoesSaida.js): o item continua sendo linha do
// fechamento, so a leitura aqui passa a trata-lo como Sangria/Deposito, pra
// ele cair na coluna certa do painel e no total certo.
function linhasDeFechamento(f, mapaVerif) {
  return (f.detalhesSaidas || []).map((item, idx) => {
    const chave = `${f.id}::${idx}`;
    const v = mapaVerif[chave];
    const reclassificada = !!(v && v.origemManual === 'sangria');
    // correcao aplicada por cima do item (ver corrigirItem em
    // verificacoesSaida.js). E' o caminho da saida que veio da PLANILHA, que
    // nao tem documento pra editar - a planilha fica intacta e a leitura aqui
    // passa a mostrar o valor corrigido.
    const correcao = (v && v.correcao) || null;
    return {
      chave,
      origem: reclassificada ? 'sangria' : 'saida',
      reclassificada,
      corrigida: !!correcao,
      corrigidaPorEmail: (v && v.corrigidoPorEmail) || null,
      valorOriginal: correcao ? item.valor : null,
      descricaoOriginal: correcao ? (item.descricao || null) : null,
      reclassificadaPorEmail: (v && v.origemManualPorEmail) || null,
      unidade: f.unidade,
      unidadeNome: f.unidadeNome,
      grupo: f.grupo,
      data: f.data,
      descricao: (correcao ? correcao.descricao : item.descricao) || 'Saída avulsa',
      valor: correcao ? correcao.valor : item.valor,
      criadoPorEmail: f.gerente || f.criadoPorEmail,
      criadoEm: f.criadoEm,
      verificada: !!(v && v.verificada),
      verificadaPorEmail: (v && v.verificadaPorEmail) || null,
      verificadaEm: (v && v.verificadaEm) || null,
      extra: null,
    };
  });
}

// O MESMO fechamento pode existir NAS DUAS fontes, e isso nao e' acidente:
// a loja lanca no app (Firestore) e o Master manda esse mesmo fechamento pra
// planilha ARCFOOD (enviarFechamentoPlanilha, sheetsSync.js), que a
// sincronizacao seguinte le de volta pro snapshot em memoria. Juntar as duas
// listas cruas trata um lancamento so como dois: a entrada em dinheiro do dia
// aparecia dobrada e a mesma saida avulsa era listada duas vezes.
//
// Aqui a linha da planilha e' DESCARTADA quando ja existe fechamento no app
// pra mesma unidade+data. O Firestore vence porque e' o registro nativo - e'
// onde a loja lancou, onde o Master edita direto e onde a correcao mora; a
// linha da planilha e' copia gravada pelo proprio app. A planilha continua
// sendo a unica fonte dos dias que nunca passaram pelo app (o historico
// antigo), que e' justamente o que ela existe pra trazer.
//
// Descartar, e nao somar: somar so faz sentido entre linhas da MESMA fonte
// (a planilha lanca sangria em linha separada do fechamento do dia) - e essa
// soma continua acontecendo normalmente, porque as duas linhas sobrevivem
// juntas a este filtro.
//
// O QUE SE DESCARTA E' O FECHAMENTO DO DIA, NAO O DIA INTEIRO. A ARCFOOD
// lanca a sangria numa LINHA SEPARADA da planilha, com faturamento zerado -
// e' so a retirada. Descartar por unidade+data levava essa linha junto quando
// o app tinha o fechamento daquele dia, e a sangria sumia sem deixar rastro:
// Carrao 05/08 tinha no app um fechamento (entrada 107) e na planilha a linha
// "SAngria Andre 05/08" de R$ 675,00 - a sangria nao aparecia no painel. Nos
// dias em que o app NAO tinha fechamento (02/08, 10/08, 14/08) as sangrias da
// planilha entravam normalmente, o que e' exatamente a assimetria que
// denunciou o problema.
//
// A linha que duplica e' a que TRAZ O FECHAMENTO (faturamento, entrada em
// dinheiro ou total declarado). Linha sem nenhum desses e' lancamento extra
// do dia - existe so na planilha, o app nao tem copia dela, e por isso ela
// sobrevive.
function trazFechamentoDoDia(f) {
  return (Number(f.faturamento) || 0) > 0
    || (Number(f.entradaDinheiro) || 0) > 0
    || (Number(f.totalDeclarado) || 0) > 0;
}

function semDuplicataDaPlanilha(doApp, daPlanilha) {
  if (!Array.isArray(daPlanilha) || !daPlanilha.length) return [];
  const noApp = new Set(doApp.map((f) => `${f.unidade}::${f.data}`));
  return daPlanilha.filter((f) => !noApp.has(`${f.unidade}::${f.data}`) || !trazFechamentoDoDia(f));
}

// extrasFechamentos: fechamentos que NÃO moram na coleção fechamentosLive -
// hoje só um caso, o snapshot em memória sincronizado da planilha ARCFOOD
// (ver sheetsSync.js/index.js, fechamentosData). Sem isso, o painel só
// mostrava a saída avulsa lançada direto no app - a itemizada que veio da
// planilha (mesmo já convertida em detalhesSaidas, ver sheetsSync.js)
// nunca aparecia, porque fechamentosLive.listAll() só lê o Firestore.
async function listar(extrasFechamentos = []) {
  const [fechamentos, listaSangrias, mapaVerif] = await Promise.all([
    fechamentosLive.listAll(),
    sangrias.listAll(),
    verificacoesSaida.mapaDeChaves(),
  ]);
  const deSangria = listaSangrias.map(linhaDeSangria);
  const todosFechamentos = [...fechamentos, ...semDuplicataDaPlanilha(fechamentos, extrasFechamentos)];
  const deFechamento = todosFechamentos.flatMap((f) => linhasDeFechamento(f, mapaVerif));
  const itens = [...deSangria, ...deFechamento];
  // refaz a conferência sobre o dado de HOJE, com a janela desde a retirada
  // anterior (ver recalcularDivergencias)
  return recalcularDivergencias(itens, await listarEntradas(extrasFechamentos));
}

// ENTRADA em dinheiro do periodo - a outra ponta da conta que o Master pediu
// ("entrada menos saidas avulsas menos sangria = quanto de dinheiro tem em
// loja"). Sai do campo entradaDinheiro do MESMO fechamento de onde ja saem as
// saidas avulsas, entao nao custa leitura nova: fechamentosLive.listAll() e
// cacheado e ja foi chamado no listar() acima.
//
// Uma linha por fechamento (nao por unidade+dia): quem soma e' quem consome,
// e assim o filtro de unidade/grupo/periodo e o mesmo `filtrar` das saidas.
// Nao passa por mesclarLancamentosDoMesmoDia de proposito - a mescla SOMA
// entradaDinheiro (esta em CAMPOS_SOMA, ver sheetsSync.js), entao o total
// daria exatamente igual, so mais caro.
async function listarEntradas(extrasFechamentos = []) {
  const [fechamentos, mapaVerif] = await Promise.all([
    fechamentosLive.listAll(),
    verificacoesSaida.mapaDeChaves(),
  ]);
  // mesmo descarte de duplicata das saidas (ver semDuplicataDaPlanilha): sem
  // ele o dia lancado no app E enviado pra planilha somava a entrada duas
  // vezes - foi o que o Master viu ("01/08 consta como 524 porem foi metade")
  const todos = [...fechamentos, ...semDuplicataDaPlanilha(fechamentos, extrasFechamentos)];
  return todos
    .map((f) => {
      // correcao manual do Master/Admin sobre a entrada de um fechamento que
      // veio da PLANILHA (ver corrigirEntrada em verificacoesSaida.js). O
      // fechamento lancado no app nao passa por aqui: naquele a edicao e'
      // direta, no proprio documento.
      const v = mapaVerif[`entrada::${f.id}`];
      const correcao = (v && v.correcaoEntrada) || null;
      const original = Number(f.entradaDinheiro) || 0;
      return {
        fechamentoId: f.id,
        unidade: f.unidade,
        unidadeNome: f.unidadeNome,
        grupo: f.grupo,
        data: f.data,
        valor: correcao ? correcao.valor : original,
        corrigida: !!correcao,
        valorOriginal: correcao ? original : null,
        corrigidaPorEmail: correcao ? (v.corrigidoPorEmail || null) : null,
      };
    })
    // valor zero sai da lista: e' o fechamento que nao teve entrada em
    // dinheiro, e tambem o efeito do "excluir" da tela (correcao pra 0)
    .filter((e) => e.valor);
}

// Entrada em dinheiro DIA A DIA por unidade. listarEntradas devolve uma
// linha por FECHAMENTO, e o mesmo dia ainda pode ter mais de uma linha DENTRO
// da mesma fonte: a planilha ARCFOOD lanca a sangria/retirada como linha
// separada do fechamento do dia (ver mesclarLancamentosDoMesmoDia em
// sheetsSync.js). Aqui o dia vira UMA linha com a soma, que e' como o Master
// le ("quanto entrou de dinheiro nessa loja nesse dia").
//
// O que esta soma NAO faz e' juntar app + planilha: o mesmo fechamento nas
// duas fontes e' um lancamento so, e ja foi descartado em listarEntradas (ver
// semDuplicataDaPlanilha). Somar ali dobrava a entrada do dia.
//
// Somar dentro da fonte e' o mesmo criterio que /api/fechamentos ja usa pro
// dia repetido (entradaDinheiro esta em CAMPOS_SOMA) - a coluna nao inventa
// uma conta propria.
//
// O total nao muda: somar as linhas por fechamento ou os dias agregados da
// o mesmo numero - por isso o KPI de Entrada continua batendo.
//
// Nao custa leitura nova: reusa exatamente a mesma fonte de listarEntradas.
async function listarEntradasPorDia(extrasFechamentos = []) {
  const porChave = new Map();
  for (const e of await listarEntradas(extrasFechamentos)) {
    const chave = `${e.unidade}::${e.data}`;
    const atual = porChave.get(chave);
    if (atual) {
      atual.valor = +(atual.valor + e.valor).toFixed(2);
      atual.lancamentos += 1;
      // `origens` existe porque o card e' do DIA, mas editar/excluir e' por
      // LANCAMENTO: sem saber de qual fechamento veio cada parcela, a tela nao
      // teria o que mandar pro servidor num dia com mais de um lancamento.
      atual.origens.push({ fechamentoId: e.fechamentoId, valor: e.valor, corrigida: e.corrigida });
      atual.corrigida = atual.corrigida || e.corrigida;
      continue;
    }
    porChave.set(chave, {
      chave, ...e, lancamentos: 1,
      origens: [{ fechamentoId: e.fechamentoId, valor: e.valor, corrigida: e.corrigida }],
    });
  }
  // mais recente primeiro, igual a lista de saidas do painel
  return [...porChave.values()].sort((a, b) => String(b.data || '').localeCompare(String(a.data || ''))
    || String(a.unidadeNome || a.unidade || '').localeCompare(String(b.unidadeNome || b.unidade || ''), 'pt-BR'));
}

// Corrige (ou zera, que e' o "excluir" da tela) a ENTRADA em dinheiro de um
// fechamento que veio da PLANILHA. Igual a corrigirItemPlanilha: valida contra
// o snapshot em memoria - a planilha nao tem documento pra editar, entao a
// correcao mora ao lado e a leitura do painel a aplica por cima.
//
// O fechamento lancado no app NAO passa por aqui: nele o Master/Admin edita o
// proprio documento (fechamentosLive.editarDireto), que e' o certo - dois
// caminhos de escrita pro mesmo dado seria pedir divergencia.
async function corrigirEntradaPlanilha(fechamentoId, { valor, porId, porEmail }, extrasFechamentos = []) {
  const f = (Array.isArray(extrasFechamentos) ? extrasFechamentos : []).find((x) => x.id === fechamentoId);
  if (!f) throw new Error('Fechamento não encontrado.');
  return verificacoesSaida.corrigirEntrada(`entrada::${fechamentoId}`, { valor, porId, porEmail });
}

// A JANELA da conferência de caixa: desde a RETIRADA ANTERIOR.
//
// Decisão do Master, depois de a régua anterior dar errado em produção: o
// esperado de uma sangria é o que entrou menos o que saiu DESDE A ÚLTIMA
// retirada - não o acumulado da loja desde sempre.
//
// A régua antiga era saldo corrido ("tudo até a data"), que só fecha se todo o
// histórico de sangrias estiver lançado. Onde não está, o acumulado inteiro da
// unidade vira "esperado": uma sangria de R$ 540 apareceu esperando
// R$ 19.745,52. Cada retirada zera o caixa, então a janela recomeça nela.
//
// `desde` é EXCLUSIVO: o período que a retirada anterior declarou levar já foi
// conferido por ela.
//
// Sem retirada anterior devolve null, e quem chama trata como SEM BASE: não dá
// pra dizer desde quando o dinheiro está acumulando, e chutar "desde sempre" é
// justamente o erro que se está corrigindo (§6 - dado que não existe não vira
// número).
//
// O corte NAO e' a data em que a sangria foi lancada, e' o FIM DO PERIODO que
// ela declara ter retirado (o "Ate" do formulario). Os dois quase sempre
// diferem: a loja fecha o caixa de ontem e leva o dinheiro hoje. Usar a data
// do lancamento joga fora o dinheiro que entrou no proprio dia da retirada -
// foi o que zerou o card de Sao Miguel, que tinha R$ 91,00 em gaveta: sangria
// de R$ 540,00 lancada em 26/08 cobrindo ate 25/08, e a entrada de 26/08
// (R$ 91,00) ficou de fora dos dois lados da conta.
//
// Pelo fim do periodo, os ciclos se encaixam sem buraco e sem sobreposicao: o
// que uma sangria declarou nao ter levado continua na gaveta e entra inteiro
// na conferencia da proxima.
function fimDoCiclo(sg) {
  const pf = sg && sg.extra ? sg.extra.periodoFim : null;
  if (pf && /^\d{4}-\d{2}-\d{2}$/.test(pf)) return pf;
  return sg && sg.data ? sg.data : null;
}

// O maior fim de periodo, e nao o da sangria mais recente: e' ate' onde o
// dinheiro comprovadamente ja saiu da gaveta. Duas sangrias lancadas fora de
// ordem nao abrem buraco.
//
// `ateCiclo` corta pelo FIM DO CICLO, nao pela data do lancamento: e' o que
// responde "quanto tinha na gaveta EM tal dia". Uma retirada cujo ciclo fecha
// depois do dia perguntado ainda nao tinha acontecido naquele dia - deixar ela
// zerar a janela faria o passado aparecer sempre vazio.
function inicioDaJanela(sangriasDaUnidade, { ate, ignorarChave, ateCiclo } = {}) {
  const anteriores = sangriasDaUnidade
    .filter((sg) => sg.chave !== ignorarChave && (!ate || (sg.data || '') <= ate))
    .map(fimDoCiclo)
    .filter(Boolean)
    .filter((fim) => !ateCiclo || fim <= ateCiclo)
    .sort();
  return anteriores.length ? anteriores[anteriores.length - 1] : null;
}

// Decisão do Master (27/08/2026): a conta de dinheiro em loja DESCONSIDERA os
// meses anteriores a agosto/2026 - "seguiremos com o mês de agosto apenas pra
// frente". Antes de agosto havia retirada sem sangria lançada em várias
// unidades, e contar esse passado transforma cada retirada não lançada numa
// "sobra" eterna no card.
//
// O piso tem a MESMA semântica exclusiva do `desde` (o dia do piso não conta),
// então '2026-07-31' faz a contagem começar em 01/08/2026.
const PISO_JANELA = process.env.DINHEIRO_LOJA_INICIO || '2026-07-31';

// Aplica o piso sobre a última retirada: a janela começa no que for MAIS
// recente entre a última sangria e 31/07. Sem sangria nenhuma, a janela ainda
// existe - começa no piso - porque agora há uma data de corte declarada pelo
// Master, e não mais um "desde sempre" chutado (o erro do §6 que este arquivo
// já pagou duas vezes).
function comPiso(desde) {
  return desde && desde > PISO_JANELA ? desde : PISO_JANELA;
}

// Refaz esperado/divergencia de cada sangria NA LEITURA, com a janela acima.
// Pedido do Master: "tudo precisa refletir, tudo precisa auto ajustar" - sem
// isso, corrigir a entrada de um dia deixava a sangria acusando uma falta que
// já não existe.
//
// O que o sistema apurou NA HORA continua gravado no documento e vem em
// esperadoNaHora/divergenciaNaHora: é o registro do que a loja assinou, e não
// é reescrito nunca (CLAUDE.md §1).
//
// Não custa leitura nova: recebe as listas que o chamador já tem em mãos.
function recalcularDivergencias(itens, entradas) {
  const porUnidade = new Map();
  const daUnidade = (u) => {
    if (!porUnidade.has(u)) porUnidade.set(u, { entradas: [], saidas: [], sangrias: [] });
    return porUnidade.get(u);
  };
  entradas.forEach((e) => daUnidade(e.unidade).entradas.push(e));
  itens.forEach((it) => {
    if (!it.unidade) return;
    (it.origem === 'sangria' ? daUnidade(it.unidade).sangrias : daUnidade(it.unidade).saidas).push(it);
  });

  for (const grupo of porUnidade.values()) {
    for (const sg of grupo.sangrias) {
      const desde = comPiso(inicioDaJanela(grupo.sangrias, { ate: sg.data, ignorarChave: sg.chave }));
      // a janela FECHA no fim do periodo que esta sangria declara ter levado,
      // nao no dia em que ela foi lancada (ver fimDoCiclo): o dinheiro que
      // entrou depois do periodo ainda esta na gaveta e e' da proxima
      const ate = fimDoCiclo(sg) || '';
      const naJanela = (x) => (x.data || '') > desde && (x.data || '') <= ate;
      const somar = (lista) => lista.reduce((t, x) => t + (naJanela(x) ? (Number(x.valor) || 0) : 0), 0);
      const entrou = somar(grupo.entradas);
      // sem entrada nenhuma na janela não há com o que bater - inclui sangria
      // anterior ao piso (janela vazia por definição). Melhor não afirmar nada
      // do que afirmar um número inventado.
      if (entrou <= 0) {
        sg.esperado = null; sg.divergencia = null; sg.temDivergencia = false;
        continue;
      }
      const esperado = +(entrou - somar(grupo.saidas)).toFixed(2);
      sg.esperado = esperado;
      sg.divergencia = +((Number(sg.valor) || 0) - esperado).toFixed(2);
      sg.temDivergencia = Math.abs(sg.divergencia) > sangrias.TOLERANCIA_DIVERGENCIA;
    }
  }
  return itens;
}

// DINHEIRO EM LOJA NA DATA DO FILTRO, pela mesma regua da conferencia: o que
// entrou menos o que saiu DESDE A ULTIMA RETIRADA de cada unidade, ate' o dia
// perguntado.
//
// DUAS COISAS QUE ESTE CARD NAO E', e ja foi:
//
// 1. Nao e' "entrada do periodo - saidas do periodo - sangrias do periodo".
//    Isso e' o saldo do FILTRO, nao dinheiro em loja: com o filtro no mes, uma
//    sangria do dia 2 que fechou o caixa de julho entrava contra a entrada de
//    agosto e o numero deixava de significar o que o rotulo promete. Por isso
//    a janela recomeca na ULTIMA RETIRADA, e nao no "De" do filtro.
//
// 2. Nao e' mais "sempre hoje". Ignorar o filtro de data fazia o painel se
//    contradizer: olhando agosto, as tres primeiras colunas falavam de agosto
//    e o card falava de hoje - R$ 170,00 numa tela onde nada somava 170. Pior,
//    afirmava um saldo que naquela data ainda nao existia (pedido do Master:
//    "ele so existe a partir do dia que entrou o dinheiro e nao foi feita a
//    sangria"). Agora `ate` fecha a janela no fim do periodo filtrado: sem
//    filtro, e' hoje; com filtro em agosto, e' quanto tinha na gaveta em 31/08.
//
// O corte de retirada usa o FIM DO CICLO (ateCiclo): sangria lancada depois do
// dia perguntado, mas declarando periodo que termina antes dele, ja tinha
// tirado aquele dinheiro da conta daquele dia.
//
// Devolve a conta ABERTA (desde/ate/entrou/saiu) porque um numero sozinho aqui
// nao da pra conferir: quando ele nao bate com a gaveta, o que resolve e' ver
// de quando ate' quando o sistema contou e o que ele viu no meio.
function dinheiroEmLoja(itens, entradas, { ate } = {}) {
  const corte = ate && /^\d{4}-\d{2}-\d{2}$/.test(ate) ? ate : null;
  const porUnidade = new Map();
  const alvo = (u, nome, grupo) => {
    if (!porUnidade.has(u)) porUnidade.set(u, { unidade: u, unidadeNome: nome || u, grupo: grupo || null, entradas: [], saidas: [], sangrias: [] });
    const g = porUnidade.get(u);
    if (nome && !g.unidadeNome) g.unidadeNome = nome;
    if (grupo && !g.grupo) g.grupo = grupo;
    return g;
  };
  entradas.forEach((e) => { if (e.unidade) alvo(e.unidade, e.unidadeNome, e.grupo).entradas.push(e); });
  itens.forEach((it) => {
    if (!it.unidade) return;
    const g = alvo(it.unidade, it.unidadeNome, it.grupo);
    (it.origem === 'sangria' ? g.sangrias : g.saidas).push(it);
  });

  const linhas = [];
  let total = 0;
  for (const g of porUnidade.values()) {
    const ultimaRetirada = inicioDaJanela(g.sangrias, { ateCiclo: corte });
    const desde = comPiso(ultimaRetirada);
    const naJanela = (x) => (x.data || '') > desde && (!corte || (x.data || '') <= corte);
    const somar = (lista) => lista.reduce((t, x) => t + (naJanela(x) ? (Number(x.valor) || 0) : 0), 0);
    const entrou = +somar(g.entradas).toFixed(2);
    const saiu = +somar(g.saidas).toFixed(2);
    // A janela agora SEMPRE existe (piso de agosto/2026), mas ha' dois jeitos
    // de nao ter numero honesto pra mostrar:
    //
    // - loja que ja fez retirada: apos a sangria a gaveta volta ao fundo fixo,
    //   entao "R$ 0,00 desde a retirada" e' verdade - mostra o numero.
    // - loja SEM NENHUMA retirada lancada e sem movimento de caixa desde o
    //   piso: o sistema nao viu dinheiro nenhum, e R$ 0,00 afirmaria gaveta
    //   vazia sem evidencia (§6: dado que nao existe nao vira numero). Essas
    //   ficam SEM BASE, fora do total, ate' o primeiro lancamento.
    //
    // O "desde sempre" que somou R$ 490 mil das lojas Bravo nao volta: o piso
    // corta tudo antes de 01/08/2026 por decisao explicita do Master.
    if (!ultimaRetirada && entrou <= 0 && saiu <= 0) {
      linhas.push({ unidade: g.unidade, unidadeNome: g.unidadeNome, grupo: g.grupo, desde: null, ate: corte, semBase: true, entrou: null, saiu: null, valor: null });
      continue;
    }
    const valor = +(entrou - saiu).toFixed(2);
    total += valor;
    linhas.push({ unidade: g.unidade, unidadeNome: g.unidadeNome, grupo: g.grupo, desde, ate: corte, semBase: false, entrou, saiu, valor });
  }
  linhas.sort((a, b) => String(a.unidadeNome || '').localeCompare(String(b.unidadeNome || ''), 'pt-BR'));
  // `ate` sobe junto pra tela poder dizer DE QUANDO e o numero. Um saldo de
  // 31/08 com cara de saldo de hoje e' pior que nao mostrar nada
  return { total: +total.toFixed(2), ate: corte, porUnidade: linhas };
}

// SALDO DE CAIXA DA UNIDADE - a conta que decide se a sangria bate.
//
// O fundo de caixa e' FIXO (decisao do Master): a loja sempre deixa o mesmo
// valor na gaveta. Isso faz o fundo se CANCELAR na conta - o que deveria
// estar sobrando pra retirar e' so o dinheiro que entrou e ainda nao saiu:
//
//   esperado retirar = entradas em dinheiro - saidas avulsas - sangrias ja feitas
//
// De proposito e' SALDO CORRIDO (tudo ate a data), nao uma janela por ciclo:
// fechamento lancado com atraso entra na proxima sangria em vez de cair num
// buraco entre dois periodos, e nao existe dia contado duas vezes quando o
// "De" de uma sangria repete o "Ate" da anterior (que e' como o formulario
// preenche). Nada de boundary pra errar.
//
// Nao custa leitura nova: as duas fontes ja sao as mesmas (e cacheadas) do
// resto do painel.
async function calcularSaldoCaixa({ unidade, ate, ignorarSangriaId }, extrasFechamentos = []) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  const limite = ate && /^\d{4}-\d{2}-\d{2}$/.test(ate) ? ate : null;
  const [itens, entradasTodas] = await Promise.all([
    listar(extrasFechamentos),
    listarEntradas(extrasFechamentos),
  ]);
  const daUnidade = (arr) => arr.filter((x) => x.unidade === unidade && (!limite || (x.data || '') <= limite));
  const somar = (arr) => arr.reduce((t, x) => t + (Number(x.valor) || 0), 0);

  const doPainel = daUnidade(itens).filter((it) => it.chave !== `sangria::${ignorarSangriaId}`);
  // saida avulsa que o Master moveu pra Sangria conta como sangria aqui
  // tambem - senao as duas telas contariam a mesma retirada de jeitos
  // diferentes (ver reclassificar)
  const sangriasDaUnidade = doPainel.filter((it) => it.origem === 'sangria');
  // MESMA janela que o painel usa na leitura (ver inicioDaJanela): o esperado
  // e' o que entrou desde a ULTIMA RETIRADA, nao o acumulado da loja desde
  // sempre. Os dois lugares tem que usar a mesma regua - com reguas
  // diferentes, o numero que o formulario sugere na hora nunca bateria com o
  // que o painel mostra depois.
  const retiradaAnterior = inicioDaJanela(sangriasDaUnidade, { ate: limite, ignorarChave: `sangria::${ignorarSangriaId}` });
  const desde = comPiso(retiradaAnterior);
  // a tela precisa saber se `desde` e' uma RETIRADA de verdade ou so o piso
  // de agosto/2026: "o dia 31/07 ja entrou na retirada anterior" seria
  // mentira, e e' o tipo de frase que faz procurar dinheiro que nao sumiu
  const desdeEhRetirada = !!retiradaAnterior && retiradaAnterior >= desde;
  const naJanela = (x) => (x.data || '') > desde;
  const entradas = daUnidade(entradasTodas).filter(naJanela);
  const totalEntradas = somar(entradas);
  const totalSaidas = somar(doPainel.filter((it) => it.origem === 'saida' && naJanela(it)));
  const totalSangrias = somar(sangriasDaUnidade.filter(naJanela));

  // ate quando o dinheiro esta contabilizado: se a loja ainda nao lancou o
  // fechamento de hoje, o dinheiro de hoje NAO esta no esperado - e isso
  // explica sozinho a maior parte das "sobras". Melhor dizer isso na tela do
  // que deixar a pessoa achar que achou dinheiro.
  const datas = entradas.map((e) => e.data).filter(Boolean).sort();
  const ultimoFechamentoEm = datas.length ? datas[datas.length - 1] : null;
  const diasSemFechamento = limite && ultimoFechamentoEm
    ? Math.max(0, Math.round((Date.parse(limite + 'T00:00:00Z') - Date.parse(ultimoFechamentoEm + 'T00:00:00Z')) / 86400000))
    : 0;

  // SEM BASE = nao entrou dinheiro nenhum dentro da janela: nao ha com o que
  // bater. A janela em si sempre existe agora - comeca na ultima retirada ou
  // no piso de agosto/2026 (comPiso), o que for mais recente. O "desde sempre"
  // que fez uma sangria de R$ 540 esperar R$ 19.745,52 nao volta: o piso e'
  // uma data de corte declarada pelo Master, nao um chute.
  const temBase = totalEntradas > 0;
  return {
    unidade,
    ate: limite,
    temBase,
    entradas: totalEntradas,
    saidas: totalSaidas,
    sangrias: totalSangrias,
    // sem as sangrias: a janela ja comeca DEPOIS da ultima retirada, entao
    // descontar de novo o que ja foi retirado tiraria o mesmo dinheiro duas
    // vezes. totalSangrias segue no retorno so como informacao da janela.
    esperado: temBase ? Number((totalEntradas - totalSaidas).toFixed(2)) : null,
    desde,
    desdeEhRetirada,
    ultimoFechamentoEm,
    diasSemFechamento,
  };
}

// mesmo formato de filtro usado em fechamentosFiltrados (index.js): unidades
// (array de codigos, vazio/null = todas), grupo (ARCFOOD|BRAVO, vazio =
// os dois), inicio/fim (AAAA-MM-DD, vazio = sem limite daquele lado)
function filtrar(itens, { unidades, grupo, inicio, fim } = {}) {
  const unidadesSet = unidades && unidades.length ? new Set(unidades) : null;
  return itens.filter((it) =>
    (!unidadesSet || unidadesSet.has(it.unidade)) &&
    (!grupo || it.grupo === grupo) &&
    (!inicio || (it.data || '') >= inicio) &&
    (!fim || (it.data || '') <= fim));
}

// so o Master move (decisao explicita do Master: "1 opcao e so o master ter
// acesso"). A chave e' sempre de saida avulsa - uma Sangria/Deposito de
// verdade (colecao propria) nao tem pra onde ir.
async function reclassificar(chave, { origem, porId, porEmail }, extrasFechamentos = []) {
  if (typeof chave !== 'string' || !chave) throw new Error('Chave inválida.');
  if (chave.startsWith('sangria::')) throw new Error('Sangria/Depósito lançada no app já está no lugar certo.');
  const partes = chave.split('::');
  const idx = Number(partes.pop());
  const fechamentoId = partes.join('::');
  const f = (await fechamentosLive.getOne(fechamentoId))
    || (Array.isArray(extrasFechamentos) ? extrasFechamentos : []).find((x) => x.id === fechamentoId)
    || null;
  if (!f || !Number.isInteger(idx) || !(f.detalhesSaidas || [])[idx]) {
    throw new Error('Saída não encontrada nesse fechamento.');
  }
  const r = await verificacoesSaida.reclassificar(chave, { origem, porId, porEmail });
  return { chave, origem: r.origemManual ? 'sangria' : 'saida', reclassificada: !!r.origemManual };
}

// Corrige uma saida que veio da PLANILHA. Nao ha documento pra editar (o
// fechamento importado vive so em memoria), entao a correcao fica ao lado do
// item, na mesma colecao da verificacao, e linhasDeFechamento aplica por
// cima. A planilha continua intacta.
async function corrigirItemPlanilha(chave, { descricao, valor, porId, porEmail }, extrasFechamentos = []) {
  if (typeof chave !== 'string' || !chave.includes('::')) throw new Error('Chave inválida.');
  const partes = chave.split('::');
  const idx = Number(partes.pop());
  const fechamentoId = partes.join('::');
  const f = (Array.isArray(extrasFechamentos) ? extrasFechamentos : []).find((x) => x.id === fechamentoId);
  if (!f || !Number.isInteger(idx) || !((f.detalhesSaidas || [])[idx])) {
    throw new Error('Saída não encontrada nesse lançamento.');
  }
  const r = await verificacoesSaida.corrigirItem(chave, { descricao, valor, porId, porEmail });
  return { chave, unidade: f.unidade, ...r };
}

// "tem o nome Sangria na descricao" - o caso da planilha antiga da ARCFOOD,
// onde a sangria virava uma linha de saida com esse texto. Sem acento/caixa,
// mesma tolerancia do resto do sistema.
function pareceSangria(item) {
  return item.origem === 'saida'
    && /sangria/i.test(String(item.descricao || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
}

// resolve a chave pra sangria (id proprio na colecao sangrias) ou pra saida
// avulsa (indice dentro de um fechamento) e despacha pro modulo dono -
// valida que a chave aponta pra algo que existe de verdade (sem isso,
// qualquer chave inventada criaria um registro orfao em
// verificacoesSaidasFechamento)
async function marcarVerificada(chave, { verificada, porId, porEmail }, extrasFechamentos = []) {
  if (typeof chave !== 'string' || !chave) throw new Error('Chave inválida.');
  if (chave.startsWith('sangria::')) {
    const id = chave.slice('sangria::'.length);
    const s = await sangrias.marcarVerificada(id, { verificada, porId, porEmail });
    return { chave, verificada: !!s.verificada, verificadaPorEmail: s.verificadaPorEmail || null, verificadaEm: s.verificadaEm || null };
  }
  const partes = chave.split('::');
  const idx = Number(partes.pop());
  const fechamentoId = partes.join('::');
  // o fechamento pode não estar no Firestore (fechamentosLive) - é o caso do
  // snapshot sincronizado da planilha ARCFOOD, que só existe em memória (ver
  // listar() acima) - cai pra ele antes de recusar como "não encontrado"
  const f = (await fechamentosLive.getOne(fechamentoId))
    || (Array.isArray(extrasFechamentos) ? extrasFechamentos : []).find((x) => x.id === fechamentoId)
    || null;
  if (!f || !Number.isInteger(idx) || !(f.detalhesSaidas || [])[idx]) {
    throw new Error('Saída não encontrada nesse fechamento.');
  }
  const r = await verificacoesSaida.marcar(chave, { verificada, porId, porEmail });
  return { chave, verificada: r.verificada, verificadaPorEmail: r.verificadaPorEmail, verificadaEm: r.verificadaEm };
}

module.exports = { listar, listarEntradas, dinheiroEmLoja, semDuplicataDaPlanilha, listarEntradasPorDia, calcularSaldoCaixa, filtrar, marcarVerificada, reclassificar, corrigirItemPlanilha, corrigirEntradaPlanilha, pareceSangria };

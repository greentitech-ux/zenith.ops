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
    // diferenca de caixa apurada NA HORA da sangria (ver sangrias.js). Fica
    // gravada no documento e nunca e' reescrita - e' registro historico do que
    // o sistema disse pra quem retirou o dinheiro (CLAUDE.md §1).
    // recalcularDivergencias() logo abaixo sobrescreve estes tres campos NA
    // LEITURA com a conta refeita sobre o dado de hoje, e guarda o valor da
    // hora em `esperadoNaHora`/`divergenciaNaHora`.
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
function semDuplicataDaPlanilha(doApp, daPlanilha) {
  if (!Array.isArray(daPlanilha) || !daPlanilha.length) return [];
  const noApp = new Set(doApp.map((f) => `${f.unidade}::${f.data}`));
  return daPlanilha.filter((f) => !noApp.has(`${f.unidade}::${f.data}`));
}

// AUTO-AJUSTE da conferencia de caixa. Pedido do Master: "se e editado precisa
// ter auto ajustes ... tudo precisa refletir".
//
// O problema concreto: `esperado` e `divergencia` sao calculados uma vez, no
// momento em que a sangria e' lancada, e ficam gravados no documento. Se
// depois alguem corrigir a entrada em dinheiro do dia, ou uma saida, ou o
// valor da propria sangria, aquele numero continua o mesmo - a tela passa a
// mostrar uma falta que ja nao existe (foi o que o Master viu: "FALTA
// R$ 946,23" num caixa que ja tinha sido acertado).
//
// Aqui a conta e' REFEITA na leitura, com a mesma regra do calcularSaldoCaixa:
//
//   esperado da sangria = entradas ate a data - saidas ate a data - sangrias anteriores
//
// Saldo CORRIDO, igual ao resto do modulo - nada de janela por periodo, entao
// nao existe dia contado duas vezes nem buraco entre dois ciclos.
//
// O valor da hora nao se perde: fica em esperadoNaHora/divergenciaNaHora, pra
// tela poder mostrar "na hora dizia X" quando os dois nao batem mais.
//
// Nao custa leitura nova: recebe as listas que o chamador ja tem em maos.
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
    // duas sangrias no mesmo dia: a segunda so pode esperar o que a primeira
    // deixou, entao desempata por criadoEm (a ordem em que foram feitas)
    grupo.sangrias.sort((a, b) => String(a.data || '').localeCompare(String(b.data || ''))
      || String(a.criadoEm || '').localeCompare(String(b.criadoEm || '')));
    const somaAte = (lista, ate) => lista.reduce((t, x) => t + ((x.data || '') <= ate ? (Number(x.valor) || 0) : 0), 0);
    let jaRetirado = 0;
    for (const sg of grupo.sangrias) {
      const base = somaAte(grupo.entradas, sg.data) - somaAte(grupo.saidas, sg.data);
      // SEM BASE = nenhuma entrada lancada ate aqui. Mesma decisao do
      // calcularSaldoCaixa (§6): falta de dado nao vira divergencia gigante -
      // sem base nao da pra dizer que a sangria "nao bateu".
      if (somaAte(grupo.entradas, sg.data) <= 0) {
        sg.esperado = null; sg.divergencia = null; sg.temDivergencia = false;
        jaRetirado += Number(sg.valor) || 0;
        continue;
      }
      const esperado = +(base - jaRetirado).toFixed(2);
      sg.esperado = esperado;
      sg.divergencia = +((Number(sg.valor) || 0) - esperado).toFixed(2);
      sg.temDivergencia = Math.abs(sg.divergencia) > sangrias.TOLERANCIA_DIVERGENCIA;
      jaRetirado += Number(sg.valor) || 0;
    }
  }
  return itens;
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
  // refaz esperado/divergencia sobre o dado de HOJE - sem isso, corrigir a
  // entrada ou a saida deixava a sangria acusando uma falta que ja nao existe
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

  const entradas = daUnidade(entradasTodas);
  const doPainel = daUnidade(itens).filter((it) => it.chave !== `sangria::${ignorarSangriaId}`);
  // saida avulsa que o Master moveu pra Sangria conta como sangria aqui
  // tambem - senao as duas telas contariam a mesma retirada de jeitos
  // diferentes (ver reclassificar)
  const totalEntradas = somar(entradas);
  const totalSaidas = somar(doPainel.filter((it) => it.origem === 'saida'));
  const totalSangrias = somar(doPainel.filter((it) => it.origem === 'sangria'));

  // ate quando o dinheiro esta contabilizado: se a loja ainda nao lancou o
  // fechamento de hoje, o dinheiro de hoje NAO esta no esperado - e isso
  // explica sozinho a maior parte das "sobras". Melhor dizer isso na tela do
  // que deixar a pessoa achar que achou dinheiro.
  const datas = entradas.map((e) => e.data).filter(Boolean).sort();
  const ultimoFechamentoEm = datas.length ? datas[datas.length - 1] : null;
  const diasSemFechamento = limite && ultimoFechamentoEm
    ? Math.max(0, Math.round((Date.parse(limite + 'T00:00:00Z') - Date.parse(ultimoFechamentoEm + 'T00:00:00Z')) / 86400000))
    : 0;

  // SEM BASE = nenhuma entrada em dinheiro lancada pra essa unidade ate aqui.
  // Nesse caso nao da pra dizer que a sangria "nao bateu": nao ha com o que
  // bater. Devolver esperado 0 transformaria falta de dado em divergencia
  // gigante e travaria a operacao (§6 - dado que nao existe nao vira numero).
  // Quem consome trata esperado null como "conferencia indisponivel".
  const temBase = totalEntradas > 0;
  return {
    unidade,
    ate: limite,
    temBase,
    entradas: totalEntradas,
    saidas: totalSaidas,
    sangrias: totalSangrias,
    esperado: temBase ? Number((totalEntradas - totalSaidas - totalSangrias).toFixed(2)) : null,
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

module.exports = { listar, listarEntradas, recalcularDivergencias, semDuplicataDaPlanilha, listarEntradasPorDia, calcularSaldoCaixa, filtrar, marcarVerificada, reclassificar, corrigirItemPlanilha, corrigirEntradaPlanilha, pareceSangria };

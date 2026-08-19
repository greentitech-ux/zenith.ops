// bravoImport.js
// Importa, DE UMA VEZ SÓ, o histórico da planilha aposentada do Grupo Bravo
// pra dentro do Firestore, como lançamento NATIVO - do mesmo formato do que
// a loja lança direto no app (ver fechamentosLive.create). Depois disto a
// planilha não é mais lida por nada (ver sheetsSync.js, que já não a
// sincroniza).
//
// Por que um módulo separado e não mais uma fonte no sheetsSync: aquilo ali
// é sincronização recorrente de UM formato de colunas. Aqui são 12 abas em
// 5 formatos diferentes, lidas UMA vez, e o resultado vira documento no
// banco - problema diferente, vida diferente.
//
// SEMPRE simule antes de gravar (ver simular/importar no fim do arquivo):
// 846 lançamentos gravados errado dão muito mais trabalho pra desfazer do
// que pra conferir antes.

const sheetsSync = require('./sheetsSync');
const grupos = require('./grupos');
const fechamentosLive = require('./fechamentosLive');

const { BRAVO_UNIDADES, SHEET_ID_BRAVO, parseMoneyBR, parseDataBravo } = sheetsSync;

// Linhas que NÃO entram, decididas caso a caso com o Master (19/08/2026).
// Filtro por ID (a coluna "ID" da planilha, única em toda ela) em vez de por
// unidade+data: assim é impossível derrubar a linha errada do mesmo dia.
const IDS_EXCLUIDOS = new Set([
  // Milky Moo Tirol 08/03/26: linha de teste da equipe (observação "teste val
  // equipe", descrição de saída batida no teclado, valores 50/50/50/50)
  '7fcda565',
  // Dominos Tirol 21/12/2025: versão ANTIGA do dia. Fica a f8902877, que se
  // identifica como "Correção de lançamentos" e fecha o caixa exato
  // (entrada 763,02 = depósito 600,00 + saída 163,02)
  '8cece1f2',
]);

// Colunas que existem na planilha e NÃO viram nada, de propósito:
// - Cancelados/Vendas Cancelados: o Master decidiu não trazer o histórico
//   ("iremos passar a cobrar e monitorar a partir de agora"). O KPI segue
//   cadastrado no grupo e passa a ser preenchido no lançamento do dia.
// - Total/Total Delivery com dado só na Campina Grande: mesma lógica - uma
//   loja com meio histórico de KPI e onze sem atrapalha qualquer comparação.
// - Assinatura/Assinatura Socio: campo de aceite, não é valor.
const COLUNAS_IGNORADAS = new Set([
  'ID', 'Nome', 'Unidade', 'Data', 'Observação', 'Cancelados', 'Vendas Cancelados',
  'Total', 'Assinatura', 'Assinatura Socio', 'EmailUnidade', 'Email Gerente', 'Email Loja',
]);

// Duas grafias pro mesmo campo entre o bloco Spoleto Shopping e o do
// Aeroporto. Em vez de pedir pro Master reeditar a planilha (que já vai ser
// jogada fora), normaliza aqui - senão o cadastro do grupo ficaria com dois
// campos quase iguais e a loja veria os dois na tela de lançamento.
const LABEL_CANONICO = {
  'Outras Formas de Pagamentos': 'Outras Formas de Pagamento',
  'Quantidade de Pedido': 'Quantidade de Pedidos',
};
function canonico(label) {
  return LABEL_CANONICO[label] || label;
}

// ---------------------------------------------------------------------
// Os 5 formatos de aba. "canais" é o lado SISTEMA (o que o PDV registrou
// como venda) e "formas" é o lado COMPROVANTE (o que foi declarado no
// caixa) - é o cruzamento dos dois que produz a diferença de caixa.
//
// Só a São Braz e as 5 Domino's têm os dois lados na planilha. Nas outras 6
// existe só um: a venda por forma de pagamento. Nelas, todo canal entra
// marcado com tambemNoOutroTotal (soma nos DOIS totais) MENOS o "Dinheiro",
// que fica de fora - assim o cartão/app se anula entre faturamento e
// declarado e sobra exatamente o par que essas lojas realmente conferem:
// Dinheiro (sistema) x Entrada Dinheiro (caixa). Sem isso a diferença
// dessas lojas seria ou o faturamento inteiro, ou zero fixo - as duas
// mentiras.
// ---------------------------------------------------------------------

// campo fixo do fechamento (ver CAMPOS_NUMERICOS em fechamentosLive.js) por
// nome de coluna - vale pros 5 formatos, cada aba usa o que tiver
const FIXOS_COMUNS = {
  'Caixa Inicial': 'caixaInicial',
  'Caixa Final': 'caixaFinal',
  'Entrada Dinheiro': 'entradaDinheiro',
  Deposito: 'deposito',
};

const MODELOS = {
  // Bessa, Caruaru, Tirol, Garanhuns, Campina Grande: canal de venda de
  // pizzaria (Delivery/Carryout/Pick-UP/Loja) - tudo cai em campo FIXO, não
  // precisa de campo extra nenhum no cadastro do grupo.
  dominos: {
    fixos: {
      ...FIXOS_COMUNS,
      Delivery: 'delivery',
      Carryout: 'carryout',
      'Pick-UP': 'pickup',
      Loja: 'loja',
      Ifood: 'ifood',
      'Pix CNPJ': 'pixCnpj',
      Outros: 'outros',
      // "AdyenV2" nas abas novas = o "Adyen" + o "Pix" das abas antigas
      // (conferido linha a linha: Bessa 29/11 -> 498,10 + 951,35 = 1.449,45).
      // Vai pro campo fixo "pix", que na tela se chama justamente "Adyen".
      AdyenV2: 'pix',
      Adyen: 'pix',
    },
    // a soma das maquininhas vira o campo "adyen" (na tela: "Maquininhas
    // (total)"). A coluna SomaMaq sumiu das abas reorganizadas, então o
    // total sai das colunas MaqBalcao/Maquina02..08 - que também viram
    // detalhesMaquinas, pra manter a abertura item a item.
    somarMaquininhas: true,
    canais: [],
    formas: [],
  },

  // São Braz: a única com os DOIS lados pareados (TEF* = sistema,
  // COMP.*/Dec. = comprovante). Não precisa de tambemNoOutroTotal: o
  // cruzamento acontece naturalmente.
  saobraz: {
    fixos: { ...FIXOS_COMUNS },
    canais: ['Dinheiro', 'Fora do Sistema', 'TEF Cred.', 'TEF Deb.', 'TEF Pix.', 'TEF Voucher', 'IFOOD'],
    formas: ['COMP. Cred.', 'COMP. Deb.', 'COMP. Pix', 'COMP. Voucher', 'Dec. IFOOD'],
    kpis: ['Quantidade de Pedidos'],
  },

  // Spoleto Shopping Recife e Tacaruna: layout idêntico entre si.
  spoletoShopping: {
    fixos: { ...FIXOS_COMUNS },
    canais: ['Dinheiro', 'TEF Credito', 'TEF Debito', 'Outras Formas de Pagamento', 'TEF Cartao Beneficio',
      'Getnet Credito', 'Getnet Debito', 'Getnet Pix', 'Getnet Voucher', 'IFOOD', '99FOOD', 'RAPPI'],
    formas: [],
    kpis: ['Quantidade de Pedido'],
    cruzarMenosDinheiro: true,
  },

  // As 3 do Aeroporto (Spoleto Praça, Dominos Praça, Carrinho): mesmo núcleo
  // de formas de pagamento + os vouchers de companhia aérea, que só existem
  // ali. Cada uma ainda tem uma ou outra coluna própria (ver COLUNAS_SO_DE,
  // aplicado por unidade em cima deste modelo).
  aeroporto: {
    fixos: { ...FIXOS_COMUNS },
    canais: ['Dinheiro', 'TEF Voucher', 'TEF Credito', 'TEF Debito', 'Outras Formas de Pagamentos',
      'Getnet Credito', 'Getnet Debito', 'Getnet Pix', 'Getnet Voucher',
      'VOUCHER LATAM', 'VOUCHER GOL', 'Consumo Socio'],
    formas: [],
    kpis: ['Quantidade de Pedidos'],
    cruzarMenosDinheiro: true,
  },

  // Milky Moo: sorveteria, formas de pagamento próprias.
  milkymoo: {
    fixos: { ...FIXOS_COMUNS },
    canais: ['Dinheiro', 'Visa Credito', 'Visa Debito', 'PIX/Outros Pos', 'Ticket', 'IFOOD Online', 'Outros'],
    formas: [],
    kpis: ['C Total Cupom', 'Numero de Entregas'],
    cruzarMenosDinheiro: true,
  },
};

// colunas que existem em UMA loja só, somadas por cima do modelo dela
const COLUNAS_SO_DE = {
  "Domino's Carrinho Aeroporto Recife": {
    // "SomaMaq" desta aba NÃO entra em lugar nenhum de propósito. Parece um
    // campo de maquininha, mas é um total informativo que se SOBREPÕE aos
    // canais: R$ 582.669,15 contra R$ 688.566,76 de canais sem o dinheiro -
    // não é subconjunto limpo de nada. Levá-lo pro campo "adyen" somava a
    // mesma venda duas vezes no Total Declarado (a simulação acusou
    // +R$ 576.147,97 de diferença nessa loja, ~77% do faturamento dela).
    // Os valores já vêm inteiros pelos canais.
    kpis: ['Calabresa', 'Mussarela', 'Pepperoni', 'Remake'],
  },
  'Spoleto Praça Aeroporto Recife': {
    fixos: { Quebra: 'quebra' },
    kpis: ['Vendas Sistema', 'Informado Pelo Gerente'],
  },
};

const UNIDADE_MODELO = {
  'Dominos Bessa': 'dominos',
  'Dominos Caruaru': 'dominos',
  'Dominos Tirol': 'dominos',
  'Dominos Garanhuns': 'dominos',
  'Dominos Campina Grande': 'dominos',
  'São Braz IL': 'saobraz',
  'Spoleto Shopping Recife': 'spoletoShopping',
  'Spoleto Shopping Tacaruna': 'spoletoShopping',
  'Spoleto Praça Aeroporto Recife': 'aeroporto',
  'Dominos Praça Aeroporto Recife': 'aeroporto',
  "Domino's Carrinho Aeroporto Recife": 'aeroporto',
  'Milky Moo Tirol': 'milkymoo',
};

function modeloDaUnidade(unidade) {
  const base = MODELOS[UNIDADE_MODELO[unidade]];
  if (!base) return null;
  const extra = COLUNAS_SO_DE[unidade];
  if (!extra) return base;
  return {
    ...base,
    fixos: { ...base.fixos, ...(extra.fixos || {}) },
    kpis: [...(base.kpis || []), ...(extra.kpis || [])],
  };
}

// pares [coluna do valor, coluna da descrição] das saídas de caixa - até 5,
// mesmo limite da planilha
const SAIDA_SLOTS = [
  ['Saida Dinheiro', 'Descricao Saida'], ['Saida Dinheiro 02', 'Descricao Saida 02'],
  ['Saida Dinheiro 03', 'Descricao Saida 03'], ['Saida Dinheiro 04', 'Descricao Saida 04'],
  ['Saida Dinheiro 05', 'Descricao Saida 05'],
];
function ehColunaMaquina(nome) {
  return nome === 'MaqBalcao' || /^Maquina\d+$/.test(nome);
}

// uma linha da planilha -> o payload que fechamentosLive.create espera
function linhaParaLancamento(header, linha, unidade) {
  const modelo = modeloDaUnidade(unidade);
  if (!modelo) return null;
  const get = (nome) => {
    const i = header.indexOf(nome);
    return i >= 0 ? linha[i] : undefined;
  };
  const valor = (nome) => parseMoneyBR(get(nome));

  const id = String(get('ID') || '').trim();
  if (!id || IDS_EXCLUIDOS.has(id)) return null;
  const data = parseDataBravo(get('Data'));
  if (!data) return null;

  const campos = {};
  Object.entries(modelo.fixos).forEach(([coluna, campo]) => {
    if (header.includes(coluna)) campos[campo] = valor(coluna);
  });

  // maquininhas: viram detalhe (abertura item a item) e o total vai pro
  // campo "adyen", como o lançamento do dia a dia faz
  const detalhesMaquinas = [];
  if (modelo.somarMaquininhas) {
    header.filter(ehColunaMaquina).forEach((coluna) => {
      const v = valor(coluna);
      if (v) detalhesMaquinas.push({ descricao: coluna, valor: v });
    });
    campos.adyen = +detalhesMaquinas.reduce((s, m) => s + m.valor, 0).toFixed(2);
  }

  const detalhesSaidas = [];
  SAIDA_SLOTS.forEach(([colValor, colDesc]) => {
    const v = valor(colValor);
    const d = String(get(colDesc) || '').trim();
    if (v || d) detalhesSaidas.push({ descricao: d, valor: v });
  });
  campos.totalSaida = +detalhesSaidas.reduce((s, x) => s + x.valor, 0).toFixed(2);

  const mapaExtras = (colunas) => {
    const out = {};
    (colunas || []).forEach((coluna) => {
      if (!header.includes(coluna)) return;
      out[grupos.slugify(canonico(coluna))] = valor(coluna);
    });
    return out;
  };

  return {
    unidade,
    unidadeNome: unidade,
    grupo: 'BRAVO',
    data,
    gerente: String(get('Nome') || '').trim(),
    campos,
    canaisVendaExtras: mapaExtras(modelo.canais),
    formasPagamentoExtras: mapaExtras(modelo.formas),
    kpisExtras: mapaExtras(modelo.kpis),
    observacao: String(get('Observação') || '').trim() || null,
    detalhesMaquinas,
    detalhesSaidas,
    // rastro de origem: dá pra achar (e desfazer) tudo que veio da planilha
    origemPlanilha: { sheetId: SHEET_ID_BRAVO, idLinha: id },
  };
}

// Definições que o CADASTRO DO GRUPO precisa ter pros valores importados
// somarem nos totais. Sem elas, recomputarTotais (fechamentosLive.js) não
// sabe que "tefCredito" é canal de venda e o faturamento sai zerado - por
// isso a importação confere isto ANTES de gravar qualquer coisa.
function definicoesDeCampos(unidade) {
  const modelo = modeloDaUnidade(unidade);
  if (!modelo) return { canais: [], formas: [], kpis: [] };
  const def = (label, extra) => ({ campo: grupos.slugify(canonico(label)), label: canonico(label), ...extra });
  return {
    canais: (modelo.canais || []).map((c) => def(c, {
      operacao: 'soma',
      // ver o comentário grande em MODELOS: nas lojas de um lado só, tudo
      // cruza pros dois totais MENOS o Dinheiro - o que sobra na diferença
      // é justamente Dinheiro x Entrada Dinheiro
      tambemNoOutroTotal: !!modelo.cruzarMenosDinheiro && c !== 'Dinheiro',
    })),
    formas: (modelo.formas || []).map((c) => def(c, { operacao: 'soma', tambemNoOutroTotal: false })),
    kpis: (modelo.kpis || []).map((c) => def(c, { tipo: 'quantidade', somaEm: 'nao' })),
  };
}

// lê as 12 abas da planilha aposentada e devolve os lançamentos já montados
async function lerPlanilha() {
  const token = await sheetsSync.getAccessToken();
  const abas = await sheetsSync.listarAbas(SHEET_ID_BRAVO, token);
  const lancamentos = [];
  const problemas = [];
  for (const aba of abas) {
    let valores;
    try {
      valores = await sheetsSync.buscarAba(SHEET_ID_BRAVO, aba);
    } catch (e) {
      problemas.push(`aba "${aba}": ${e.message}`);
      continue;
    }
    if (!valores.length) continue;
    const header = valores[0];
    const iUnidade = header.indexOf('Unidade');
    if (iUnidade < 0) continue; // aba que não é de fechamento (ex: "Gerentes")
    for (let i = 1; i < valores.length; i++) {
      const unidade = valores[i][iUnidade];
      // mesma trava da leitura antiga: linha cuja Unidade não é uma das 12
      // lojas não é fechamento (cabeçalho repetido, resumo, aba de apoio)
      if (!BRAVO_UNIDADES.has(unidade)) continue;
      const l = linhaParaLancamento(header, valores[i], unidade);
      if (l) lancamentos.push(l);
    }
  }
  return { lancamentos, problemas };
}

// soma o que CADA total vai receber, do mesmo jeito que recomputarTotais faz
// no fechamentosLive - serve pra simulação mostrar o número que vai aparecer
// na tela, não um número parecido
function totaisPrevistos(l) {
  const defs = definicoesDeCampos(l.unidade);
  const c = l.campos || {};
  const somaMapa = (mapa, defsLista, cruzado) => (defsLista || []).reduce((s, d) => {
    const v = Number((mapa || {})[d.campo]) || 0;
    if (cruzado && !d.tambemNoOutroTotal) return s;
    return s + (d.operacao === 'subtrai' ? -v : v);
  }, 0);
  const faturamento = (Number(c.delivery) || 0) + (Number(c.carryout) || 0) + (Number(c.pickup) || 0) + (Number(c.loja) || 0)
    + somaMapa(l.canaisVendaExtras, defs.canais)
    + somaMapa(l.formasPagamentoExtras, defs.formas, true);
  const totalDeclarado = (Number(c.adyen) || 0) + (Number(c.ifood) || 0) + (Number(c.food99) || 0)
    + (Number(c.pix) || 0) + (Number(c.pixCnpj) || 0) + (Number(c.outros) || 0) + (Number(c.entradaDinheiro) || 0)
    + somaMapa(l.formasPagamentoExtras, defs.formas)
    + somaMapa(l.canaisVendaExtras, defs.canais, true);
  return { faturamento: +faturamento.toFixed(2), totalDeclarado: +totalDeclarado.toFixed(2) };
}

// SIMULAÇÃO: lê a planilha, monta tudo e devolve o resumo - sem tocar no
// banco. É o passo obrigatório antes de importar.
async function simular() {
  const { lancamentos, problemas } = await lerPlanilha();
  const porUnidade = new Map();
  lancamentos.forEach((l) => {
    const t = totaisPrevistos(l);
    const atual = porUnidade.get(l.unidade) || { unidade: l.unidade, modelo: UNIDADE_MODELO[l.unidade], linhas: 0, faturamento: 0, totalDeclarado: 0, primeira: l.data, ultima: l.data };
    atual.linhas += 1;
    atual.faturamento = +(atual.faturamento + t.faturamento).toFixed(2);
    atual.totalDeclarado = +(atual.totalDeclarado + t.totalDeclarado).toFixed(2);
    if (l.data < atual.primeira) atual.primeira = l.data;
    if (l.data > atual.ultima) atual.ultima = l.data;
    porUnidade.set(l.unidade, atual);
  });

  // dia repetido pra mesma loja: o app não deixa dois fechamentos no mesmo
  // unidade+data (docId é unidade__data), então isso PRECISA aparecer antes
  const vistos = new Set();
  const duplicados = [];
  lancamentos.forEach((l) => {
    const chave = `${l.unidade}__${l.data}`;
    if (vistos.has(chave)) duplicados.push(chave); else vistos.add(chave);
  });

  const unidades = [...porUnidade.values()].sort((a, b) => b.faturamento - a.faturamento);
  return {
    total: lancamentos.length,
    faturamento: +unidades.reduce((s, u) => s + u.faturamento, 0).toFixed(2),
    totalDeclarado: +unidades.reduce((s, u) => s + u.totalDeclarado, 0).toFixed(2),
    unidades,
    duplicados,
    problemas,
    // o que o cadastro de grupo precisa ter pra esses valores somarem
    camposNecessarios: [...porUnidade.keys()].map((u) => ({ unidade: u, ...definicoesDeCampos(u) })),
  };
}

// PRÉ-REQUISITO da gravação. Os valores de canal/forma são gravados num mapa
// livre (canaisVendaExtras), e quem diz "tefCredito é canal de venda e soma
// no faturamento" é o CADASTRO DO GRUPO. Sem a definição lá, o valor entra
// no banco mas recomputarTotais não soma - as 7 lojas que não são Domino's
// apareceriam com faturamento R$ 0,00 e ninguém entenderia por quê.
// Por isso a importação confere isto ANTES e se recusa a gravar faltando.
async function conferirCampos() {
  const faltando = [];
  const porGrupo = new Map();
  for (const unidade of Object.keys(UNIDADE_MODELO)) {
    const grupo = await grupos.grupoDaUnidade(unidade);
    if (!grupo) { faltando.push({ unidade, erro: 'unidade não está em nenhum grupo' }); continue; }
    const precisa = definicoesDeCampos(unidade);
    const atual = porGrupo.get(grupo.id) || { grupo, canais: new Map(), formas: new Map(), kpis: new Map() };
    ['canais', 'formas', 'kpis'].forEach((qual) => {
      const chave = qual === 'canais' ? 'canaisVendaExtras' : qual === 'formas' ? 'formasPagamentoExtras' : 'kpisExtras';
      const jaTem = new Set((grupo[chave] || []).map((d) => d.campo));
      precisa[qual].forEach((d) => { if (!jaTem.has(d.campo)) atual[qual].set(d.campo, d); });
    });
    porGrupo.set(grupo.id, atual);
  }
  const pendentes = [...porGrupo.values()]
    .map((g) => ({
      grupoId: g.grupo.id, grupoNome: g.grupo.nome,
      canais: [...g.canais.values()], formas: [...g.formas.values()], kpis: [...g.kpis.values()],
    }))
    .filter((g) => g.canais.length || g.formas.length || g.kpis.length);
  return { pendentes, faltando };
}

// Acrescenta no cadastro do grupo só o que falta, PRESERVANDO o que já está
// lá (e a ordem que o Master escolheu). Nunca remove nem reordena: se ele
// arrumou os KPI's a mão, não é a importação que vai desmanchar.
async function cadastrarCampos() {
  const { pendentes, faltando } = await conferirCampos();
  const feitos = [];
  for (const p of pendentes) {
    const lista = await grupos.list();
    const g = lista.find((x) => x.id === p.grupoId);
    if (!g) continue;
    await grupos.update(p.grupoId, {
      canaisVendaExtras: [...(g.canaisVendaExtras || []), ...p.canais],
      formasPagamentoExtras: [...(g.formasPagamentoExtras || []), ...p.formas],
      kpisExtras: [...(g.kpisExtras || []), ...p.kpis],
    });
    feitos.push({ grupo: p.grupoNome, canais: p.canais.length, formas: p.formas.length, kpis: p.kpis.length });
  }
  return { feitos, faltando };
}

// GRAVAÇÃO. Exige a palavra de confirmação de propósito: é a única função
// deste arquivo que escreve, e escreve 844 documentos de uma vez.
//
// Idempotente por construção: fechamentosLive.create recusa dia que já
// existe pra aquela unidade (o id do documento é unidade__data), então rodar
// duas vezes NÃO duplica - a segunda volta com tudo em "jaExistiam". Isso
// também é a rede de proteção se a importação cair no meio: é só rodar de
// novo que ela continua de onde parou.
//
// Não usa lote (batch) de propósito: create() calcula o desconto da venda
// pós-meia-noite lendo o dia anterior e recalcula os totais com o cadastro
// do grupo. Passar por fora disso pra ganhar velocidade produziria registro
// diferente do que a loja produz lançando na mão - que é exatamente o que
// esta migração existe pra evitar.
async function importar({ confirmar } = {}) {
  if (confirmar !== 'GRAVAR') {
    throw new Error('Importação não confirmada. Rode a simulação, confira os totais e mande confirmar: "GRAVAR".');
  }
  const { pendentes } = await conferirCampos();
  if (pendentes.length) {
    const resumo = pendentes.map((p) => `${p.grupoNome} (${p.canais.length + p.formas.length + p.kpis.length} campo(s))`).join(', ');
    throw new Error(`Falta cadastrar campo no grupo antes de importar: ${resumo}. Rode a ação "cadastrar-campos" primeiro - sem isso o faturamento dessas lojas entraria zerado.`);
  }
  const { lancamentos, problemas } = await lerPlanilha();
  const resultado = { gravados: 0, jaExistiam: [], erros: [], problemas };
  for (const l of lancamentos) {
    try {
      await fechamentosLive.create({
        ...l,
        criadoPorId: null,
        criadoPorEmail: 'importação da planilha (Grupo Bravo)',
      });
      resultado.gravados += 1;
    } catch (e) {
      if (/[Jj]á existe/.test(e.message)) resultado.jaExistiam.push(`${l.unidade} ${l.data}`);
      else resultado.erros.push({ unidade: l.unidade, data: l.data, erro: e.message });
    }
  }
  return resultado;
}

module.exports = {
  simular, importar, conferirCampos, cadastrarCampos, lerPlanilha, linhaParaLancamento, definicoesDeCampos, totaisPrevistos,
  MODELOS, UNIDADE_MODELO, IDS_EXCLUIDOS, COLUNAS_IGNORADAS,
};

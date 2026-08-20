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
const bravoMapa = require('./bravoMapa');
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
// Comparação de nome de COLUNA sem acento/caixa/pontuação. A leitura usava
// header.indexOf(nome), que é exato: "UNIDADE", "Unidade " (espaço no fim) ou
// "Pick-Up" no lugar de "Pick-UP" faziam a coluna inteira sumir sem aviso.
function chaveCol(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ').trim().toLowerCase();
}
function indiceDaColuna(header, nome) {
  const alvo = chaveCol(nome);
  if (!alvo) return -1;
  for (let i = 0; i < header.length; i++) {
    if (chaveCol(header[i]) === alvo) return i;
  }
  return -1;
}

// Onde está a linha de cabeçalho. Era assumido valores[0] - mas aba
// reorganizada costuma ganhar título/linha em branco em cima, e aí a linha 1
// não é o cabeçalho. Quando isso acontecia a aba INTEIRA era pulada, em
// silêncio e sem entrar em lugar nenhum do diagnóstico: exatamente o buraco
// que escondeu o sumiço das Domino's.
//
// Procura nas primeiras linhas a que tem uma célula "Unidade" (ou um apelido
// comum dela). Limitado a 10 linhas pra não confundir dado com cabeçalho.
const APELIDOS_UNIDADE = ['unidade', 'loja', 'unidade loja', 'nome da loja', 'unidade da loja'];
function acharCabecalho(valores) {
  const limite = Math.min(valores.length, 10);
  for (let i = 0; i < limite; i++) {
    const linha = valores[i] || [];
    for (let c = 0; c < linha.length; c++) {
      if (APELIDOS_UNIDADE.includes(chaveCol(linha[c]))) {
        return { linhaCabecalho: i, header: linha, iUnidade: c };
      }
    }
  }
  return null;
}

// Data: a planilha foi reorganizada aba a aba ao longo de meses e nem todas
// ficaram no mesmo formato. O parser do sync (parseDataBravo) só entende
// DD/MM/AAAA - qualquer outra coisa virava linha descartada em silêncio, que é
// a principal suspeita do sumiço do histórico de dezembro/2025 em diante.
// Aqui a leitura aceita o que o Google Sheets costuma devolver:
//   28/11/2025 · 28/11/25 · 28-11-2025 · 2025-11-28 · 28.11.2025
//   45989 (número de série do Sheets, quando a célula é data de verdade)
// Só isso: nada de adivinhar mês por extenso ou inverter dia/mês, que geraria
// lançamento na data errada - erro pior que a linha faltando.
const SERIE_SHEETS_EPOCH = Date.UTC(1899, 11, 30); // dia 0 do Sheets
function parseDataBravoTolerante(bruto) {
  const cru = String(bruto ?? '').trim();
  if (!cru) return null;

  // já no formato do banco
  const iso = cru.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return cru;

  // DD/MM/AAAA, DD-MM-AAAA, DD.MM.AAAA (e com ano de 2 dígitos)
  const br = cru.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2}|\d{4})$/);
  if (br) {
    const [, dd, mm, yy] = br;
    const ano = yy.length === 2 ? `20${yy}` : yy;
    const d = Number(dd); const m = Number(mm);
    if (d < 1 || d > 31 || m < 1 || m > 12) return null;
    return `${ano}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  // número de série do Sheets (célula formatada como data)
  if (/^\d{4,6}$/.test(cru)) {
    const n = Number(cru);
    // 40000 ≈ 2009, 60000 ≈ 2064 - fora disso é código, não data
    if (n >= 40000 && n <= 60000) {
      const d = new Date(SERIE_SHEETS_EPOCH + n * 86400000);
      return d.toISOString().slice(0, 10);
    }
  }
  return null;
}

// Avalia UMA linha da planilha. Devolve { lancamento } quando dá certo, ou
// { motivo, amostra } quando a linha não vira fechamento. Existe separada de
// linhaParaLancamento porque o "return null" silencioso era exatamente o
// problema: 8 lojas ficaram sem histórico e não havia como saber por quê -
// a linha era descartada sem deixar rastro nenhum. Agora todo descarte é
// contado e mostrado no passo 1 (Conferir).
function avaliarLinha(header, linha, unidade, mapa = {}) {
  const modelo = modeloDaUnidade(unidade);
  if (!modelo) return { motivo: 'loja sem modelo de colunas cadastrado', amostra: unidade };
  const get = (nome) => {
    const i = indiceDaColuna(header, nome);
    return i >= 0 ? linha[i] : undefined;
  };
  const temColuna = (nome) => indiceDaColuna(header, nome) >= 0;
  const valor = (nome) => parseMoneyBR(get(nome));

  const id = String(get('ID') || '').trim();
  if (IDS_EXCLUIDOS.has(id)) return { motivo: 'ID na lista de exclusão (linha de teste/versão antiga)', amostra: id };

  const data = parseDataBravoTolerante(get('Data'));
  if (!data) {
    const bruta = String(get('Data') ?? '');
    return {
      motivo: temColuna('Data') ? 'Data em formato que o importador não lê' : 'aba sem coluna "Data"',
      amostra: bruta ? `"${bruta}"` : '(vazia)',
    };
  }
  // ID vazio NÃO derruba mais a linha: nas abas reorganizadas à mão ele
  // frequentemente não foi preenchido, e recusar por causa disso jogava fora
  // o fechamento inteiro. O ID só serve pro rastro de origem e pra lista de
  // exclusão - sem ele a linha continua valendo, identificada por loja+data.
  const idEfetivo = id || `sem-id:${unidade}:${data}`;

  const campos = {};
  Object.entries(modelo.fixos).forEach(([coluna, campo]) => {
    if (temColuna(coluna)) campos[campo] = valor(coluna);
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
      if (!temColuna(coluna)) return;
      out[grupos.slugify(canonico(coluna))] = valor(coluna);
    });
    return out;
  };

  // Decisões do Master (bravoMapa) por cima do que o modelo fixo já cobre.
  // É isto que faz uma coluna renomeada na planilha continuar caindo no campo
  // certo do Zenith sem precisar de deploy: "unificar" manda o valor pro campo
  // que já existe, "criar" abre um campo novo, "ignorar" descarta de propósito.
  const doMapa = { canal: {}, forma: {}, kpi: {} };
  header.forEach((coluna) => {
    const nome = String(coluna || '').trim();
    if (!nome) return;
    const d = mapa[bravoMapa.chaveColuna(nome)];
    if (!d || d.acao === 'ignorar' || !doMapa[d.destino]) return;
    const campo = d.acao === 'unificar' ? d.campo : grupos.slugify(canonico(d.label || nome));
    if (!campo) return;
    // soma quando duas colunas diferentes foram unificadas no MESMO campo
    doMapa[d.destino][campo] = +((doMapa[d.destino][campo] || 0) + valor(nome)).toFixed(2);
  });
  const juntarExtras = (doModelo, doMapaLista) => {
    const out = { ...doModelo };
    Object.entries(doMapaLista).forEach(([campo, v]) => {
      out[campo] = +((out[campo] || 0) + v).toFixed(2);
    });
    return out;
  };

  return { lancamento: {
    unidade,
    unidadeNome: unidade,
    grupo: 'BRAVO',
    data,
    gerente: String(get('Nome') || '').trim(),
    campos,
    canaisVendaExtras: juntarExtras(mapaExtras(modelo.canais), doMapa.canal),
    formasPagamentoExtras: juntarExtras(mapaExtras(modelo.formas), doMapa.forma),
    kpisExtras: juntarExtras(mapaExtras(modelo.kpis), doMapa.kpi),
    observacao: String(get('Observação') || '').trim() || null,
    detalhesMaquinas,
    detalhesSaidas,
    // rastro de origem: dá pra achar (e desfazer) tudo que veio da planilha
    origemPlanilha: { sheetId: SHEET_ID_BRAVO, idLinha: idEfetivo, semIdNaPlanilha: !id },
  } };
}

// wrapper antigo (usado fora daqui): só o lançamento, ou null
function linhaParaLancamento(header, linha, unidade, mapa = {}) {
  const r = avaliarLinha(header, linha, unidade, mapa);
  return r.lancamento || null;
}

// Definições que o CADASTRO DO GRUPO precisa ter pros valores importados
// somarem nos totais. Sem elas, recomputarTotais (fechamentosLive.js) não
// sabe que "tefCredito" é canal de venda e o faturamento sai zerado - por
// isso a importação confere isto ANTES de gravar qualquer coisa.
function definicoesDeCampos(unidade, mapa = {}) {
  const modelo = modeloDaUnidade(unidade);
  if (!modelo) return { canais: [], formas: [], kpis: [] };
  const def = (label, extra) => ({ campo: grupos.slugify(canonico(label)), label: canonico(label), ...extra });

  // colunas que o Master mandou CRIAR na tela de conferência (bravoMapa).
  // "unificar" não entra aqui de propósito: unificar aponta pra um campo que
  // JÁ existe no grupo, então não há nada pra cadastrar.
  const doMapa = { canal: [], forma: [], kpi: [] };
  Object.values(mapa || {}).forEach((d) => {
    if (!d || d.acao !== 'criar' || !doMapa[d.destino]) return;
    const label = canonico(d.label || d.coluna);
    doMapa[d.destino].push({ campo: grupos.slugify(label), label });
  });

  const base = {
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

  // junta sem duplicar: se a coluna já estava no modelo, o modelo manda (ele
  // carrega o tambemNoOutroTotal, que a decisão de tela não tem como saber)
  const juntar = (lista, novos, extra) => {
    const vistos = new Set(lista.map((d) => d.campo));
    return lista.concat(novos.filter((d) => !vistos.has(d.campo)).map((d) => ({ ...d, ...extra })));
  };
  return {
    canais: juntar(base.canais, doMapa.canal, { operacao: 'soma', tambemNoOutroTotal: false }),
    formas: juntar(base.formas, doMapa.forma, { operacao: 'soma', tambemNoOutroTotal: false }),
    kpis: juntar(base.kpis, doMapa.kpi, { tipo: 'quantidade', somaEm: 'nao' }),
  };
}

// Campos FIXOS que NAO podem ser somados quando o mesmo dia+loja aparece em
// mais de uma linha da planilha. Sao saldos/posicoes de caixa, nao movimentos:
// somar o "Caixa Inicial" de duas linhas do mesmo dia inventa dinheiro que
// nunca existiu. Esses tres vem sempre da linha principal (o fechamento de
// verdade). Mesma regra que a ARCFOOD ja usa - ver CAMPOS_SOMA e o comentario
// em mesclarLancamentosDoMesmoDia (sheetsSync.js).
const CAMPOS_QUE_NAO_SOMAM = new Set(['caixaInicial', 'caixaFinal', 'deposito']);

function somarMapas(mapas) {
  const out = {};
  mapas.forEach((m) => {
    Object.entries(m || {}).forEach(([k, v]) => { out[k] = +((out[k] || 0) + (Number(v) || 0)).toFixed(2); });
  });
  return out;
}

// A planilha permite MAIS DE UMA LINHA pro mesmo dia+loja - o caso comum e a
// sangria/retirada lancada separado do fechamento, e o turno lancado em duas
// partes. O fechamentosLive.create() recusa a segunda linha ("Já existe um
// fechamento..."), entao sem juntar aqui essas linhas simplesmente sumiam:
// a importacao dizia "jaExistiam" e o dia entrava no sistema com so um pedaco
// do faturamento. Era exatamente o que a tela mostrava - lojas com R$70-120 mil
// onde deviam ter centenas de milhares.
//
// A ARCFOOD nunca teve esse problema porque a sincronizacao dela ja passava
// por mesclarLancamentosDoMesmoDia (sheetsSync.js). Aqui e a mesma ideia, so
// que no formato aninhado do importador ({campos, canaisVendaExtras,
// formasPagamentoExtras, kpisExtras, detalhes...}) em vez do formato plano do
// snapshot - por isso nao da pra reaproveitar aquela funcao direto.
function mesclarPorDia(lancamentos) {
  const porChave = new Map();
  lancamentos.forEach((l) => {
    const chave = `${l.unidade}__${l.data}`;
    if (!porChave.has(chave)) porChave.set(chave, []);
    porChave.get(chave).push(l);
  });

  const resultado = [];
  let mesclados = 0;
  let linhasAbsorvidas = 0;
  for (const linhas of porChave.values()) {
    if (linhas.length === 1) { resultado.push(linhas[0]); continue; }
    mesclados += 1;
    linhasAbsorvidas += linhas.length - 1;

    // a linha "principal" e a de maior faturamento previsto (o fechamento de
    // verdade); a linha de sangria tem faturamento zerado e so a saida
    // preenchida, entao ela nunca vence essa disputa
    const principal = linhas.reduce((a, b) => (totaisPrevistos(b).faturamento > totaisPrevistos(a).faturamento ? b : a));

    // parte da linha principal (que ja traz Caixa Inicial/Final e Deposito
    // corretos) e soma por cima so o que as OUTRAS linhas movimentaram
    const campos = { ...(principal.campos || {}) };
    linhas.forEach((l) => {
      if (l === principal) return;
      Object.entries(l.campos || {}).forEach(([c, v]) => {
        if (CAMPOS_QUE_NAO_SOMAM.has(c)) return;
        campos[c] = +((campos[c] || 0) + (Number(v) || 0)).toFixed(2);
      });
    });

    resultado.push({
      ...principal,
      campos,
      canaisVendaExtras: somarMapas(linhas.map((l) => l.canaisVendaExtras)),
      formasPagamentoExtras: somarMapas(linhas.map((l) => l.formasPagamentoExtras)),
      kpisExtras: somarMapas(linhas.map((l) => l.kpisExtras)),
      // detalhes sao listas: concatenar mantem a abertura item a item batendo
      // com os totais somados acima (adyen vem de detalhesMaquinas,
      // totalSaida de detalhesSaidas)
      detalhesMaquinas: linhas.flatMap((l) => l.detalhesMaquinas || []),
      detalhesSaidas: linhas.flatMap((l) => l.detalhesSaidas || []),
      observacao: linhas.map((l) => l.observacao).filter(Boolean).join(' · ') || null,
      origemPlanilha: {
        ...principal.origemPlanilha,
        // guarda o ID de TODAS as linhas que entraram, nao so o da principal -
        // sem isso o rastro de origem some pras linhas absorvidas
        idsLinhas: linhas.map((l) => l.origemPlanilha && l.origemPlanilha.idLinha).filter(Boolean),
      },
    });
  }
  return { lancamentos: resultado, mesclados, linhasAbsorvidas };
}

// lê as 12 abas da planilha aposentada e devolve os lançamentos já montados
// Reconhece a loja mesmo que a célula "Unidade" tenha vindo com acento,
// caixa ou espaço diferentes do cadastro (ex: "DOMINOS BESSA", "Dominos
// Bessa ", "Sao Braz IL"). Antes a comparação era exata e qualquer diferença
// invisível derrubava a linha em silêncio. Devolve SEMPRE o nome canônico -
// é ele que vira o código da unidade, então normalizar aqui evita criar
// unidade duplicada no sistema.
const BRAVO_POR_NOME_NORMALIZADO = new Map(
  [...BRAVO_UNIDADES].map((nome) => [normalizarNome(nome), nome]),
);
function normalizarNome(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ').trim().toLowerCase();
}
function resolverUnidade(bruto) {
  if (BRAVO_UNIDADES.has(bruto)) return bruto;
  return BRAVO_POR_NOME_NORMALIZADO.get(normalizarNome(bruto)) || null;
}

// ---------------------------------------------------------------------------
// Conferência de COLUNAS: o que a planilha tem x o que o Zenith já conhece
// ---------------------------------------------------------------------------
// Colunas que nunca viram campo: são estrutura da linha, não valor de venda.
const COLUNAS_ESTRUTURAIS = new Set(['ID', 'Unidade', 'Data', 'Nome', 'Observação', 'Observacao']);

// Semelhança entre dois nomes de coluna pelo coeficiente de Dice sobre bigramas
// (0 = nada a ver, 1 = idêntico). Escolhido por ser estável e sem dependência:
// pega "TEF Credito" x "TEF Crédito" (1.0 depois de normalizar), "Getnet Pix" x
// "Pix Getnet" (alto) e "Dinheiro" x "Delivery" (baixo).
function bigramas(s) {
  const t = ` ${s} `;
  const out = new Map();
  for (let i = 0; i < t.length - 1; i++) {
    const b = t.slice(i, i + 2);
    out.set(b, (out.get(b) || 0) + 1);
  }
  return out;
}
function semelhanca(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigramas(a); const B = bigramas(b);
  let comuns = 0; let totalA = 0; let totalB = 0;
  A.forEach((n) => { totalA += n; });
  B.forEach((n) => { totalB += n; });
  A.forEach((n, bi) => { comuns += Math.min(n, B.get(bi) || 0); });
  return (2 * comuns) / (totalA + totalB);
}
// abaixo disto a sugestão é ruim demais pra valer a pena perguntar - vira
// "criar novo" direto. Acima, o Master decide.
const LIMIAR_PARECIDA = 0.62;

// palpite do tipo de campo, só pra pré-selecionar o rádio na tela - o Master
// muda com um clique se errar
const PISTAS_KPI = /(quantidade|numero|n[uú]mero|cupom|tempo|entregas|pedidos?)/i;
const PISTAS_FORMA = /^(comp\.|dec\.|declarad)/i;
function palpiteDestino(label) {
  if (PISTAS_FORMA.test(label)) return 'forma';
  if (PISTAS_KPI.test(label)) return 'kpi';
  return 'canal';
}

// Lê a planilha e devolve, POR COLUNA, o que fazer com ela. É o que alimenta a
// tela de aprovação: nada aqui grava nada.
async function analisarColunas() {
  const token = await sheetsSync.getAccessToken();
  const abas = await sheetsSync.listarAbas(SHEET_ID_BRAVO, token);
  const decisoes = await bravoMapa.obter();

  // colunas que APARECEM na planilha, com onde e quantas linhas têm valor
  const vistas = new Map(); // chave -> { coluna, unidades:Set, abas:Set, comValor }

  for (const aba of abas) {
    let valores;
    try { valores = await sheetsSync.buscarAba(SHEET_ID_BRAVO, aba); } catch (e) { continue; }
    if (!valores.length) continue;
    const cab = acharCabecalho(valores);
    if (!cab) continue;
    const { header, iUnidade, linhaCabecalho } = cab;

    header.forEach((coluna, iCol) => {
      const nome = String(coluna || '').trim();
      if (!nome || COLUNAS_ESTRUTURAIS.has(nome)) return;
      if (COLUNAS_IGNORADAS.has(nome)) return;
      if (ehColunaMaquina(nome)) return;         // vira detalhe de maquininha
      if (SAIDA_SLOTS.some(([v, d]) => v === nome || d === nome)) return; // vira detalhe de saída

      const chave = bravoMapa.chaveColuna(nome);
      const at = vistas.get(chave) || { coluna: nome, unidades: new Set(), abas: new Set(), comValor: 0 };
      at.abas.add(aba);
      for (let i = linhaCabecalho + 1; i < valores.length; i++) {
        const u = resolverUnidade(valores[i][iUnidade]);
        if (!u) continue;
        at.unidades.add(u);
        if (parseMoneyBR(valores[i][iCol])) at.comValor += 1;
      }
      vistas.set(chave, at);
    });
  }

  // o que o Zenith já conhece, pra cada grupo que tem loja do Bravo
  // grupos.js exporta list(), nao listar() - ver module.exports la
  const todosGrupos = await grupos.list();
  const conhecidos = []; // { campo, label, destino, grupoNome }
  const vistoCampo = new Set();
  todosGrupos.forEach((g) => {
    [['canaisVendaExtras', 'canal'], ['formasPagamentoExtras', 'forma'], ['kpisExtras', 'kpi']]
      .forEach(([lista, destino]) => {
        (g[lista] || []).forEach((c) => {
          const id = `${destino}:${c.campo}`;
          if (vistoCampo.has(id)) return;
          vistoCampo.add(id);
          conhecidos.push({ campo: c.campo, label: c.label || c.campo, destino, grupoNome: g.nome || g.id });
        });
      });
  });

  // e o que os MODELOS fixos já cobrem (essas não precisam de decisão nenhuma)
  const cobertasPorModelo = new Set();
  Object.values(MODELOS).forEach((m) => {
    Object.keys(m.fixos || {}).forEach((c) => cobertasPorModelo.add(bravoMapa.chaveColuna(c)));
    [...(m.canais || []), ...(m.formas || []), ...(m.kpis || [])]
      .forEach((c) => cobertasPorModelo.add(bravoMapa.chaveColuna(canonico(c))));
  });

  const jaResolvidas = [];
  const paraDecidir = [];
  for (const [chave, v] of vistas) {
    const base = {
      coluna: v.coluna,
      abas: [...v.abas],
      unidades: [...v.unidades],
      linhasComValor: v.comValor,
    };

    if (decisoes[chave]) { jaResolvidas.push({ ...base, ...decisoes[chave], origem: 'decidida pelo Master' }); continue; }
    if (cobertasPorModelo.has(chave)) { jaResolvidas.push({ ...base, acao: 'ja-existe', origem: 'já mapeada no importador' }); continue; }

    // procura o campo existente mais parecido
    let melhor = null;
    conhecidos.forEach((c) => {
      const nota = semelhanca(chave, bravoMapa.chaveColuna(c.label));
      if (!melhor || nota > melhor.nota) melhor = { ...c, nota: +nota.toFixed(3) };
    });

    if (melhor && melhor.nota === 1) {
      jaResolvidas.push({ ...base, acao: 'ja-existe', campo: melhor.campo, origem: `igual a "${melhor.label}"` });
      continue;
    }
    paraDecidir.push({
      ...base,
      sugestao: melhor && melhor.nota >= LIMIAR_PARECIDA ? melhor : null,
      acaoSugerida: melhor && melhor.nota >= LIMIAR_PARECIDA ? 'unificar' : 'criar',
      destinoSugerido: palpiteDestino(v.coluna),
    });
  }

  // primeiro as que mais aparecem com valor - são as que mais doem se ficarem de fora
  paraDecidir.sort((a, b) => b.linhasComValor - a.linhasComValor);
  jaResolvidas.sort((a, b) => b.linhasComValor - a.linhasComValor);
  return { paraDecidir, jaResolvidas, camposConhecidos: conhecidos };
}

// Cache da leitura da planilha. Sem isto, gravar loja por loja ficava MAIS
// lento que gravar tudo de uma vez: cada uma das 12 chamadas relia as 12 abas
// pela API do Sheets antes de filtrar a loja - 144 leituras remotas no total.
// Cada request estourava o tempo e o navegador devolvia "Failed to fetch" nas
// 12. Agora a planilha e lida UMA vez e as outras 11 chamadas reaproveitam.
// TTL curto o suficiente pra ninguem trabalhar em cima de dado velho, e
// invalidado na mao quando as decisoes de coluna mudam (ver a rota).
let leituraCache = { valor: null, expiraEm: 0 };
const LEITURA_TTL_MS = 15 * 60 * 1000;
function invalidarLeitura() { leituraCache = { valor: null, expiraEm: 0 }; }

async function lerPlanilhaCacheada() {
  if (leituraCache.valor && Date.now() < leituraCache.expiraEm) return leituraCache.valor;
  const valor = await lerPlanilha();
  leituraCache = { valor, expiraEm: Date.now() + LEITURA_TTL_MS };
  return valor;
}

async function lerPlanilha() {
  const token = await sheetsSync.getAccessToken();
  const abas = await sheetsSync.listarAbas(SHEET_ID_BRAVO, token);
  const mapa = await bravoMapa.obter();
  const lancamentos = [];
  const problemas = [];
  // Contabilidade de tudo que NÃO virou fechamento. Sem isto, uma linha
  // descartada some sem deixar rastro - foi o que escondeu, por dias, o
  // motivo de 8 lojas ficarem sem histórico.
  const abasLidas = [];          // TODA aba entra aqui, lida ou não
  const descartes = new Map();   // "aba · motivo" -> { aba, motivo, total, exemplos[] }
  const desconhecidas = new Map(); // nome cru da célula Unidade -> { nome, total, abas:Set }
  const registrar = (aba, motivo, amostra) => {
    const chave = `${aba} · ${motivo}`;
    const atual = descartes.get(chave) || { aba, motivo, total: 0, exemplos: [] };
    atual.total += 1;
    if (amostra && atual.exemplos.length < 3) atual.exemplos.push(String(amostra).slice(0, 60));
    descartes.set(chave, atual);
  };

  for (const aba of abas) {
    let valores;
    try {
      valores = await sheetsSync.buscarAba(SHEET_ID_BRAVO, aba);
    } catch (e) {
      problemas.push(`aba "${aba}": ${e.message}`);
      continue;
    }
    if (!valores.length) { abasLidas.push({ aba, status: 'vazia', lancamentos: 0 }); continue; }

    const cab = acharCabecalho(valores);
    if (!cab) {
      // Aba de apoio (Gerentes, resumo) cai aqui e tudo bem - mas aba de loja
      // com título em cima do cabeçalho TAMBÉM caía, e sumia sem deixar
      // rastro. Agora toda aba aparece no relatório, com as colunas que ela
      // tem, pra dar pra ver na hora que é uma aba de fechamento perdida.
      abasLidas.push({
        aba, status: 'sem coluna "Unidade" nas 10 primeiras linhas', lancamentos: 0,
        colunas: (valores[0] || []).map((c) => String(c || '').trim()).filter(Boolean).slice(0, 12),
      });
      continue;
    }
    const { header, iUnidade, linhaCabecalho } = cab;
    const antesDaAba = lancamentos.length;
    for (let i = linhaCabecalho + 1; i < valores.length; i++) {
      const bruto = valores[i][iUnidade];
      // linha totalmente vazia não é descarte, é fim da planilha
      if (!String(bruto || '').trim() && !valores[i].some((c) => String(c || '').trim())) continue;

      const unidade = resolverUnidade(bruto);
      if (!unidade) {
        // Pode ser cabeçalho repetido/linha de resumo (normal), ou uma loja
        // com o nome escrito diferente do cadastro (aí é lançamento REAL
        // sendo perdido). Só dá pra saber vendo o nome - por isso é listado.
        const nome = String(bruto || '(vazio)').trim() || '(vazio)';
        const at = desconhecidas.get(nome) || { nome, total: 0, abas: new Set() };
        at.total += 1; at.abas.add(aba);
        desconhecidas.set(nome, at);
        continue;
      }
      const r = avaliarLinha(header, valores[i], unidade, mapa);
      if (r.lancamento) lancamentos.push(r.lancamento);
      else registrar(aba, r.motivo, r.amostra);
    }
    abasLidas.push({
      aba,
      status: 'lida',
      linhaCabecalho: linhaCabecalho + 1, // 1-based, como aparece no Sheets
      linhasNaAba: Math.max(valores.length - linhaCabecalho - 1, 0),
      lancamentos: lancamentos.length - antesDaAba,
    });
  }
  // junta as linhas do mesmo dia+loja ANTES de qualquer coisa - a simulacao
  // precisa mostrar o mesmo numero que a gravacao vai produzir
  const juntos = mesclarPorDia(lancamentos);
  return {
    lancamentos: juntos.lancamentos,
    problemas,
    linhasLidas: lancamentos.length,
    diasMesclados: juntos.mesclados,
    linhasAbsorvidas: juntos.linhasAbsorvidas,
    abasLidas,
    descartes: [...descartes.values()].sort((a, b) => b.total - a.total),
    unidadesDesconhecidas: [...desconhecidas.values()]
      .map((u) => ({ nome: u.nome, total: u.total, abas: [...u.abas] }))
      .sort((a, b) => b.total - a.total),
  };
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
  const leitura = await lerPlanilha();
  const { lancamentos, problemas } = leitura;
  const porUnidade = new Map();
  lancamentos.forEach((l) => {
    const t = totaisPrevistos(l);
    const atual = porUnidade.get(l.unidade) || { unidade: l.unidade, modelo: UNIDADE_MODELO[l.unidade], linhas: 0, faturamento: 0, totalDeclarado: 0, primeira: l.data, ultima: l.data };
    atual.linhas += 1;
    atual.faturamento = +(atual.faturamento + t.faturamento).toFixed(2);
    atual.totalDeclarado = +(atual.totalDeclarado + t.totalDeclarado).toFixed(2);
    if (l.data < atual.primeira) atual.primeira = l.data;
    if (l.data > atual.ultima) atual.ultima = l.data;
    // dias por MÊS: é assim que dá pra ver de relance se dezembro/2025 até
    // hoje está inteiro ou se falta um pedaço no meio. Só olhar "primeira e
    // última data" esconde buraco no miolo, que foi exatamente o que
    // aconteceu com a Spoleto Shopping Recife.
    (atual.meses = atual.meses || new Map());
    const mes = l.data.slice(0, 7);
    atual.meses.set(mes, (atual.meses.get(mes) || 0) + 1);
    porUnidade.set(l.unidade, atual);
  });

  // marca os meses SEM nenhum lançamento entre a primeira e a última data de
  // cada loja - o buraco é o que interessa, não a presença
  porUnidade.forEach((u) => {
    const meses = u.meses || new Map();
    u.mesesLista = [...meses.entries()].map(([mes, dias]) => ({ mes, dias })).sort((a, b) => a.mes.localeCompare(b.mes));
    u.mesesVazios = [];
    if (u.mesesLista.length) {
      const [ai, mi] = u.primeira.slice(0, 7).split('-').map(Number);
      const [af, mf] = u.ultima.slice(0, 7).split('-').map(Number);
      for (let ano = ai, m = mi; ano < af || (ano === af && m <= mf);) {
        const chave = `${ano}-${String(m).padStart(2, '0')}`;
        if (!meses.has(chave)) u.mesesVazios.push(chave);
        m += 1; if (m > 12) { m = 1; ano += 1; }
      }
    }
    delete u.meses;
  });

  // dia repetido pra mesma loja: o app não deixa dois fechamentos no mesmo
  // unidade+data (docId é unidade__data), então isso PRECISA aparecer antes
  // depois de mesclarPorDia isto TEM que sair vazio - se aparecer algo aqui,
  // a mescla furou e a gravação vai perder linha de novo. Fica como rede de
  // segurança, não como o caminho normal.
  const vistos = new Set();
  const duplicados = [];
  lancamentos.forEach((l) => {
    const chave = `${l.unidade}__${l.data}`;
    if (vistos.has(chave)) duplicados.push(chave); else vistos.add(chave);
  });

  const unidades = [...porUnidade.values()].sort((a, b) => b.faturamento - a.faturamento);
  return {
    total: lancamentos.length,
    // quantas LINHAS a planilha tinha antes de juntar os dias repetidos, e
    // quantas foram absorvidas nessa junção - é o número que explica a
    // diferença entre "linhas na planilha" e "fechamentos no sistema"
    linhasLidas: leitura.linhasLidas,
    diasMesclados: leitura.diasMesclados,
    linhasAbsorvidas: leitura.linhasAbsorvidas,
    faturamento: +unidades.reduce((s, u) => s + u.faturamento, 0).toFixed(2),
    totalDeclarado: +unidades.reduce((s, u) => s + u.totalDeclarado, 0).toFixed(2),
    unidades,
    duplicados,
    problemas,
    // TUDO que a planilha tinha e não virou fechamento, com motivo e exemplo.
    // É aqui que aparece o "por quê" de uma loja ficar sem histórico.
    abasLidas: leitura.abasLidas,
    descartes: leitura.descartes,
    unidadesDesconhecidas: leitura.unidadesDesconhecidas,
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
// compara campo por RÓTULO, não pela chave. A chave (campo) já nasceu
// errada uma vez - slugify não era idempotente e gravou "tefcredito" onde
// devia ser "tefCredito" (corrigido em grupos.js). Comparar por rótulo faz
// o conferir reconhecer o que já existe mesmo com a chave torta, em vez de
// cadastrar tudo de novo e deixar o grupo com dois campos pro mesmo dado.
function chaveRotulo(label) {
  return String(label || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

const QUAIS = [
  { qual: 'canais', chave: 'canaisVendaExtras' },
  { qual: 'formas', chave: 'formasPagamentoExtras' },
  { qual: 'kpis', chave: 'kpisExtras' },
];

async function conferirCampos() {
  const faltando = [];
  const porGrupo = new Map();
  const mapa = await bravoMapa.obter();
  for (const unidade of Object.keys(UNIDADE_MODELO)) {
    const grupo = await grupos.grupoDaUnidade(unidade);
    if (!grupo) { faltando.push({ unidade, erro: 'unidade não está em nenhum grupo' }); continue; }
    const precisa = definicoesDeCampos(unidade, mapa);
    const atual = porGrupo.get(grupo.id)
      || { grupo, canais: new Map(), formas: new Map(), kpis: new Map(), corrigir: new Map() };
    QUAIS.forEach(({ qual, chave }) => {
      const existentes = new Map((grupo[chave] || []).map((d) => [chaveRotulo(d.label), d]));
      precisa[qual].forEach((d) => {
        const jaTem = existentes.get(chaveRotulo(d.label));
        if (!jaTem) atual[qual].set(d.campo, d);
        else if (jaTem.campo !== d.campo) atual.corrigir.set(`${chave}::${jaTem.campo}`, { chave, de: jaTem.campo, para: d.campo, label: d.label });
      });
    });
    porGrupo.set(grupo.id, atual);
  }
  const pendentes = [...porGrupo.values()]
    .map((g) => ({
      grupoId: g.grupo.id, grupoNome: g.grupo.nome,
      canais: [...g.canais.values()], formas: [...g.formas.values()], kpis: [...g.kpis.values()],
      corrigir: [...g.corrigir.values()],
    }))
    .filter((g) => g.canais.length || g.formas.length || g.kpis.length || g.corrigir.length);
  return { pendentes, faltando };
}

// Acrescenta o que falta e CORRIGE a chave dos que ficaram tortos, sempre
// preservando o que o Master já tinha configurado e a ordem que ele
// escolheu. Nunca remove nada.
async function cadastrarCampos() {
  const { pendentes, faltando } = await conferirCampos();
  const feitos = [];
  for (const p of pendentes) {
    const lista = await grupos.list();
    const g = lista.find((x) => x.id === p.grupoId);
    if (!g) continue;
    const corrigirPor = new Map(p.corrigir.map((c) => [`${c.chave}::${c.de}`, c]));
    const patch = {};
    QUAIS.forEach(({ qual, chave }) => {
      const atuais = (g[chave] || []).map((d) => {
        const fix = corrigirPor.get(`${chave}::${d.campo}`);
        return fix ? { ...d, campo: fix.para } : d;
      });
      patch[chave] = [...atuais, ...p[qual]];
    });
    await grupos.update(p.grupoId, patch);
    feitos.push({
      grupo: p.grupoNome,
      canais: p.canais.length, formas: p.formas.length, kpis: p.kpis.length,
      corrigidos: p.corrigir.length,
    });
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
// carimbo de quem criou o registro pela importacao. E o que permite o modo
// "repor" saber o que pode sobrescrever com seguranca - tem que bater EXATO
// com o criadoPorEmail gravado, entao vive numa constante so.
const MARCA_IMPORTACAO = 'importação da planilha (Grupo Bravo)';

// A importacao inteira num request so NAO CABE: sao ~2.600 gravacoes
// sequenciais no Firestore e o request morre no timeout do proxy/hospedagem
// muito antes de terminar. Como lerPlanilha percorre as abas NA ORDEM DA
// PLANILHA, o que sobrava era sempre o mesmo recorte: as primeiras abas
// entravam completas e as ultimas nao entravam quase nada - e as 5 Domino's
// sao justamente as 5 ultimas abas. Era isso, e nao erro de leitura, o motivo
// de elas nao subirem: rodando o parser numa linha real da Campina Grande o
// resultado e faturamento 1.189,53 e declarado 1.186,03, batendo centavo a
// centavo com as colunas "Faturam."/"Total Decla" da propria planilha.
//
// Dai o parametro `unidade`: a tela chama UMA LOJA POR VEZ, cada chamada
// termina rapido, o progresso aparece e uma falha no meio nao leva junto o
// que ja entrou. Sem o parametro o comportamento e o de antes (tudo de uma
// vez), que continua valendo pra base pequena.
async function importar({ confirmar, repor = false, unidade = null, pular = 0, limite = 0 } = {}) {
  if (confirmar !== 'GRAVAR') {
    throw new Error('Importação não confirmada. Rode a simulação, confira os totais e mande confirmar: "GRAVAR".');
  }
  const { pendentes } = await conferirCampos();
  if (pendentes.length) {
    const resumo = pendentes.map((p) => `${p.grupoNome} (${p.canais.length + p.formas.length + p.kpis.length} campo(s))`).join(', ');
    throw new Error(`Falta cadastrar campo no grupo antes de importar: ${resumo}. Rode a ação "cadastrar-campos" primeiro - sem isso o faturamento dessas lojas entraria zerado.`);
  }
  const leitura = await lerPlanilhaCacheada();
  const { problemas } = leitura;
  const daLoja = unidade
    ? leitura.lancamentos.filter((l) => l.unidade === unidade)
    : leitura.lancamentos;
  // Fatia: mesmo com a leitura cacheada, gravar ~250 dias de uma loja e
  // ~250 escritas sequenciais no Firestore - perto demais do limite de tempo
  // do request. A tela chama em blocos e repete ate `restam` chegar a zero.
  const inicio = Math.max(0, Number(pular) || 0);
  const fim = limite > 0 ? inicio + Number(limite) : daLoja.length;
  const lancamentos = daLoja.slice(inicio, fim);
  const resultado = {
    unidade,
    totalDaLoja: daLoja.length,
    processados: lancamentos.length,
    restam: Math.max(daLoja.length - fim, 0),
    gravados: 0, repostos: 0, jaExistiam: [], preservados: [], erros: [], problemas,
    linhasLidas: leitura.linhasLidas,
    diasMesclados: leitura.diasMesclados,
    linhasAbsorvidas: leitura.linhasAbsorvidas,
  };
  for (const l of lancamentos) {
    const base = { ...l, criadoPorId: null, criadoPorEmail: MARCA_IMPORTACAO };
    try {
      await fechamentosLive.create(base);
      resultado.gravados += 1;
      continue;
    } catch (e) {
      if (!/[Jj]á existe/.test(e.message)) {
        resultado.erros.push({ unidade: l.unidade, data: l.data, erro: e.message });
        continue;
      }
    }

    // O dia ja existe no sistema.
    if (!repor) { resultado.jaExistiam.push(`${l.unidade} ${l.data}`); continue; }

    // Modo REPOR: troca o registro pela versao mesclada. Isso e o que
    // conserta os dias que entraram pela metade na primeira importacao (so a
    // primeira linha do dia gravou; as outras morreram no "já existe").
    // So mexe no que a PROPRIA importacao criou - fechamento lançado por uma
    // pessoa nunca e sobrescrito, ou a gente estaria jogando fora trabalho
    // de alguem sem avisar.
    try {
      const id = `${l.unidade}__${l.data}`;
      const atual = await fechamentosLive.getOne(id);
      if (!atual) { resultado.erros.push({ unidade: l.unidade, data: l.data, erro: 'existia ao gravar mas sumiu ao reler' }); continue; }
      if (atual.criadoPorEmail !== MARCA_IMPORTACAO) {
        resultado.preservados.push(`${l.unidade} ${l.data} (lançado por ${atual.criadoPorEmail || 'alguém'})`);
        continue;
      }
      await fechamentosLive.remove(id);
      await fechamentosLive.create(base);
      resultado.repostos += 1;
    } catch (e) {
      resultado.erros.push({ unidade: l.unidade, data: l.data, erro: e.message });
    }
  }
  return resultado;
}

module.exports = {
  simular, importar, conferirCampos, cadastrarCampos, lerPlanilha, linhaParaLancamento, definicoesDeCampos, totaisPrevistos,
  mesclarPorDia, MARCA_IMPORTACAO, avaliarLinha, resolverUnidade, analisarColunas, semelhanca, invalidarLeitura,
  acharCabecalho, indiceDaColuna,
  MODELOS, UNIDADE_MODELO, IDS_EXCLUIDOS, COLUNAS_IGNORADAS,
};

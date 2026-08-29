// fechamentosLive.js
// Fechamentos de caixa lançados direto pela loja (substitui o processo manual
// via AppSheet + planilha). Um documento por unidade+data (nao deixa lançar
// duas vezes o mesmo dia sem querer). Depois de lançado, o registro NAO pode
// ser editado direto - qualquer correção passa por um pedido de edição
// (fechamentoEdicoes) que só é aplicado quando o Master aprova; o valor
// anterior sempre fica guardado no historico do proprio fechamento.
const db = require('./firestore');
const { createCache } = require('./liveCache');
const grupos = require('./grupos');
const ticketCounter = require('./ticketCounter');
const solicitacoes = require('./solicitacoes');

const COLLECTION = db.collection('fechamentosLive');
const EDITS = db.collection('fechamentoEdicoes');

// diferença (declarado - faturado) acima disso, pra qualquer lado, dispara
// um ticket automatico de "Quebra de caixa" na Central pra alguem justificar/
// aprovar (ver create() abaixo). O ticket nasce SEM direcionamento: o e-mail
// pro MV so sai se um Master/Admin direcionar o ticket ao MV na Central
// (pedido do usuario - antes nascia ja direcionado e todo lancamento com
// diferenca disparava e-mail automatico pro MV)
const LIMITE_QUEBRA_CAIXA = 10;
const DATA_RE_SIMPLES = /^\d{4}-\d{2}-\d{2}$/;
function fmtMoneyQuebra(v) {
  const n = Number(v) || 0;
  return `${n < 0 ? '-' : ''}R$ ${Math.abs(n).toFixed(2).replace('.', ',')}`;
}

// nomes amigaveis pros campos fixos - usados no resumo "de -> para" que vai
// dentro do ticket de Ajuste (quem decide precisa ver o que tinha e o que
// passara a ter, sem abrir o fechamento do lado)
const NOMES_CAMPOS_RESUMO = {
  caixaInicial: 'Caixa inicial', caixaFinal: 'Caixa final', delivery: 'Delivery', carryout: 'Carryout',
  pickup: 'Pickup', loja: 'Loja (salão)', adyen: 'Maquininhas (total)', adyenPos: 'Maquininha POS (pós meia-noite)',
  ifood: 'Ifood', food99: '99Food', pix: 'Adyen', pixCnpj: 'Pix CNPJ', outros: 'Outros',
  totalSaida: 'Total de saída', faturamento: 'Faturamento total', totalDeclarado: 'Total declarado',
  quebra: 'Quebra de caixa', tc: 'TC', cancelados: 'Cancelados', entradaDinheiro: 'Entrada em dinheiro', deposito: 'Depósito',
};
const CAMPOS_SEM_MOEDA = ['tc', 'cancelados'];
function fmtDataBRResumo(d) {
  if (!d || !DATA_RE_SIMPLES.test(d)) return d || '—';
  const [y, m, dd] = d.split('-');
  return `${dd}/${m}/${y}`;
}
function fmtValorResumo(campo, valor) {
  return CAMPOS_SEM_MOEDA.includes(campo) ? String(num(valor)) : fmtMoneyQuebra(num(valor));
}


function docId(unidade, data) {
  return `${unidade}__${data}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

// dia anterior (string AAAA-MM-DD) - usado so pra achar o fechamento de
// ontem da mesma unidade (ver ajustePosDoDiaAnterior)
function diaAnterior(data) {
  const d = new Date(data + 'T00:00:00');
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const CAMPOS_NUMERICOS = [
  'caixaInicial', 'caixaFinal', 'delivery', 'carryout', 'pickup', 'loja',
  'adyen', 'ifood', 'food99', 'pix', 'pixCnpj', 'outros', 'totalSaida',
  'faturamento', 'totalDeclarado', 'quebra', 'tc', 'cancelados',
  'entradaDinheiro', 'deposito', 'adyenPos',
];

// Dinheiro tem 2 casas. Sem arredondar aqui, a soma feita na tela (ponto
// flutuante) chegava e era GRAVADA como 1531.0500000000002 - e o Master via
// isso cru no campo de edicao do fechamento. Arredondar no unico portao por
// onde TODO campo numerico passa (create + as duas edicoes) mata na origem,
// em vez de mascarar na exibicao de cada tela.
//
// Nao mexe em dado ja gravado: registro antigo so e' normalizado se alguem
// salvar ele de novo. Os totais (faturamento/totalDeclarado/diferenca) ja
// eram arredondados na hora do calculo.
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

// soma um mapa de extras (campo:valor) respeitando o sinal de cada campo
// (soma/subtrai no PROPRIO total, configurado no grupo - ver grupos.js).
// "soDestinoCruzado": usado quando queremos so os campos marcados como
// "tambem no outro total" (ex: TEF Credito é um Canal, mas tambem soma no
// Total Declarado por já ser forma de pagamento validada) - ignora os que
// não tem essa marcação. Campo sem definição no grupo (raro, ex: grupo foi
// editado depois do lançamento) soma normal (sinal soma, sem cruzamento).
function somaMapaComSinal(mapa, defs, { soDestinoCruzado } = {}) {
  const porCampo = new Map((defs || []).map((d) => [d.campo, d]));
  return Object.entries(mapa || {}).reduce((s, [campo, valor]) => {
    const def = porCampo.get(campo);
    if (soDestinoCruzado) {
      if (!def || !def.tambemNoOutroTotal) return s;
    }
    const sinal = def && def.operacao === 'subtrai' ? -1 : 1;
    return s + sinal * num(valor);
  }, 0);
}

// resolve as definições de canaisVendaExtras/formasPagamentoExtras/kpisExtras
// do grupo da unidade (sinal soma/subtrai e cruzamento entre os 2 totais pra
// canais/formas; somaEm pra kpis, ver grupos.js) - usa o grupo REAL da
// unidade, nao o id que o cliente mandou
async function defsExtrasDaUnidade(unidade) {
  const grupo = await grupos.grupoDaUnidade(unidade);
  return { canais: grupo?.canaisVendaExtras || [], formas: grupo?.formasPagamentoExtras || [], kpis: grupo?.kpisExtras || [] };
}

// soma um mapa de kpisExtras que o Master marcou pra somar em "destino"
// (Faturamento ou Total Declarado, ver somaEm em grupos.js) - so KPI tipo
// moeda pode ter somaEm != 'nao' (grupos.js ja garante isso na gravacao),
// entao nao precisa checar tipo aqui de novo. Sem cruzamento/sinal (isso e
// so pra canais/formas, ver somaMapaComSinal) - um KPI soma OU nao soma.
function somaKpisEm(mapaKpis, kpisDefs, destino) {
  const porCampo = new Map((kpisDefs || []).map((d) => [d.campo, d]));
  return Object.entries(mapaKpis || {}).reduce((s, [campo, valor]) => {
    const def = porCampo.get(campo);
    if (!def || def.somaEm !== destino) return s;
    return s + num(valor);
  }, 0);
}

// loja que vende depois da meia-noite na maquininha: esse valor (adyenPos,
// lançado no dia D) já é contado no Total Declarado de D, mas o PRÓPRIO
// terminal só vai bater esse lote no fechamento de D+1 (é o ciclo dele, não
// o calendário) - sem desconto, D+1 contaria essa venda de novo e sobraria
// caixa. Calculado uma vez, na CRIAÇÃO do fechamento de D+1, a partir do
// adyenPos que D já tinha lançado até então (ver diaAnterior acima); fica
// guardado (não recalculado depois) - se D for corrigido mais tarde, a
// correção de D+1 é manual (mesmo fluxo de qualquer outra correção do app).
async function ajustePosDoDiaAnterior(unidade, data) {
  const ontem = await getOne(docId(unidade, diaAnterior(data)));
  return ontem ? -num(ontem.adyenPos) : 0;
}

// Faturamento = canais de venda; Total Declarado = formas de pagamento
// (maquininhas + iFood + 99Food + Pix + Pix CNPJ + Outros) + dinheiro -
// sempre recalculado a partir dos campos que realmente compoem cada um,
// nunca confiado do que o cliente mandar. Usado tanto no lançamento quanto
// em qualquer correção aprovada depois (senao uma correção que mexe em
// "delivery", por exemplo, deixaria o Faturamento desatualizado). Os campos
// fixos (Delivery/Carryout/... e Adyen/Ifood/...) sao os mesmos pra todo
// mundo; canaisVendaExtras/formasPagamentoExtras (definidos por grupo, ver
// grupos.js) somam POR CIMA desses (respeitando sinal e cruzamento entre os
// 2 totais - ver somaMapaComSinal), nunca substituem.
// "explicitos" (opcional): campos que uma correcao mudou de proposito - se
// for justamente faturamento/totalDeclarado, respeita o valor dado em vez
// de recalcular por cima (escape hatch raro do Master, ver editarDireto)
// "defsExtras" (opcional): {canais, formas, kpis} do grupo da unidade (ver
// defsExtrasDaUnidade) - sem isso, extras somam normal (sinal soma, sem
// cruzamento) e kpis nao somam em nada, mesmo comportamento de antes dessa
// feature.
function recomputarTotais(r, explicitos, defsExtras) {
  const canaisDefs = defsExtras?.canais || [];
  const formasDefs = defsExtras?.formas || [];
  const kpisDefs = defsExtras?.kpis || [];
  if (!explicitos || !Object.prototype.hasOwnProperty.call(explicitos, 'faturamento')) {
    r.faturamento = +(
      num(r.delivery) + num(r.carryout) + num(r.pickup) + num(r.loja)
      + somaMapaComSinal(r.canaisVendaExtras, canaisDefs)
      + somaMapaComSinal(r.formasPagamentoExtras, formasDefs, { soDestinoCruzado: true })
      + somaKpisEm(r.kpisExtras, kpisDefs, 'faturamento')
    ).toFixed(2);
  }
  if (!explicitos || !Object.prototype.hasOwnProperty.call(explicitos, 'totalDeclarado')) {
    r.totalDeclarado = +(
      num(r.adyen) + num(r.adyenPos) + num(r.ajustePosAnterior)
      + num(r.ifood) + num(r.food99) + num(r.pix) + num(r.pixCnpj) + num(r.outros) + num(r.entradaDinheiro)
      + somaMapaComSinal(r.formasPagamentoExtras, formasDefs)
      + somaMapaComSinal(r.canaisVendaExtras, canaisDefs, { soDestinoCruzado: true })
      + somaKpisEm(r.kpisExtras, kpisDefs, 'totalDeclarado')
    ).toFixed(2);
  }
  r.diferenca = +(r.totalDeclarado - r.faturamento).toFixed(2);
  return r;
}

// itens informativos (maquininhas e saidas de caixa detalhadas) - guardados
// pra dar transparencia/auditoria, mas quem soma pro fechamento e o cliente
// (campos.adyen e campos.totalSaida ja vem com a soma pronta)
function sanitizarItens(lista) {
  if (!Array.isArray(lista)) return [];
  return lista
    .map((item) => ({ descricao: String(item?.descricao || '').slice(0, 200), valor: num(item?.valor) }))
    .filter((item) => item.descricao || item.valor);
}

// campos extras definidos por grupo (ver grupos.js) - campo:valor livre, nao
// tem uma lista fixa igual CAMPOS_NUMERICOS porque cada franquia define os
// proprios (Master monta pela tela de Grupos). Aqui so limita tamanho/tipo,
// quem decide QUAIS campos fazem sentido pra cada unidade e o cadastro do
// grupo, nao esse modulo. Usado pros 3 mapas: kpisExtras, canaisVendaExtras,
// formasPagamentoExtras.
// "tipos" (opcional, so kpisExtras usa): mapa campo->tipo vindo do cadastro
// do grupo (ver tiposKpiDaUnidade) - decide se o valor e forçado pra numero
// (quantidade/moeda/kg, o padrao) ou guardado como texto (texto/arquivo, esse
// ultimo guarda o CAMINHO do arquivo no Storage, nao o numero).
function sanitizarMapaExtras(obj, tipos) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  Object.entries(obj).slice(0, 40).forEach(([campo, valor]) => {
    const chave = String(campo).slice(0, 60);
    if (!chave) return;
    const tipo = tipos && tipos[chave];
    out[chave] = (tipo === 'arquivo' || tipo === 'texto') ? String(valor ?? '').slice(0, 300) : num(valor);
  });
  return out;
}

// resolve campo->tipo dos kpisExtras configurados pro grupo da unidade (ver
// grupos.js) - usa o grupo REAL da unidade, nao o id que o cliente mandou no
// payload, pra nao confiar em um "grupo" desatualizado/errado vindo do form
async function tiposKpiDaUnidade(unidade) {
  const grupo = await grupos.grupoDaUnidade(unidade);
  const out = {};
  (grupo?.kpisExtras || []).forEach((k) => { out[k.campo] = k.tipo || 'quantidade'; });
  return out;
}

async function create({ unidade, unidadeNome, grupo, data, gerente, campos, kpisExtras, canaisVendaExtras, formasPagamentoExtras, observacao, detalhesMaquinas, detalhesMaquinasPos, detalhesSaidas, criadoPorId, criadoPorEmail }) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new Error('Data inválida.');

  const id = docId(unidade, data);
  const ref = COLLECTION.doc(id);
  const existente = await ref.get();
  if (existente.exists) {
    throw new Error('Já existe um fechamento lançado para essa unidade nessa data. Peça uma correção em vez de lançar de novo.');
  }

  const registro = { id, unidade, unidadeNome: unidadeNome || unidade, grupo: grupo || 'MANUAL', data, gerente: gerente || '' };
  CAMPOS_NUMERICOS.forEach((c) => { registro[c] = num(campos?.[c]); });
  // desconto automatico da venda pos-meia-noite que ONTEM ja lançou na
  // Maquininha POS (ver ajustePosDoDiaAnterior) - calculado uma vez aqui, na
  // criação, e guardado (nao e recalculado se ontem for corrigido depois)
  registro.ajustePosAnterior = await ajustePosDoDiaAnterior(unidade, data);
  const tiposKpi = await tiposKpiDaUnidade(unidade);
  registro.kpisExtras = sanitizarMapaExtras(kpisExtras, tiposKpi);
  registro.canaisVendaExtras = sanitizarMapaExtras(canaisVendaExtras);
  registro.formasPagamentoExtras = sanitizarMapaExtras(formasPagamentoExtras);
  recomputarTotais(registro, null, await defsExtrasDaUnidade(unidade));
  registro.observacao = observacao || null;
  registro.detalhesMaquinas = sanitizarItens(detalhesMaquinas);
  registro.detalhesMaquinasPos = sanitizarItens(detalhesMaquinasPos);
  registro.detalhesSaidas = sanitizarItens(detalhesSaidas);

  const agora = new Date().toISOString();
  registro.criadoPorId = criadoPorId;
  registro.criadoPorEmail = criadoPorEmail;
  registro.criadoEm = agora;
  registro.atualizadoEm = agora;
  registro.historico = [];

  await ref.set(registro);
  fechamentosCache.invalidar();

  // ticket automatico de "Quebra de caixa" quando a diferenca passa do
  // limite (ver LIMITE_QUEBRA_CAIXA acima) - falha aqui NAO derruba o
  // lançamento do fechamento em si, so fica sem o ticket dessa vez (logado
  // pra investigar depois)
  let cardQuebraCaixa = null;
  if (Math.abs(registro.diferenca) > LIMITE_QUEBRA_CAIXA) {
    try {
      cardQuebraCaixa = await criarCardQuebraCaixa(registro);
    } catch (err) {
      console.error(`Falha ao criar ticket automático de Quebra de caixa (fechamento ${id}):`, err.message);
    }
  }

  return { ...registro, cardQuebraCaixa };
}

// gera o ticket de "Quebra de caixa" pra um fechamento ja gravado - usado
// tanto na hora do lançamento (create() acima) quanto retroativamente
// (backfillQuebraCaixa, pra pegar fechamentos lançados ANTES dessa feature
// existir)
async function criarCardQuebraCaixa(registro) {
  return solicitacoes.create({
    tipo: 'quebra-caixa',
    unidade: registro.unidade,
    unidadeNome: registro.unidadeNome,
    titulo: `Quebra de caixa · ${registro.unidadeNome} (${registro.data}) · diferença de ${fmtMoneyQuebra(registro.diferenca)}`,
    valorEstimado: registro.diferenca,
    observacao: registro.observacao || 'Diferença detectada automaticamente no lançamento do fechamento - sem observação da loja.',
    fechamentoId: registro.id,
    criadoPorId: registro.criadoPorId,
    criadoPorEmail: registro.criadoPorEmail,
    direcionadoParaId: null,
    direcionadoParaEmail: null,
  });
}

// varre fechamentos JA LANÇADOS num período (pensado pra pegar quem foi
// lançado antes do ticket automático de Quebra de caixa existir) e cria o
// ticket pra quem tem diferença acima do limite e ainda não tem um -
// idempotente: rodar de novo no mesmo período não duplica (confere por
// fechamentoId nos tickets de quebra-caixa já existentes)
async function backfillQuebraCaixa(dataInicio, dataFim) {
  if (!dataInicio || !DATA_RE_SIMPLES.test(dataInicio)) throw new Error('Data inicial inválida (use AAAA-MM-DD).');
  if (!dataFim || !DATA_RE_SIMPLES.test(dataFim)) throw new Error('Data final inválida (use AAAA-MM-DD).');

  const todos = await listAllUncached();
  const doPeriodo = todos.filter((f) => f.data >= dataInicio && f.data <= dataFim);

  const solicitacoesTodas = await solicitacoes.listAll();
  const fechamentosComCard = new Set(
    solicitacoesTodas.filter((s) => s.tipo === 'quebra-caixa' && s.fechamentoId).map((s) => s.fechamentoId)
  );

  const resultado = { verificados: doPeriodo.length, cardsCriados: [], jaTinhaCard: 0, semDiferencaRelevante: 0, erros: [] };
  for (const f of doPeriodo) {
    if (Math.abs(f.diferenca) <= LIMITE_QUEBRA_CAIXA) { resultado.semDiferencaRelevante++; continue; }
    if (fechamentosComCard.has(f.id)) { resultado.jaTinhaCard++; continue; }
    try {
      const card = await criarCardQuebraCaixa(f);
      resultado.cardsCriados.push(card);
    } catch (err) {
      resultado.erros.push({ fechamentoId: f.id, unidade: f.unidadeNome, data: f.data, erro: err.message });
    }
  }
  return resultado;
}

async function listAllUncached() {
  const snap = await COLLECTION.orderBy('data', 'desc').get();
  return snap.docs.map((d) => d.data());
}
// TTL longo de proposito: essa e a maior colecao viva do banco (milhares de
// docs) e TODA escrita nela passa por este modulo, que invalida o cache na
// hora - o TTL nao e o que mantem o dado fresco, e so rede de seguranca pra
// escrita feita por fora (console do Firebase, restauracao de backup - que
// tambem ja chama invalidarCache pela rota). Com 5min, a colecao inteira era
// relida ~288x/dia mesmo sem nada mudar; era a maior fatia das leituras
// diarias do Firestore (analise de 20/08).
const fechamentosCacheBase = createCache(listAllUncached, 6 * 60 * 60 * 1000);

// Importacao em massa (ver bravoImport.js): cada dia gravado invalida o
// cache, e qualquer leitura entre duas gravacoes paga a colecao inteira de
// novo - num lote de dezenas de dias com telas abertas isso virava
// tempestade de leituras. Suspender segura as invalidacoes e aplica UMA so
// quando o lote termina (retomar). Nao afeta escrita avulsa: fora do lote,
// invalidar() continua imediato.
let invalidacoesSuspensas = false;
let invalidacaoPendente = false;
const fechamentosCache = {
  cached: fechamentosCacheBase.cached,
  invalidar: () => {
    if (invalidacoesSuspensas) { invalidacaoPendente = true; return; }
    fechamentosCacheBase.invalidar();
  },
};
function suspenderInvalidacao() { invalidacoesSuspensas = true; }
function retomarInvalidacao() {
  invalidacoesSuspensas = false;
  if (invalidacaoPendente) { invalidacaoPendente = false; fechamentosCacheBase.invalidar(); }
}
const listAll = fechamentosCache.cached;


// filtra EM MEMORIA sobre o cache compartilhado - a query direta por
// unidade (where in) nao passava pelo cache e virava uma leitura completa
// no Firestore a cada chamada (ver o estouro de leituras de 2026-08-09)
async function listByUnidades(unidades) {
  if (!unidades || !unidades.length) return [];
  const alvo = new Set(unidades);
  return (await listAll()).filter((r) => alvo.has(r.unidade));
}

async function getOne(id) {
  const doc = await COLLECTION.doc(id).get();
  return doc.exists ? doc.data() : null;
}

// tipo 'campo': corrige o valor de um campo já lançado (mudancas: {campo:valor}).
// tipo 'item': adiciona um item novo que faltou lançar (ex: esqueceu uma
// maquininha, ou uma saída que não passou pela Sangria) - soma em cima do
// que já existe, não substitui. 'maquininhaPos' segue o mesmo esquema, mas
// pro fechamento SEGUINTE (se já existir) o desconto automático não é
// refeito - foi calculado uma vez na criação dele (ver ajustePosAnterior);
// se precisar, o Master corrige o dia seguinte manualmente também.
const TIPOS_ITEM_NOVO = ['maquininha', 'maquininhaPos', 'saida'];

// monta as linhas "de -> para" de um pedido a partir do fechamento ATUAL: o
// que tinha e o que passara a ter (ou o que sera adicionado/removido). Campos
// em branco aparecem como "não tinha" - mesmo efeito de 0, mas mais claro pra
// quem le. Usado na criacao do pedido e tambem como fallback de leitura pros
// pedidos criados antes do resumo existir - nesse caso so enquanto PENDENTES,
// porque depois de aplicado o fechamento ja mudou e o "o que tinha" se perdeu
async function montarResumoMudancas(pedido, atual) {
  if (pedido.tipoCorrecao === 'item') {
    const { tipo, descricao, valor } = pedido.itemNovo || {};
    const rotuloItem = { maquininha: 'maquininha', maquininhaPos: 'maquininha POS', saida: 'saída de caixa' }[tipo] || 'item';
    const totalAlvo = tipo === 'saida' ? 'totalSaida' : (tipo === 'maquininhaPos' ? 'adyenPos' : 'adyen');
    return [
      `Adicionar ${rotuloItem} "${descricao || '(sem descrição)'}": não tinha → ${fmtMoneyQuebra(num(valor))}`,
      `${NOMES_CAMPOS_RESUMO[totalAlvo]}: ${fmtMoneyQuebra(num(atual[totalAlvo]))} → ${fmtMoneyQuebra(num(atual[totalAlvo]) + num(valor))}`,
    ];
  }
  if (pedido.tipoCorrecao === 'saida-item') {
    const { indice, descricao, valor } = pedido.itemNovo || {};
    const antigo = (atual.detalhesSaidas || [])[Number(indice)] || {};
    return [
      `Saída "${antigo.descricao || '(sem descrição)'}" → "${descricao || '(sem descrição)'}"`,
      `Valor da saída: ${fmtMoneyQuebra(num(antigo.valor))} → ${fmtMoneyQuebra(num(valor))}`,
      `${NOMES_CAMPOS_RESUMO.totalSaida}: ${fmtMoneyQuebra(num(atual.totalSaida))} → ${fmtMoneyQuebra(num(atual.totalSaida) - num(antigo.valor) + num(valor))}`,
    ];
  }
  if (pedido.tipoCorrecao === 'excluir') {
    return [
      `EXCLUIR o lançamento inteiro de ${fmtDataBRResumo(atual.data)} (${atual.unidadeNome || atual.unidade})`,
      `Será removido: Faturamento ${fmtMoneyQuebra(num(atual.faturamento))} · Declarado ${fmtMoneyQuebra(num(atual.totalDeclarado))} · Diferença ${fmtMoneyQuebra(num(atual.diferenca))}`,
    ];
  }
  if (pedido.tipoCorrecao === 'data') {
    return [`Data do lançamento: ${fmtDataBRResumo(atual.data)} → ${fmtDataBRResumo(pedido.novaData)}`];
  }
  const grupo = await grupos.grupoDaUnidade(atual.unidade);
  const tiposKpi = await tiposKpiDaUnidade(atual.unidade);
  const labelExtra = (defs, campo) => ((defs || []).find((d) => d.campo === campo) || {}).label || campo;
  const dePara = (anterior, novo, temAnterior) => `${temAnterior ? anterior : 'não tinha'} → ${novo}`;
  const linhas = [];
  Object.entries(pedido.mudancas || {}).forEach(([campo, valor]) => {
    linhas.push(`${NOMES_CAMPOS_RESUMO[campo] || campo}: ${dePara(fmtValorResumo(campo, atual[campo]), fmtValorResumo(campo, valor), atual[campo] != null)}`);
  });
  Object.entries(pedido.mudancasCanais || {}).forEach(([campo, valor]) => {
    const anterior = (atual.canaisVendaExtras || {})[campo];
    linhas.push(`${labelExtra(grupo?.canaisVendaExtras, campo)}: ${dePara(fmtMoneyQuebra(num(anterior)), fmtMoneyQuebra(num(valor)), anterior != null)}`);
  });
  Object.entries(pedido.mudancasFormas || {}).forEach(([campo, valor]) => {
    const anterior = (atual.formasPagamentoExtras || {})[campo];
    linhas.push(`${labelExtra(grupo?.formasPagamentoExtras, campo)}: ${dePara(fmtMoneyQuebra(num(anterior)), fmtMoneyQuebra(num(valor)), anterior != null)}`);
  });
  Object.entries(pedido.mudancasKpis || {}).forEach(([campo, valor]) => {
    const anterior = (atual.kpisExtras || {})[campo];
    const emMoeda = tiposKpi[campo] === 'moeda';
    const fmt = (v) => (emMoeda ? fmtMoneyQuebra(num(v)) : String(v ?? ''));
    linhas.push(`${labelExtra(grupo?.kpisExtras, campo)}: ${dePara(fmt(anterior), fmt(valor), anterior != null)}`);
  });
  return linhas;
}

async function solicitarEdicao({ fechamentoId, tipoCorrecao, mudancas, mudancasCanais, mudancasFormas, mudancasKpis, itemNovo, novaData, motivo, anexos, solicitadoPorId, solicitadoPorEmail, direcionadoParaId, direcionadoParaEmail }) {
  const atual = await getOne(fechamentoId);
  if (!atual) throw new Error('Fechamento não encontrado.');
  if (!motivo || !String(motivo).trim()) throw new Error('Descreva o motivo da correção.');

  // 1 correcao pendente por fechamento: toque duplo no celular estava
  // criando pedidos identicos na fila do Master (e agora um pedido so
  // carrega quantos campos precisar - nao ha motivo pra fila dupla)
  const pendenteSnap = await EDITS.where('fechamentoId', '==', fechamentoId).where('status', '==', 'PENDENTE').get();
  if (!pendenteSnap.empty) {
    const t = pendenteSnap.docs[0].data().numeroTicket;
    throw new Error(`Já existe uma correção pendente pra esse lançamento${t ? ` (Ticket #${t})` : ''}. Aguarde a decisão do Master antes de pedir outra.`);
  }

  const pedido = {
    id: null,
    // Ticket #10000 em diante, mesma sequencia global de refunds.js/
    // solicitacoes.js. Ajuste de fechamento nao entra no fluxo de
    // troca/conversao de tipo (fica preso a um fechamentoId especifico), mas
    // ainda ganha um numero de ticket pra identificacao/notificacao
    numeroTicket: null,
    fechamentoId,
    unidade: atual.unidade,
    unidadeNome: atual.unidadeNome,
    data: atual.data,
    tipoCorrecao: ['item', 'excluir', 'data', 'saida-item'].includes(tipoCorrecao) ? tipoCorrecao : 'campo',
    mudancas: {},
    // patches dos mapas extras do grupo (canais de venda/formas de
    // pagamento/KPIs definidos em grupos.html) - mesmo formato campo:valor
    // do editarDireto, pra loja poder corrigir TUDO que digitou, nao so os
    // campos fixos
    mudancasCanais: {},
    mudancasFormas: {},
    mudancasKpis: {},
    // resumo "de -> para" pronto pra leitura no ticket: o que tinha e o que
    // passara a ter (ou o que sera adicionado/removido) - montado aqui,
    // enquanto os valores atuais ainda estao na frente dos olhos
    resumoMudancas: [],
    itemNovo: null,
    novaData: null,
    motivo: String(motivo).trim(),
    anexos: Array.isArray(anexos) ? anexos : [],
    status: 'PENDENTE',
    solicitadoPorId,
    solicitadoPorEmail,
    // Master/Admin escolhido por quem lançou (opcional, ver grupos.js) - so
    // um "pra quem e mais direto", nao restringe quem mais pode decidir
    direcionadoParaId: direcionadoParaId || null,
    direcionadoParaEmail: direcionadoParaEmail || null,
    // notificacao (popup com som) fica ativa ate QUALQUER Master/Admin
    // sinalizar que viu - ver marcarNotificacaoVista
    notificacaoVista: false,
    notificacaoVistaPorEmail: null,
    notificacaoVistaPorUsername: null,
    notificacaoVistaEm: null,
    criadoEm: null,
    decididoPorEmail: null,
    decididoEm: null,
    motivoDecisao: null,
  };

  if (pedido.tipoCorrecao === 'item') {
    if (!itemNovo || !TIPOS_ITEM_NOVO.includes(itemNovo.tipo)) throw new Error('Escolha o tipo do item (maquininha, maquininha POS ou saída).');
    const valor = num(itemNovo.valor);
    if (valor <= 0) throw new Error('Informe o valor do item.');
    pedido.itemNovo = { tipo: itemNovo.tipo, descricao: String(itemNovo.descricao || '').slice(0, 200), valor };
  } else if (pedido.tipoCorrecao === 'saida-item') {
    // corrigir uma saida que JA existe (o "item" acima e pra ACRESCENTAR
    // uma). Guarda o indice, e a checagem de que o indice existe e refeita
    // na aprovacao - o fechamento pode mudar entre pedir e aprovar
    const atualSaida = await getOne(fechamentoId);
    const i = Number(itemNovo && itemNovo.indice);
    if (!atualSaida || !Number.isInteger(i) || !((atualSaida.detalhesSaidas || [])[i])) {
      throw new Error('Saída não encontrada nesse fechamento.');
    }
    const valor = num(itemNovo.valor);
    if (valor < 0) throw new Error('O valor da saída não pode ser negativo.');
    pedido.itemNovo = { indice: i, descricao: String(itemNovo.descricao || '').slice(0, 200), valor };
  } else if (pedido.tipoCorrecao === 'excluir') {
    // nada mais pra validar - so o motivo, ja exigido acima. A exclusao de
    // fato so acontece se o Master aprovar (ver decidirEdicao); ate la o
    // fechamento continua intacto e visivel normalmente
  } else if (pedido.tipoCorrecao === 'data') {
    // mudar a data efetivamente troca o ID do documento (ver docId), entao
    // precisa validar aqui que a data e valida, diferente da atual e que o
    // destino esta livre (checado de novo na aprovacao, que e quando de
    // fato acontece - pode ter mudado nesse meio tempo)
    if (!novaData || !/^\d{4}-\d{2}-\d{2}$/.test(novaData)) throw new Error('Informe a data correta (AAAA-MM-DD).');
    if (novaData === atual.data) throw new Error('A data correta é igual à data atual do lançamento.');
    const colisao = await COLLECTION.doc(docId(atual.unidade, novaData)).get();
    if (colisao.exists) throw new Error('Já existe um fechamento lançado para essa unidade nessa data.');
    pedido.novaData = novaData;
  } else {
    const camposValidos = {};
    Object.entries(mudancas || {}).forEach(([campo, valor]) => {
      if (CAMPOS_NUMERICOS.includes(campo)) camposValidos[campo] = num(valor);
    });
    const tiposKpi = await tiposKpiDaUnidade(atual.unidade);
    pedido.mudancasCanais = sanitizarPatchMapa(mudancasCanais);
    pedido.mudancasFormas = sanitizarPatchMapa(mudancasFormas);
    pedido.mudancasKpis = sanitizarPatchMapa(mudancasKpis, tiposKpi);
    if (!Object.keys(camposValidos).length && !Object.keys(pedido.mudancasCanais).length
      && !Object.keys(pedido.mudancasFormas).length && !Object.keys(pedido.mudancasKpis).length) {
      throw new Error('Nenhum campo válido para corrigir.');
    }
    pedido.mudancas = camposValidos;
  }

  pedido.resumoMudancas = await montarResumoMudancas(pedido, atual);

  const ref = EDITS.doc();
  const agora = new Date().toISOString();
  pedido.id = ref.id;
  pedido.numeroTicket = await ticketCounter.proximoTicket();
  pedido.criadoEm = agora;
  await ref.set(pedido);
  edicoesCache.invalidar();
  return pedido;
}

// campos de texto (alem dos numericos) que o Master tambem pode corrigir
// direto - unidade/data ficam de fora de proposito (mudar isso e apagar e
// relancar, nao "corrigir")
const CAMPOS_TEXTO = ['gerente', 'observacao'];

// edicao direta: so o Master usa isso (o resto passa por solicitarEdicao +
// decidirEdicao). Como o Master e quem aprovaria a propria solicitacao,
// pedir-e-aprovar pra si mesmo e so atrito - aqui a mudanca e aplicada na
// hora, mas ainda fica registrada no historico do fechamento pra auditoria
// valida um patch de mapa livre (campo:valor) - usado pelos 3 "mudancasXxx"
// de editarDireto, mesmo formato de sanitizarMapaExtras mas sem limite de
// quantidade (e so um patch, nao o mapa inteiro)
function sanitizarPatchMapa(obj, tipos) {
  const out = {};
  Object.entries(obj || {}).forEach(([campo, valor]) => {
    const chave = String(campo).slice(0, 60);
    if (!chave) return;
    const tipo = tipos && tipos[chave];
    out[chave] = (tipo === 'arquivo' || tipo === 'texto') ? String(valor ?? '').slice(0, 300) : num(valor);
  });
  return out;
}

async function editarDireto({ fechamentoId, mudancas, mudancasKpis, mudancasCanais, mudancasFormas, motivo, editadoPorEmail }) {
  const atual = await getOne(fechamentoId);
  if (!atual) throw new Error('Fechamento não encontrado.');
  // grupo com Quebra desabilitada (ver grupos.js): 'quebra' nunca entra na
  // edicao, mesmo que venha no payload - defesa em profundidade por tras do
  // campo ja estar escondido no modal (fechamentos.html) pra esse grupo
  const grupoDaUnidade = await grupos.grupoDaUnidade(atual.unidade);
  const quebraDesabilitada = grupoDaUnidade && grupoDaUnidade.quebraHabilitada === false;
  const camposValidos = {};
  Object.entries(mudancas || {}).forEach(([campo, valor]) => {
    if (campo === 'quebra' && quebraDesabilitada) return;
    if (CAMPOS_NUMERICOS.includes(campo)) camposValidos[campo] = num(valor);
    else if (CAMPOS_TEXTO.includes(campo)) camposValidos[campo] = String(valor ?? '').slice(0, 500);
  });
  // kpisExtras/canaisVendaExtras/formasPagamentoExtras sao mapas livres
  // (campos definidos pelo grupo, ver grupos.js) - aqui e um PATCH: so os
  // campos informados mudam, o resto do mapa permanece igual (diferente de
  // mudancas, que sobrescreve campo por campo mas nao apaga os que nao vieram)
  const tiposKpi = await tiposKpiDaUnidade(atual.unidade);
  const kpisValidos = sanitizarPatchMapa(mudancasKpis, tiposKpi);
  const canaisValidos = sanitizarPatchMapa(mudancasCanais);
  const formasValidos = sanitizarPatchMapa(mudancasFormas);
  if (!Object.keys(camposValidos).length && !Object.keys(kpisValidos).length && !Object.keys(canaisValidos).length && !Object.keys(formasValidos).length) {
    throw new Error('Nenhum campo válido para alterar.');
  }

  const valoresAnteriores = {};
  Object.keys(camposValidos).forEach((campo) => { valoresAnteriores[campo] = atual[campo]; });

  const kpisExtrasNovo = Object.keys(kpisValidos).length ? { ...(atual.kpisExtras || {}), ...kpisValidos } : atual.kpisExtras;
  const canaisExtrasNovo = Object.keys(canaisValidos).length ? { ...(atual.canaisVendaExtras || {}), ...canaisValidos } : atual.canaisVendaExtras;
  const formasExtrasNovo = Object.keys(formasValidos).length ? { ...(atual.formasPagamentoExtras || {}), ...formasValidos } : atual.formasPagamentoExtras;

  // kpisExtras precisa entrar no merged tambem - sem isso, uma correcao que
  // muda so um KPI (ex: um KPI moeda com somaEm=faturamento) recomputava o
  // total com o mapa ANTIGO (atual.kpisExtras, herdado do spread abaixo),
  // ignorando a propria mudanca que acabou de ser aplicada. Passou
  // despercebido ate agora porque kpisExtras nunca somava em nada.
  const merged = { ...atual, ...camposValidos, kpisExtras: kpisExtrasNovo, canaisVendaExtras: canaisExtrasNovo, formasPagamentoExtras: formasExtrasNovo };
  recomputarTotais(merged, camposValidos, await defsExtrasDaUnidade(atual.unidade));
  const novosValores = { ...camposValidos, faturamento: merged.faturamento, totalDeclarado: merged.totalDeclarado, diferenca: merged.diferenca };
  if (Object.keys(kpisValidos).length) novosValores.kpisExtras = kpisExtrasNovo;
  if (Object.keys(canaisValidos).length) novosValores.canaisVendaExtras = canaisExtrasNovo;
  if (Object.keys(formasValidos).length) novosValores.formasPagamentoExtras = formasExtrasNovo;

  const valoresNovosHistorico = { ...camposValidos };
  if (Object.keys(kpisValidos).length) valoresNovosHistorico.kpisExtras = kpisValidos;
  if (Object.keys(canaisValidos).length) valoresNovosHistorico.canaisVendaExtras = canaisValidos;
  if (Object.keys(formasValidos).length) valoresNovosHistorico.formasPagamentoExtras = formasValidos;

  const historico = [...(atual.historico || []), {
    em: new Date().toISOString(),
    por: editadoPorEmail,
    motivo: (motivo && String(motivo).trim()) || '(edição direta do Master)',
    valoresAnteriores,
    valoresNovos: valoresNovosHistorico,
  }];

  const ref = COLLECTION.doc(fechamentoId);
  await ref.update({ ...novosValores, historico, atualizadoEm: new Date().toISOString() });
  fechamentosCache.invalidar();
  return { ...atual, ...novosValores, historico };
}


// EDITAR UMA saida avulsa que ja esta lancada (pedido do Master: "um local
// pra clicar e editar a Saida em caso de erro"). Mexe num item de
// detalhesSaidas e ajusta o totalSaida pela DIFERENCA - nunca recalcula o
// total pela soma dos itens, porque totalSaida pode ter parcela que nao esta
// itemizada (fechamento antigo, planilha) e a soma zeraria essa parcela.
//
// Mesma logica do editarDireto: aplicado na hora, com registro no historico
// do proprio fechamento. Quem NAO pode editar direto passa por
// solicitarEdicao({tipoCorrecao:'saida-item'}), que aplica isto na aprovacao.
async function editarItemSaida({ fechamentoId, indice, descricao, valor, motivo, editadoPorEmail }) {
  const atual = await getOne(fechamentoId);
  if (!atual) throw new Error('Fechamento não encontrado.');
  const itens = [...(atual.detalhesSaidas || [])];
  const i = Number(indice);
  if (!Number.isInteger(i) || !itens[i]) throw new Error('Saída não encontrada nesse fechamento.');

  const antigo = itens[i];
  const desc = String(descricao != null ? descricao : (antigo.descricao || '')).trim().slice(0, 300);
  const novoValor = valor != null ? num(valor) : num(antigo.valor);
  if (novoValor < 0) throw new Error('O valor da saída não pode ser negativo.');
  if (desc === String(antigo.descricao || '').trim() && novoValor === num(antigo.valor)) {
    throw new Error('Nada mudou nessa saída.');
  }
  itens[i] = { descricao: desc, valor: novoValor };
  // ajuste pela DIFERENCA, com piso em zero. No lancamento o totalSaida e
  // DIGITADO a parte (os itens de detalhesSaidas sao a memoria de calculo, e
  // podem nao somar exatamente o total). Quando o total nao incluia esse
  // item, subtrair o valor antigo levaria o total pra negativo - e total de
  // saida negativo nao quer dizer nada.
  const totalSaida = Math.max(0, +(num(atual.totalSaida) - num(antigo.valor) + novoValor).toFixed(2));

  const merged = { ...atual, detalhesSaidas: itens, totalSaida };
  recomputarTotais(merged, { totalSaida }, await defsExtrasDaUnidade(atual.unidade));
  const novosValores = {
    detalhesSaidas: itens,
    totalSaida,
    faturamento: merged.faturamento,
    totalDeclarado: merged.totalDeclarado,
    diferenca: merged.diferenca,
  };
  const historico = [...(atual.historico || []), {
    em: new Date().toISOString(),
    por: editadoPorEmail,
    motivo: (motivo && String(motivo).trim()) || '(saída editada no Painel de Saídas)',
    valoresAnteriores: { saida: `${antigo.descricao || '(sem descrição)'}: ${num(antigo.valor)}`, totalSaida: num(atual.totalSaida) },
    valoresNovos: { saida: `${desc || '(sem descrição)'}: ${novoValor}`, totalSaida },
  }];
  await COLLECTION.doc(fechamentoId).update({ ...novosValores, historico, atualizadoEm: new Date().toISOString() });
  fechamentosCache.invalidar();
  return { ...atual, ...novosValores, historico };
}

// ACRESCENTAR uma saida avulsa em qualquer data (pedido do Master, so ele e
// o Admin). A saida vive DENTRO do fechamento do dia daquela unidade - por
// isso o fechamento precisa existir. Nao criamos um fechamento so pra
// pendurar uma saida: um fechamento com faturamento zero apareceria na tela
// de Fechamentos como se a loja tivesse fechado o dia com R$0.
async function adicionarSaidaDireto({ unidade, data, descricao, valor, motivo, editadoPorEmail }) {
  if (!unidade) throw new Error('Escolha a unidade.');
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new Error('Data inválida.');
  const v = num(valor);
  if (v <= 0) throw new Error('Informe o valor da saída.');
  const desc = String(descricao || '').trim().slice(0, 300);
  if (!desc) throw new Error('Descreva a saída (ex: uber, compra de gelo).');

  const id = docId(unidade, data);
  const atual = await getOne(id);
  if (!atual) throw new Error('Não há fechamento lançado nessa data pra essa unidade - a saída avulsa mora dentro do fechamento do dia.');

  const itens = [...(atual.detalhesSaidas || []), { descricao: desc, valor: v }];
  const totalSaida = +(num(atual.totalSaida) + v).toFixed(2);
  const merged = { ...atual, detalhesSaidas: itens, totalSaida };
  recomputarTotais(merged, { totalSaida }, await defsExtrasDaUnidade(unidade));
  const novosValores = {
    detalhesSaidas: itens,
    totalSaida,
    faturamento: merged.faturamento,
    totalDeclarado: merged.totalDeclarado,
    diferenca: merged.diferenca,
  };
  const historico = [...(atual.historico || []), {
    em: new Date().toISOString(),
    por: editadoPorEmail,
    motivo: (motivo && String(motivo).trim()) || '(saída acrescentada no Painel de Saídas)',
    valoresAnteriores: { totalSaida: num(atual.totalSaida) },
    valoresNovos: { saida: `${desc}: ${v}`, totalSaida },
  }];
  await COLLECTION.doc(id).update({ ...novosValores, historico, atualizadoEm: new Date().toISOString() });
  fechamentosCache.invalidar();
  return { ...atual, ...novosValores, historico };
}

// exclui o fechamento lançado de vez - poder do Master, mesma logica de
// editarDireto (aplicado na hora, sem passar por fila de aprovacao)
async function remove(id) {
  const atual = await getOne(id);
  if (!atual) throw new Error('Fechamento não encontrado.');
  await COLLECTION.doc(id).delete();
  fechamentosCache.invalidar();
}

// cache de 20s: a fila de edicoes entra em TODA montagem da Central
// (todosCardsCentral em index.js - painel, historico e cada notificacao SSE
// refazem essa leitura) - sem cache era uma releitura completa da colecao
// fechamentoEdicoes por chamada. Toda mutacao da fila invalida.
async function listarEdicoesUncached() {
  const snap = await EDITS.orderBy('criadoEm', 'desc').get();
  const pedidos = snap.docs.map((d) => d.data());
  // pedidos criados antes do resumo "de -> para" existir ganham o resumo na
  // leitura, enquanto PENDENTES (o fechamento ainda tem os valores antigos)
  // - assim ninguem aprova as cegas nem os pedidos da fila antiga
  const precisamResumo = pedidos.filter((p) => p.status === 'PENDENTE' && !(p.resumoMudancas || []).length);
  if (!precisamResumo.length) return pedidos;
  // busca os fechamentos UMA vez, da listagem que ja esta em cache, em vez de
  // um getOne() (= 1 leitura no Firestore) por pedido da fila. Era o unico
  // N+1 de leitura que sobrou no caminho da Central. Cair pro cache tambem
  // nao piora a validade do resultado: os dois caches tem o mesmo TTL de
  // 5min e o de fechamentos e invalidado em toda escrita, entao o "de" do
  // resumo sai tao fresco quanto sairia pelo getOne
  const porId = new Map((await listAll()).map((f) => [f.id, f]));
  for (const p of precisamResumo) {
    try {
      const atual = porId.get(p.fechamentoId);
      if (atual) p.resumoMudancas = await montarResumoMudancas(p, atual);
    } catch (e) { /* sem resumo, o pedido segue mostrando so o motivo */ }
  }
  return pedidos;
}
const edicoesCache = createCache(listarEdicoesUncached, 5 * 60 * 1000);
const listarEdicoes = edicoesCache.cached;

async function getEdicao(id) {
  const doc = await EDITS.doc(id).get();
  return doc.exists ? doc.data() : null;
}

async function marcarNotificacaoVistaEdicao(id, { vistoPorEmail, vistoPorUsername }) {
  const ref = EDITS.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Pedido não encontrado.');
  await ref.update({ notificacaoVista: true, notificacaoVistaPorEmail: vistoPorEmail, notificacaoVistaPorUsername: vistoPorUsername || null, notificacaoVistaEm: new Date().toISOString() });
  edicoesCache.invalidar();
  return getEdicao(id);
}

// troca o Master/Admin responsavel por um pedido de ajuste ja existente -
// mesmo criterio do redirecionar() de solicitacoes.js (atribuidosIds/Emails
// e quem de fato enxerga o card na Central quando nao e Master)
async function redirecionarEdicao(id, { direcionadoParaId, direcionadoParaEmail, atribuidosIds, atribuidosEmails }) {
  const ref = EDITS.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Pedido não encontrado.');
  await ref.update({
    direcionadoParaId: direcionadoParaId || null,
    direcionadoParaEmail: direcionadoParaEmail || null,
    atribuidosIds: Array.isArray(atribuidosIds) ? atribuidosIds.filter(Boolean) : [],
    atribuidosEmails: Array.isArray(atribuidosEmails) ? atribuidosEmails.filter(Boolean) : [],
  });
  edicoesCache.invalidar();
  return getEdicao(id);
}

// exclui so o PEDIDO de ajuste (o registro na fila de solicitacoes) - poder
// do Master de limpar a fila. Se o pedido ja tinha sido aprovado, o
// fechamento em si (ja alterado por decidirEdicao) nao e desfeito; pra
// Master muda a UNIDADE e/ou a DATA de um fechamento ja lancado, direto e
// sem fila de aprovacao. Como o ID do documento e derivado de unidade+data
// (ver docId), mudar qualquer um dos dois significa MOVER o registro: grava
// uma copia com o ID novo (com entrada no historico) e apaga o antigo -
// mesmo padrao da correcao de data aprovada (decidirEdicao tipo 'data').
async function moverFechamento({ fechamentoId, novaUnidade, novaUnidadeNome, novaData, motivo, editadoPorEmail }) {
  const ref = COLLECTION.doc(fechamentoId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error('Fechamento não encontrado.');
  const atual = doc.data();
  const unidade = novaUnidade || atual.unidade;
  const data = novaData || atual.data;
  if (!DATA_RE_SIMPLES.test(data)) throw new Error('Data inválida (use AAAA-MM-DD).');
  if (unidade === atual.unidade && data === atual.data) throw new Error('Unidade e data são as mesmas do lançamento atual.');
  const novoId = docId(unidade, data);
  const colisao = await COLLECTION.doc(novoId).get();
  if (colisao.exists) throw new Error('Já existe um fechamento lançado para essa unidade nessa data.');
  const historico = [...(atual.historico || []), {
    em: new Date().toISOString(),
    por: editadoPorEmail,
    motivo: motivo || 'Unidade/data corrigidas pelo Master',
    valoresAnteriores: { unidade: atual.unidade, data: atual.data },
    valoresNovos: { unidade, data },
  }];
  const novo = {
    ...atual,
    id: novoId,
    unidade,
    unidadeNome: unidade === atual.unidade ? atual.unidadeNome : (novaUnidadeNome || unidade),
    data,
    historico,
    atualizadoEm: new Date().toISOString(),
  };
  await COLLECTION.doc(novoId).set(novo);
  await ref.delete();
  fechamentosCache.invalidar();
  return novo;
}

// corrigir o fechamento depois disso o Master usa editarDireto normalmente.
async function removerEdicao(id) {
  await EDITS.doc(id).delete();
  edicoesCache.invalidar();
}

async function decidirEdicao(id, status, { decididoPorEmail, motivoDecisao }) {
  if (!['APROVADO', 'REJEITADO'].includes(status)) throw new Error('Status inválido.');
  const ref = EDITS.doc(id);
  const doc = await ref.get();
  if (!doc.exists) throw new Error('Pedido não encontrado.');
  const pedido = doc.data();
  if (pedido.status !== 'PENDENTE') throw new Error('Esse pedido já foi decidido.');

  // valida ANTES de marcar como decidido - mudar a data efetivamente troca o
  // ID do documento (ver docId), entao precisa garantir que o destino ainda
  // esta livre (pode ter mudado desde o pedido) antes de comprometer a decisao
  if (status === 'APROVADO' && pedido.tipoCorrecao === 'data') {
    const colisao = await COLLECTION.doc(docId(pedido.unidade, pedido.novaData)).get();
    if (colisao.exists) throw new Error('Já existe um fechamento lançado para essa unidade nessa data.');
  }

  await ref.update({
    status,
    decididoPorEmail,
    motivoDecisao: motivoDecisao || null,
    decididoEm: new Date().toISOString(),
  });
  edicoesCache.invalidar();

  if (status === 'APROVADO') {
    const fechRef = COLLECTION.doc(pedido.fechamentoId);
    const fechDoc = await fechRef.get();
    if (fechDoc.exists) {
      const atual = fechDoc.data();

      if (pedido.tipoCorrecao === 'excluir') {
        await fechRef.delete();
        fechamentosCache.invalidar();
        return { ...pedido, status };
      }

      // saida-item grava por conta propria (editarItemSaida ja escreve o
      // documento e o historico) - por isso retorna aqui em vez de cair no
      // bloco comum lá embaixo, que gravaria de novo por cima
      if (pedido.tipoCorrecao === 'saida-item') {
        await editarItemSaida({
          fechamentoId: pedido.fechamentoId,
          indice: pedido.itemNovo.indice,
          descricao: pedido.itemNovo.descricao,
          valor: pedido.itemNovo.valor,
          motivo: `Ticket #${pedido.numeroTicket} · ${pedido.motivo || ''}`.trim(),
          editadoPorEmail: decididoPorEmail,
        });
        return { ...pedido, status };
      }

      if (pedido.tipoCorrecao === 'data') {
        const novoId = docId(pedido.unidade, pedido.novaData);
        const historico = [...(atual.historico || []), {
          em: new Date().toISOString(),
          por: decididoPorEmail,
          motivo: pedido.motivo,
          valoresAnteriores: { data: atual.data },
          valoresNovos: { data: pedido.novaData },
        }];
        await COLLECTION.doc(novoId).set({ ...atual, id: novoId, data: pedido.novaData, historico, atualizadoEm: new Date().toISOString() });
        await fechRef.delete();
        fechamentosCache.invalidar();
        return { ...pedido, status };
      }

      let camposMudados; // pra saber o que recalcular/registrar no historico
      let novosValores;

      if (pedido.tipoCorrecao === 'item') {
        const { tipo, descricao, valor } = pedido.itemNovo;
        if (tipo === 'maquininha') {
          novosValores = {
            detalhesMaquinas: [...(atual.detalhesMaquinas || []), { descricao, valor }],
            adyen: +(num(atual.adyen) + valor).toFixed(2),
          };
          camposMudados = { adyen: novosValores.adyen };
        } else if (tipo === 'maquininhaPos') {
          novosValores = {
            detalhesMaquinasPos: [...(atual.detalhesMaquinasPos || []), { descricao, valor }],
            adyenPos: +(num(atual.adyenPos) + valor).toFixed(2),
          };
          camposMudados = { adyenPos: novosValores.adyenPos };
        } else {
          novosValores = {
            detalhesSaidas: [...(atual.detalhesSaidas || []), { descricao, valor }],
            totalSaida: +(num(atual.totalSaida) + valor).toFixed(2),
          };
          camposMudados = { totalSaida: novosValores.totalSaida };
        }
      } else {
        novosValores = { ...pedido.mudancas };
        camposMudados = pedido.mudancas;
        // patches dos mapas extras do grupo (canais/formas/KPIs) - mesmo
        // merge do editarDireto: so os campos pedidos mudam, o resto fica
        const canaisP = pedido.mudancasCanais || {};
        const formasP = pedido.mudancasFormas || {};
        const kpisP = pedido.mudancasKpis || {};
        if (Object.keys(canaisP).length) novosValores.canaisVendaExtras = { ...(atual.canaisVendaExtras || {}), ...canaisP };
        if (Object.keys(formasP).length) novosValores.formasPagamentoExtras = { ...(atual.formasPagamentoExtras || {}), ...formasP };
        if (Object.keys(kpisP).length) novosValores.kpisExtras = { ...(atual.kpisExtras || {}), ...kpisP };
      }

      const valoresAnteriores = {};
      Object.keys(camposMudados).forEach((campo) => { valoresAnteriores[campo] = atual[campo]; });
      ['mudancasCanais', 'mudancasFormas', 'mudancasKpis'].forEach((chave) => {
        const mapaAtual = chave === 'mudancasCanais' ? atual.canaisVendaExtras : chave === 'mudancasFormas' ? atual.formasPagamentoExtras : atual.kpisExtras;
        Object.keys(pedido[chave] || {}).forEach((campo) => { valoresAnteriores[campo] = (mapaAtual || {})[campo]; });
      });
      const merged = { ...atual, ...novosValores };
      recomputarTotais(merged, camposMudados, await defsExtrasDaUnidade(atual.unidade));
      novosValores.faturamento = merged.faturamento;
      novosValores.totalDeclarado = merged.totalDeclarado;
      novosValores.diferenca = merged.diferenca;

      const historico = [...(atual.historico || []), {
        em: new Date().toISOString(),
        por: decididoPorEmail,
        motivo: pedido.motivo,
        valoresAnteriores,
        valoresNovos: pedido.tipoCorrecao === 'item'
          ? { itemNovo: pedido.itemNovo }
          : { ...pedido.mudancas, ...(pedido.mudancasCanais || {}), ...(pedido.mudancasFormas || {}), ...(pedido.mudancasKpis || {}) },
      }];
      await fechRef.update({ ...novosValores, historico, atualizadoEm: new Date().toISOString() });
      fechamentosCache.invalidar();
    }
  }
  return { ...pedido, status };
}


function invalidarCache() {
  fechamentosCache.invalidar();
}

module.exports = {
  editarItemSaida, adicionarSaidaDireto,
  CAMPOS_NUMERICOS, create, listAll, listByUnidades, getOne, solicitarEdicao, listarEdicoes, getEdicao,
  decidirEdicao, editarDireto, moverFechamento, removerEdicao, remove, invalidarCache, marcarNotificacaoVistaEdicao, redirecionarEdicao,
  suspenderInvalidacao, retomarInvalidacao,
  backfillQuebraCaixa,
};

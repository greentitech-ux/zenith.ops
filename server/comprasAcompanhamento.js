// comprasAcompanhamento.js
// A visao do GERENTE sobre os pedidos de compra da loja dele.
//
// Por que existe: a Central/Historico e a tela de QUEM DECIDE - kanban com
// aprovar/rejeitar/atribuir, e mostrando os 7 tipos de ticket misturados.
// Quem PEDE tem outra pergunta, e ela nao era respondida em lugar nenhum:
// "o que eu pedi ja foi aprovado? ja compraram? chega quando?". Pra
// responder isso a pessoa tinha que abrir ticket por ticket.
//
// Aqui a compra vira uma LINHA DO TEMPO de 4 paradas (pedido -> aprovado ->
// comprado -> entregue), com a data de cada uma e ha quantos dias esta
// parada na atual. E o "parada ha N dias" que faz a tela ter utilidade: sem
// isso ela seria so uma lista de status, e a pergunta real do gerente e
// sempre "o que esta travado?".
//
// Modulo PURO de proposito (nao le Firestore, nao conhece req/res): recebe a
// lista de solicitacoes e a data de hoje e devolve o que a tela mostra. Toda
// a regra de etapa/atraso da pra testar sem subir servidor - ver
// teste-compras.js.
'use strict';

const FUSO_BR = 'America/Sao_Paulo';
const hojeBrasiliaISO = () => new Date().toLocaleDateString('sv-SE', { timeZone: FUSO_BR });

// as 4 paradas + os 2 finais que nao sao "entregue". A ordem aqui e a ordem
// da linha do tempo na tela.
const ETAPAS = [
  { id: 'aguardando', rotulo: 'Aguardando aprovação', icone: '⏳', aberta: true },
  { id: 'aprovada', rotulo: 'Aprovada · aguardando compra', icone: '✅', aberta: true },
  { id: 'comprada', rotulo: 'Comprada · a caminho', icone: '🚚', aberta: true },
  { id: 'entregue', rotulo: 'Entregue', icone: '📦', aberta: false },
  { id: 'recusada', rotulo: 'Recusada', icone: '❌', aberta: false },
  // o ticket saiu de "compra" e virou outra coisa (ver mudarTipo/
  // converterParaEstorno em solicitacoes.js). Sem essa etapa ele sumiria da
  // tela sem explicacao, que e pior do que aparecer marcado como convertido
  { id: 'convertida', rotulo: 'Virou outro ticket', icone: '🔀', aberta: false },
];
const ETAPA_POR_ID = Object.fromEntries(ETAPAS.map((e) => [e.id, e]));

// quantos dias uma compra pode ficar na mesma etapa ABERTA antes de contar
// como travada. Nao e SLA formal (isso e prioridades.js, e vale pra quem
// atende) - e o limite de paciencia de quem pediu.
const DIAS_PARA_COBRAR = { aguardando: 3, aprovada: 5, comprada: 10 };

const soData = (iso) => (iso ? String(iso).slice(0, 10) : null);

// diferenca em dias entre duas datas ISO (AAAA-MM-DD), pelo calendario -
// Date.UTC evita que horario de verao/fuso tire ou coloque um dia
function diasEntre(de, ate) {
  const a = soData(de); const b = soData(ate);
  if (!a || !b) return null;
  const ms = Date.UTC(...b.split('-').map(Number).map((v, i) => (i === 1 ? v - 1 : v)))
    - Date.UTC(...a.split('-').map(Number).map((v, i) => (i === 1 ? v - 1 : v)));
  return Math.round(ms / 86400000);
}

// em que parada a compra esta. A ordem dos ifs importa: 'comprada' e um
// campo separado que so existe DEPOIS de aprovado, e execucaoStatus
// 'FINALIZADO' vence os dois (compra que ja chegou nao esta "a caminho").
function etapaDaCompra(c) {
  if (c.status === 'CONVERTIDO') return 'convertida';
  if (c.status === 'REJEITADO') return 'recusada';
  if (c.status !== 'APROVADO') return 'aguardando';
  if (c.execucaoStatus === 'FINALIZADO') return 'entregue';
  return c.comprada ? 'comprada' : 'aprovada';
}

// as datas de cada parada, na ordem - alimentam a linha do tempo e o
// "parada desde". Parada que ainda nao aconteceu fica com data null.
function marcosDaCompra(c) {
  return {
    pedida: soData(c.criadoEm),
    decidida: soData(c.decididoEm),
    comprada: c.comprada ? soData(c.marcadoCompradoEm) : null,
    entregaPrevista: c.dataEntregaPrevista || null,
    // execucaoStatus nao guarda quando mudou; a data da compra e a ultima
    // informacao confiavel que existe pra "desde quando"
    finalizada: c.execucaoStatus === 'FINALIZADO' ? (soData(c.marcadoCompradoEm) || soData(c.decididoEm)) : null,
  };
}

// desde quando esta parado NA ETAPA ATUAL (nao desde que foi pedido) - e o
// numero que diz onde cobrar. Cai pra criadoEm quando a etapa nao tem data
// propria, que e melhor do que nao mostrar nada.
function paradaDesde(c, etapa, marcos) {
  if (etapa === 'aguardando') return marcos.pedida;
  if (etapa === 'aprovada') return marcos.decidida || marcos.pedida;
  if (etapa === 'comprada') return marcos.comprada || marcos.decidida || marcos.pedida;
  return null; // etapas fechadas nao "esperam" por ninguem
}

// total do pedido: usa o valor estimado quando existe; senao soma os itens
// (quantidade x valor unitario) pros pedidos que foram detalhados item a item
function valorDaCompra(c) {
  if (c.valorEstimado != null && c.valorEstimado !== '') return Number(c.valorEstimado) || 0;
  return (c.itens || []).reduce((s, it) => s + (Number(it.valorUnitario) || 0) * (Number(it.quantidade) || 0), 0);
}

// uma linha da tela
function montarLinha(c, hoje) {
  const etapa = etapaDaCompra(c);
  const marcos = marcosDaCompra(c);
  const desde = paradaDesde(c, etapa, marcos);
  const diasParada = desde ? Math.max(0, diasEntre(desde, hoje)) : null;
  const limite = DIAS_PARA_COBRAR[etapa];
  // entrega prevista que ja passou e a compra nao chegou: atrasa mesmo que
  // esteja dentro do limite de dias da etapa - a loja recebeu uma data e ela
  // nao foi cumprida, e isso vale mais que qualquer limite generico
  const entregaVencida = !!(marcos.entregaPrevista && etapa === 'comprada' && marcos.entregaPrevista < hoje);
  return {
    id: c.id,
    numeroTicket: c.numeroTicket || null,
    titulo: c.titulo || '',
    unidade: c.unidade,
    unidadeNome: c.unidadeNome || c.unidade,
    itens: c.itens || [],
    qtdItens: (c.itens || []).length,
    valor: valorDaCompra(c),
    valorEstimado: c.valorEstimado != null ? Number(c.valorEstimado) || 0 : null,
    ehOrcamento: !!c.ehOrcamento,
    prioridade: c.prioridade || null,
    criadoPorEmail: c.criadoPorEmail || null,
    observacao: c.observacao || '',
    motivoDecisao: c.motivoDecisao || null,
    decididoPorEmail: c.decididoPorEmail || null,
    temComprovante: !!c.comprovante,
    qtdAnexos: (c.anexos || []).length,
    teste: !!c.teste,
    convertidoParaTipo: c.convertidoParaTipo || null,
    etapa,
    etapaRotulo: ETAPA_POR_ID[etapa].rotulo,
    etapaIcone: ETAPA_POR_ID[etapa].icone,
    aberta: ETAPA_POR_ID[etapa].aberta,
    marcos,
    paradaDesde: desde,
    diasParada,
    entregaVencida,
    travada: entregaVencida || (limite != null && diasParada != null && diasParada > limite),
    limiteDaEtapa: limite != null ? limite : null,
  };
}

// contadores do topo. "valorAberto" soma so o que ainda pode virar despesa
// (etapa aberta) - somar recusada/entregue no mesmo numero daria um total
// que nao significa nada.
function resumir(linhas) {
  const porEtapa = Object.fromEntries(ETAPAS.map((e) => [e.id, 0]));
  let valorAberto = 0; let travadas = 0;
  linhas.forEach((l) => {
    porEtapa[l.etapa] = (porEtapa[l.etapa] || 0) + 1;
    if (l.aberta) valorAberto += l.valor;
    if (l.travada) travadas += 1;
  });
  return {
    total: linhas.length,
    abertas: linhas.filter((l) => l.aberta).length,
    travadas,
    valorAberto,
    porEtapa,
  };
}

// ponto de entrada: lista crua de solicitacoes -> o que a tela desenha.
// Filtra tipo 'compra' aqui dentro pra quem chama nao precisar lembrar.
// Ordem: travadas primeiro (e o que precisa de acao), depois as abertas mais
// antigas - uma lista por data de criacao enterraria justamente o pedido
// esquecido, que e o que a tela existe pra achar.
function montar(solicitacoes, { hoje = hojeBrasiliaISO(), etapa = null, unidade = null } = {}) {
  let linhas = (solicitacoes || [])
    .filter((c) => c && c.tipo === 'compra')
    .map((c) => montarLinha(c, hoje));

  // o resumo conta a UNIDADE filtrada, mas nao a etapa: os contadores por
  // etapa sao a propria navegacao entre etapas, e recontar depois do filtro
  // zeraria todos os outros botoes
  if (unidade) linhas = linhas.filter((l) => l.unidade === unidade);
  const resumo = resumir(linhas);
  if (etapa) linhas = linhas.filter((l) => l.etapa === etapa);

  linhas.sort((a, b) => {
    if (a.travada !== b.travada) return a.travada ? -1 : 1;
    if (a.aberta !== b.aberta) return a.aberta ? -1 : 1;
    if (a.aberta) return (a.paradaDesde || '').localeCompare(b.paradaDesde || '');
    return (b.marcos.pedida || '').localeCompare(a.marcos.pedida || '');
  });
  return { etapas: ETAPAS, linhas, resumo, hoje };
}

module.exports = {
  ETAPAS, ETAPA_POR_ID, DIAS_PARA_COBRAR,
  hojeBrasiliaISO, diasEntre, etapaDaCompra, marcosDaCompra, valorDaCompra,
  montarLinha, resumir, montar,
};

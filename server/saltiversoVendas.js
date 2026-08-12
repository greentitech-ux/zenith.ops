// saltiversoVendas.js
// Venda avulsa de bebidas/meias no balcão do Saltiverso Patteo - reaproveita
// o catálogo genérico de inventario.js (itens tipo BEBIDA/MEIA daquela
// unidade, com preço de venda próprio - ver `precoVenda` em
// inventario.criarItem) e o mesmo split de forma de pagamento já usado no
// check-in do parque (ver FORMAS_PAGAMENTO_SPLIT em parque.js).
//
// O PREÇO de cada item vem SEMPRE do catálogo (nunca do que o cliente
// manda) - mesma regra de "servidor nunca confia em valor financeiro vindo
// do front" já usada em toda a tabela de preços do parque/festas. Isso
// fecha a brecha óbvia de alguém reportar um preço menor pra desviar a
// diferença em dinheiro.
//
// Cada venda gera automaticamente uma Saída (tipo VENDA) por item no
// inventário, com o vendaId apontando de volta pra essa venda - é o que dá
// rastreabilidade: se alguém vender por fora sem passar por aqui, a próxima
// contagem física vai mostrar falta (ver upsertContagem/
// verificarDesvioEstoque em inventario.js), sem precisar de auditoria
// manual item por item.
const db = require('./firestore');
const { createCache } = require('./liveCache');
const inventario = require('./inventario');
const { FORMAS_PAGAMENTO_SPLIT } = require('./parque');

const COLLECTION = db.collection('saltiversoVendas');
const FUSO_BR = 'America/Sao_Paulo';

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function arred(v) {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

// venda é sempre "agora" (balcão, ponto de venda em tempo real) - diferente
// do check-in do parque, que pode ser vendido pra uma data futura, aqui não
// existe pré-venda, então a data nunca vem do cliente
function hojeBrasiliaISO() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO_BR, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const o = {};
  partes.forEach((p) => { if (p.type !== 'literal') o[p.type] = p.value; });
  return `${o.year}-${o.month}-${o.day}`;
}

// so aceita itemId+quantidade do cliente - preco/nome vem do catalogo (ver
// criarVenda)
function sanitizarCarrinho(lista) {
  if (!Array.isArray(lista) || !lista.length) throw new Error('Adicione pelo menos um item ao carrinho.');
  const limpos = lista
    .map((i) => ({ itemId: i && i.itemId, quantidade: Math.round(num(i && i.quantidade)) }))
    .filter((i) => i.itemId && i.quantidade > 0)
    .slice(0, 30);
  if (!limpos.length) throw new Error('Carrinho inválido.');
  return limpos;
}

// mesmo padrão de sanitizarPagamentos do parque.js (dinheiro/pix/débito/
// crédito/voucher) - duplicado aqui de propósito (não vale a pena acoplar
// os dois módulos só por causa dessa função pequena)
function sanitizarPagamentos(lista) {
  if (!Array.isArray(lista)) return [];
  return lista
    .map((p) => ({
      forma: FORMAS_PAGAMENTO_SPLIT.includes(p && p.forma) ? p.forma : null,
      valor: arred(Math.max(0, num(p && p.valor))),
    }))
    .filter((p) => p.forma && p.valor > 0)
    .slice(0, 10);
}

async function criarVenda({ unidade, unidadeNome, itens, pagamentos, criadoPorId, criadoPorEmail }) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  const carrinho = sanitizarCarrinho(itens);
  const catalogo = await inventario.listCatalogo(unidade);
  const catalogoPorId = new Map(catalogo.map((i) => [i.id, i]));

  const itensOk = carrinho.map((linha) => {
    const item = catalogoPorId.get(linha.itemId);
    if (!item) throw new Error('Item não encontrado no catálogo dessa unidade.');
    if (!(item.precoVenda > 0)) throw new Error(`"${item.nome}" não tem preço de venda cadastrado.`);
    return { itemId: item.id, nome: item.nome, quantidade: linha.quantidade, precoUnitario: item.precoVenda };
  });
  const total = arred(itensOk.reduce((s, i) => s + i.quantidade * i.precoUnitario, 0));

  const pagamentosOk = sanitizarPagamentos(pagamentos);
  if (!pagamentosOk.length) throw new Error('Informe pelo menos uma forma de pagamento.');
  const somaPagamentos = arred(pagamentosOk.reduce((s, p) => s + p.valor, 0));
  if (Math.abs(somaPagamentos - total) > 0.01) {
    throw new Error(`A soma das formas de pagamento (R$${somaPagamentos.toFixed(2)}) precisa bater com o valor total (R$${total.toFixed(2)}).`);
  }

  const data = hojeBrasiliaISO();
  const ref = COLLECTION.doc();
  // cada linha vira uma Saída no inventário (rastreabilidade - ver
  // cabeçalho do arquivo); catálogo já validado acima, então só falta
  // Firestore falhar de verdade pra isso quebrar no meio
  const itensComSaida = [];
  for (const item of itensOk) {
    // sequencial (nao Promise.all) de proposito: se uma saida falhar no
    // meio, o pedido para AQUI em vez de disparar todas em paralelo e
    // deixar mais itens "penduradas" pra reconciliar manualmente depois
    const saida = await inventario.criarSaida({
      unidade,
      unidadeNome: unidadeNome || unidade,
      itemId: item.itemId,
      tipo: 'VENDA',
      quantidade: item.quantidade,
      motivo: 'Venda balcão Saltiverso',
      data,
      valorUnitario: item.precoUnitario,
      vendaId: ref.id,
      criadoPorId,
      criadoPorEmail,
    });
    itensComSaida.push({ ...item, saidaId: saida.id });
  }

  const registro = {
    id: ref.id,
    unidade,
    unidadeNome: unidadeNome || unidade,
    data,
    itens: itensComSaida,
    total,
    pagamentos: pagamentosOk,
    cancelada: false,
    canceladaEm: null,
    canceladaPorId: null,
    canceladaPorEmail: null,
    criadoPorId,
    criadoPorEmail,
    criadoEm: new Date().toISOString(),
  };
  await ref.set(registro);
  vendasCache.invalidar();
  return registro;
}

// cancelamento e' sempre Master (mesmo criterio de DELETE /api/inventario/
// saidas|recebimentos/:id, que ja e' Master-only hoje - mexer no historico
// financeiro/estoque nao passa por fluxo de correcao, e direto) - soft
// delete (mantem o registro pra auditoria) + reverte cada saida gerada
async function cancelarVenda(id, { porId, porEmail }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Venda não encontrada.');
  const atual = snap.data();
  if (atual.cancelada) throw new Error('Essa venda já foi cancelada.');

  for (const item of (atual.itens || [])) {
    if (!item.saidaId) continue;
    try {
      await inventario.removerSaida(item.saidaId);
    } catch (err) {
      // saida pode ja ter sido removida manualmente antes - nao trava o
      // cancelamento da venda por causa disso
    }
  }

  await ref.update({
    cancelada: true,
    canceladaEm: new Date().toISOString(),
    canceladaPorId: porId || null,
    canceladaPorEmail: porEmail || null,
  });
  vendasCache.invalidar();
  return getOne(id);
}

async function getOne(id) {
  const doc = await COLLECTION.doc(id).get();
  return doc.exists ? doc.data() : null;
}

async function listAllUncached() {
  const snap = await COLLECTION.orderBy('data', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const vendasCache = createCache(listAllUncached, 5 * 60 * 1000);
const listAll = vendasCache.cached;

async function listVendasDoDia(unidade, data) {
  return (await listAll()).filter((v) => v.unidade === unidade && v.data === data);
}

// total + breakdown por forma, ignorando vendas canceladas - usado pelo
// fechamento dedicado do Saltiverso (ver saltiversoFechamento.js), mesmo
// formato de retorno do parque.resumoDoDia pra dar pra somar os dois direto
async function resumoDoDia(unidade, data) {
  const vendas = (await listVendasDoDia(unidade, data)).filter((v) => !v.cancelada);
  const porForma = {};
  FORMAS_PAGAMENTO_SPLIT.forEach((f) => { porForma[f] = 0; });
  let total = 0;
  vendas.forEach((v) => {
    total += num(v.total);
    (v.pagamentos || []).forEach((p) => {
      if (porForma[p.forma] != null) porForma[p.forma] += num(p.valor);
    });
  });
  Object.keys(porForma).forEach((f) => { porForma[f] = arred(porForma[f]); });
  return { total: arred(total), porForma };
}

module.exports = {
  criarVenda, cancelarVenda, getOne, listAll, listVendasDoDia, resumoDoDia,
  invalidar: () => vendasCache.invalidar(),
};

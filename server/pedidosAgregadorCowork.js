// Somente a fonte financeira já sincronizada. Não faz polling operacional
// nem aceita/cancela pedidos dos agregadores.
const { periodo, normalizar, mascarar } = require('./pedidosMonitor');
async function buscar(p, fonte = require('./ifoodStore')) {
  const canal = String(p.canal || '').toUpperCase();
  if (!['IFOOD', '99FOOD'].includes(canal)) throw new Error('Informe canal IFOOD ou 99FOOD.');
  if (canal === '99FOOD') return { disponivel: false, canal, motivo: 'Não há integração de consulta de pedidos 99Food neste servidor. A fila operacional de agregadores não contém os pedidos dos clientes.' };
  const janela = periodo(p), termo = normalizar(p.unidade), limite = p.limite ?? 20, pagina = p.pagina ?? 1;
  if (!termo) throw new Error('Informe a unidade.');
  if (!Number.isInteger(limite) || limite < 1 || limite > 100) throw new Error('limite deve ser inteiro entre 1 e 100.');
  if (!Number.isSafeInteger(pagina) || pagina < 1 || pagina > 1000000) throw new Error('pagina deve ser inteiro entre 1 e 1000000.');
  const dados = await fonte.listAllCached();
  if (!dados.length) return { disponivel: false, canal, motivo: 'Não há vendas iFood sincronizadas. Confira credenciais, cadastro de merchants e sincronização; isto não significa ausência de pedidos/cancelamentos.' };
  const lojas = [...new Map(dados.map((x) => [x.unidade, { codigo: x.unidade, nome: x.unidadeNome, unidadeCodigo: x.unidadeCodigo }])).values()];
  let canonica = null;
  try { canonica = await require('./coworkCatalogo').resolverUnidade(p.unidade); } catch { /* base legada aceita merchantId exato */ }
  const exatas = lojas.filter((u) => [normalizar(u.codigo), normalizar(u.nome)].includes(termo));
  const vinculadas = canonica ? lojas.filter(u => u.unidadeCodigo === canonica.codigo || normalizar(u.nome) === normalizar(canonica.nome) || normalizar(u.nome) === normalizar(canonica.codigo)) : [];
  const candidatas = vinculadas.length ? vinculadas : exatas.length ? exatas : lojas.filter((u) => normalizar(u.nome).includes(termo));
  if (!candidatas.length || (!vinculadas.length && new Set(candidatas.map(u=>normalizar(u.nome))).size !== 1)) throw new Error('Unidade ausente ou ambígua na base iFood sincronizada. Informe o nome completo ou merchantId.');
  const merchants = new Set(candidatas.map(u=>u.codigo));
  const resultado = dados.filter((x) => merchants.has(x.unidade) && Date.parse(x.dataHora) >= janela.desde && Date.parse(x.dataHora) <= janela.ate
    && (!p.numeroPedido || String(x.numeroPedido) === String(p.numeroPedido)) && (!p.status || normalizar(x.status) === normalizar(p.status)))
    .sort((a, b) => String(b.dataHora).localeCompare(String(a.dataHora)));
  const valor = v => v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
  const agregado = itens => ({ pedidos: itens.length, valorBrutoConhecido: Math.round(itens.reduce((s,x)=>s+(valor(x.valorBruto)||0),0)*100)/100,
    semValorBruto: itens.filter(x=>valor(x.valorBruto)==null).length,
    cancelados: itens.filter(x=>/^(CANCELLED|CANCELED|CANCELADO)$/i.test(x.status||'')).length,
    semStatus: itens.filter(x=>!x.status).length });
  const inicio = (pagina-1)*limite;
  return { disponivel: true, canal, fonte: 'iFood Sales API sincronizada (não operacional/tempo real)', total: resultado.length,
    pagina, limite, proximaPagina: inicio+limite<resultado.length ? pagina+1 : null,
    resumo: {...agregado(resultado), porMerchant:candidatas.map(m=>({merchantId:m.codigo,nome:m.nome,...agregado(resultado.filter(x=>x.unidade===m.codigo))}))},
    pedidos: resultado.slice(inicio, inicio+limite).map((x) => ({ id: x.id, numeroPedido: x.numeroPedido, unidade: x.unidade, unidadeNome: x.unidadeNome,
      merchant:{id:x.unidade,nome:x.merchantNome||x.unidadeNome}, pulseId:x.pulseId||null,
      data: x.dataHora, valorBruto: valor(x.valorBruto), valorLiquido: valor(x.valorLiquido), status: x.status || 'NAO_INFORMADO',
      motivoCancelamento: x.motivoCancelamento ? mascarar(x.motivoCancelamento).slice(0,300) : null })),
    cobertura: 'Status financeiro recebido da fonte. Ausência na janela não comprova inexistência de pedido; confirmação operacional de cancelamento pode não estar disponível.' };
}
module.exports = { buscar };

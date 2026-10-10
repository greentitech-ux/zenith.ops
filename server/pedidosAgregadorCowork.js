// Somente a fonte financeira já sincronizada. Não faz polling operacional
// nem aceita/cancela pedidos dos agregadores.
const { periodo, normalizar } = require('./pedidosMonitor');
async function buscar(p, fonte = require('./ifoodStore')) {
  const canal = String(p.canal || '').toUpperCase();
  if (!['IFOOD', '99FOOD'].includes(canal)) throw new Error('Informe canal IFOOD ou 99FOOD.');
  if (canal === '99FOOD') return { disponivel: false, canal, motivo: 'Não há integração de consulta de pedidos 99Food neste servidor. A fila operacional de agregadores não contém os pedidos dos clientes.' };
  const janela = periodo(p), termo = normalizar(p.unidade), limite = p.limite ?? 20;
  if (!termo) throw new Error('Informe a unidade.');
  if (!Number.isInteger(limite) || limite < 1 || limite > 100) throw new Error('limite deve ser inteiro entre 1 e 100.');
  const dados = await fonte.listAllCached();
  if (!dados.length) return { disponivel: false, canal, motivo: 'Não há vendas iFood sincronizadas. Confira credenciais, cadastro de merchants e sincronização; isto não significa ausência de pedidos/cancelamentos.' };
  const lojas = [...new Map(dados.map((x) => [x.unidade, { codigo: x.unidade, nome: x.unidadeNome }])).values()];
  const exatas = lojas.filter((u) => [normalizar(u.codigo), normalizar(u.nome)].includes(termo));
  const candidatas = exatas.length ? exatas : lojas.filter((u) => normalizar(u.nome).includes(termo));
  if (candidatas.length !== 1) throw new Error('Unidade ausente ou ambígua na base iFood sincronizada. Informe o nome completo ou merchantId.');
  const resultado = dados.filter((x) => x.unidade === candidatas[0].codigo && Date.parse(x.dataHora) >= janela.desde && Date.parse(x.dataHora) <= janela.ate
    && (!p.numeroPedido || String(x.numeroPedido) === String(p.numeroPedido)) && (!p.status || normalizar(x.status) === normalizar(p.status)))
    .sort((a, b) => String(b.dataHora).localeCompare(String(a.dataHora)));
  return { disponivel: true, canal, fonte: 'iFood Sales API sincronizada (não operacional/tempo real)', total: resultado.length,
    pedidos: resultado.slice(0, limite).map((x) => ({ id: x.id, numeroPedido: x.numeroPedido, unidade: x.unidade, unidadeNome: x.unidadeNome,
      data: x.dataHora, valorBruto: x.valorBruto, status: x.status || 'NAO_INFORMADO' })),
    cobertura: 'Status financeiro recebido da fonte. Ausência na janela não comprova inexistência de pedido; confirmação operacional de cancelamento pode não estar disponível.' };
}
module.exports = { buscar };

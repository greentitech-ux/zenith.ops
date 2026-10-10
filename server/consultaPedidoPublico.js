// Escolher uma loja não autentica o visitante. A consulta pública só devolve
// um status após coincidência única de nome completo + valor + identificador.
const monitor = require('./pedidosMonitor');
async function consultar(input, { buscar = monitor.buscar, consumirTentativa, unidadeFixa = null } = {}) {
  const nome = monitor.normalizar(input.nomeCliente);
  if (!String(input.unidade || '').trim()) return { aviso: 'Pergunte o nome da loja do pedido; não é necessário fazer login.' };
  if (nome.split(' ').filter(Boolean).length < 2 || (!/^\d{4}$/.test(input.finalCartao || '') && !String(input.numeroPedido || '').trim())) {
    return { aviso: 'Para consultar sem login, peça nome completo, valor, loja, data e número do pedido ou os quatro últimos dígitos do cartão. Nunca peça o cartão completo, CPF ou senha.' };
  }
  const texto = String(input.valor ?? '').replace(/[^\d,.-]/g, '');
  const valor = Number(texto.includes(',') ? texto.replace(/\./g, '').replace(',', '.') : texto);
  if (!Number.isFinite(valor) || valor <= 0) return { aviso: 'Confirme o valor em reais.' };
  const janela = monitor.periodo({ desde: input.data, ate: input.data });
  if (janela.ate - janela.desde > 86400000) throw new Error('Consulta pública limitada a um dia.');
  await consumirTentativa();
  const r = await buscar({ unidade: input.unidade, desde: input.data, ate: input.data, nomeCliente: nome, valor,
    ...(input.numeroPedido ? { numeroPedido: String(input.numeroPedido).trim() } : {}),
    ...(input.finalCartao ? { finalCartao: input.finalCartao } : {}), limite: 100 });
  // Nunca expor candidatos, PSP, comprador encontrado ou contato em caso de
  // ambiguidade. A pessoa deve trazer o identificador; não escolhe numa lista.
  const exatos = r.pedidos.filter((p) => monitor.normalizar(p.nomeCliente) === nome && Math.round(p.valor * 100) === Math.round(valor * 100)
    && (!unidadeFixa || unidadeFixa.has(p.unidade)));
  if (r.total > r.mostrando || exatos.length !== 1) return { aviso: 'Não foi possível identificar com segurança um único pedido com esses dados. Confirme os dados ou ofereça atendimento humano.' };
  const p = exatos[0];
  return { verificado: { psp: p.psp, pedidoId: p.numeroPedido || p.psp, unidade: p.unidade, cliente: String(input.nomeCliente).trim(), valor: p.valor,
    status: p.statusPagamento === 'AUTORIZADO' ? 'APROVADO' : p.statusPagamento, publico: true },
    publico: { unidade: p.unidadeNome, valor: p.valor, statusPagamento: p.statusPagamento, statusPedido: p.statusPedido,
      observacao: 'Este é o estado do pagamento. Não comprova que o pedido foi finalizado na loja nem crédito de estorno na conta.' } };
}
module.exports = { consultar };

// Consultas do Monitor por pagamento, nunca agrupando PSPs distintos pelo
// número do pedido. Autorização de pagamento não comprova conclusão no PDV.
const normalizar = (v) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ').trim();
const ESTORNOS = new Set(['REFUND', 'CANCEL_OR_REFUND', 'CANCELLATION', 'REFUND_FAILED', 'REFUNDED_REVERSED', 'POSTPONED_REFUND']);
const STATUS = ['AUTORIZADO', 'CAPTURADO', 'CANCELADO', 'ESTORNADO', 'ESTORNADO_PARCIAL', 'RECUSADO', 'FALHA_CAPTURA', 'EXPIRADO', 'CHARGEBACK', 'FALHA_ESTORNO', 'ESTORNO_REVERTIDO', 'ESTORNO_AGENDADO', 'DESCONHECIDO', 'PEDIDO_NAO_FINALIZADO'];
const CANAIS = ['ONLINE', 'TOTEM', 'MAQUININHA', 'IFOOD', '99FOOD', 'NAO_INFORMADO'];
function mascarar(v) {
  return String(v ?? '').replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[e-mail protegido]')
    .replace(/\b\d[\d().\s-]{8,}\d\b/g, '[dado protegido]');
}
const sucesso = (t) => t.success === true || t.success === 'true' || (t.success == null && ['APROVADO', 'ESTORNADO'].includes(t.status));
function statusEvento(t) {
  if (t.eventCode === 'AUTHORISATION') return sucesso(t) ? 'AUTORIZADO' : 'RECUSADO';
  if (t.eventCode === 'CAPTURE_FAILED') return 'FALHA_CAPTURA';
  if (t.eventCode === 'EXPIRE') return 'EXPIRADO';
  if (t.eventCode === 'CHARGEBACK') return 'CHARGEBACK';
  if (t.eventCode === 'REFUND_FAILED' || t.status === 'FALHA_ESTORNO') return 'FALHA_ESTORNO';
  if (t.eventCode === 'REFUNDED_REVERSED') return 'ESTORNO_REVERTIDO';
  if (t.eventCode === 'POSTPONED_REFUND') return 'ESTORNO_AGENDADO';
  if (['REFUND', 'CANCEL_OR_REFUND', 'CANCELLATION', 'CAPTURE'].includes(t.eventCode)) {
    if (!sucesso(t)) return t.success === false || t.success === 'false' ? (ESTORNOS.has(t.eventCode) ? 'FALHA_ESTORNO' : 'RECUSADO') : 'DESCONHECIDO';
    return { REFUND: 'ESTORNADO', CANCEL_OR_REFUND: 'ESTORNADO', CANCELLATION: 'CANCELADO', CAPTURE: 'CAPTURADO' }[t.eventCode];
  }
  return null;
}
function periodo(p = {}, agora = new Date()) {
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(agora);
  const ler = (v, fim) => {
    const s = String(v);
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(s)) throw new Error('Use data ISO AAAA-MM-DD ou data/hora com fuso.');
    const dia = s.slice(0, 10);
    if (new Date(`${dia}T12:00:00Z`).toISOString().slice(0, 10) !== dia) throw new Error('Data inválida.');
    const n = Date.parse(s.length === 10 ? `${s}T${fim ? '23:59:59.999' : '00:00:00'}-03:00` : s);
    if (!Number.isFinite(n)) throw new Error('Data inválida.');
    return n;
  };
  const desde = ler(p.desde || hoje, false), ate = ler(p.ate || (p.desde ? String(p.desde).slice(0, 10) : hoje), true);
  if (ate < desde) throw new Error('O fim do período deve ser posterior ao início.');
  return { desde, ate };
}
function resolverUnidade(termo, mapa) {
  const alvo = normalizar(termo);
  if (!alvo) throw new Error('Informe a unidade.');
  const lista = Object.values(mapa);
  const nomes = (u) => [u.codigo, u.nome, ...(u.apelidos || [])].map(normalizar);
  const exatas = lista.filter((u) => nomes(u).includes(alvo));
  const candidatas = exatas.length ? exatas : lista.filter((u) => nomes(u).some((n) => n.split(' ').includes(alvo) || n.includes(alvo)));
  if (!candidatas.length) throw new Error('Unidade não encontrada. Confirme o nome da loja.');
  if (new Set(candidatas.map((u) => normalizar(u.nome))).size !== 1) throw new Error(`Unidade ambígua. Especifique: ${[...new Set(candidatas.map((u) => u.nome))].join(', ')}.`);
  return candidatas;
}
function pagamentos(transacoes) {
  const porPsp = new Map();
  for (const t of transacoes) if (t.eventCode === 'AUTHORISATION' && t.pspReference) {
    const chave = `${t.merchantAccountCode || t.unidade}\0${t.pspReference}`;
    porPsp.set(chave, { base: t, eventos: [] });
  }
  // Índice evita O(pagamentos × eventos), importante no Monitor em memória.
  const referencias = new Map();
  for (const [chave, p] of porPsp) {
    if (!referencias.has(p.base.pspReference)) referencias.set(p.base.pspReference, []);
    referencias.get(p.base.pspReference).push(chave);
  }
  for (const t of transacoes) {
    const candidatos = referencias.get(t.originalReference || t.pspReference) || [];
    for (const chave of candidatos) {
      const p = porPsp.get(chave);
      if (t.merchantAccountCode && p.base.merchantAccountCode ? t.merchantAccountCode !== p.base.merchantAccountCode : t.unidade !== p.base.unidade) continue;
      p.eventos.push(t);
    }
  }
  for (const p of porPsp.values()) p.eventos.sort((a, b) => String(a.eventDate || a.dataHora || '').localeCompare(String(b.eventDate || b.dataHora || '')));
  return [...porPsp.values()];
}
function linha(t) {
  return { referencia: t.pspReference, evento: t.eventCode, data: t.eventDate || t.dataHora || null,
    dataOrigem: t.eventDate ? 'adyen' : 'recebimento_no_monitor', valor: t.valor, moeda: t.moeda || 'BRL',
    status: statusEvento(t) || t.eventCode, motivo: mascarar(t.motivo) || null };
}
function estadoPagamento(p) {
  const estados = p.eventos.map(statusEvento).filter(Boolean);
  const status = estados.at(-1) || 'DESCONHECIDO';
  const porReferencia = new Map();
  for (const t of p.eventos) if (ESTORNOS.has(t.eventCode)) porReferencia.set(t.pspReference, t);
  const devolvido = [...porReferencia.values()].filter((t) => ['REFUND', 'CANCEL_OR_REFUND'].includes(t.eventCode) && sucesso(t))
    .reduce((s, t) => s + Math.round(Number(t.valor || 0) * 100), 0);
  return { status: status === 'ESTORNADO' && devolvido > 0 && devolvido < Math.round(p.base.valor * 100) ? 'ESTORNADO_PARCIAL' : status,
    valorEstornoProcessado: devolvido / 100 };
}
function projetar(p, mapa, solicitacoes = []) {
  const b = p.base, eventos = p.eventos, estornos = eventos.filter((t) => ESTORNOS.has(t.eventCode));
  const estado = estadoPagamento(p);
  const pedidosLoja = solicitacoes.filter((r) => r.unidade === b.unidade && [b.pspReference, b.merchantReference].filter(Boolean).includes(r.pedidoId));
  return { psp: b.pspReference, numeroPedido: b.merchantReference || null, unidade: b.unidade,
    unidadeNome: mapa[b.unidade]?.nome || b.unidade, data: b.eventDate || b.dataHora, valor: b.valor, moeda: b.moeda || 'BRL',
    statusPagamento: estado.status, valorEstornoProcessado: estado.valorEstornoProcessado, statusPedido: 'NAO_INFORMADO',
    canal: CANAIS.includes(b.canal) ? b.canal : 'NAO_INFORMADO', bandeira: b.metodo || null,
    finalCartao: /^\d{4}$/.test(b.last4 || '') ? `**** ${b.last4}` : null,
    nomeCliente: mascarar(b.nomeCliente || b.cardHolder) || null,
    email: b.emailCliente ? '[e-mail protegido]' : null,
    telefone: b.telefoneCliente ? `***${String(b.telefoneCliente).replace(/\D/g, '').slice(-4)}` : null,
    cancelamentosEstornos: estornos.map(linha),
    solicitacoesLoja: pedidosLoja.map((r) => ({ protocolo: r.numeroTicket || null, data: r.createdAt || r.criadoEm || null,
      valor: r.valorEstornar ?? null, statusSolicitacao: r.status, execucaoInterna: r.execucaoStatus || null,
      solicitadoPor: mascarar(r.requestedByEmail) || null, confirmacaoAdyen: false })),
    previsaoCredito: null, cartaCancelamento: null,
    observacao: 'Pagamento autorizado não comprova pedido finalizado. Solicitação/aprovação interna não comprova estorno. Confirmação Adyen não comprova crédito na conta do cliente; prazo e carta não estão disponíveis nesta fonte.' };
}
function dependencias(op) {
  return op || { store: require('./store'), catalogo: require('./coworkCatalogo'), refunds: require('./refunds') };
}
async function buscar(p = {}, op) {
  const d = dependencias(op);
  if (!d.store.estaCarregado()) throw new Error('Monitor ainda carregando. Tente novamente em instantes.');
  const mapa = await d.catalogo.mapaDeUnidades();
  const unidades = p.unidade ? resolverUnidade(p.unidade, mapa).map((u) => u.codigo) : null;
  const janela = periodo(p), limite = p.limite ?? 20;
  if (!Number.isInteger(limite) || limite < 1 || limite > 100) throw new Error('limite deve ser inteiro entre 1 e 100.');
  if (p.valor != null && (typeof p.valor !== 'number' || !Number.isFinite(p.valor) || p.valor <= 0)) throw new Error('valor deve ser um número positivo em reais.');
  if (p.finalCartao != null && !/^\d{4}$/.test(p.finalCartao)) throw new Error('finalCartao deve conter exatamente 4 dígitos.');
  if (p.status && !STATUS.includes(p.status)) throw new Error('Status inválido para o Monitor.');
  if (p.status === 'PEDIDO_NAO_FINALIZADO') throw new Error('O Monitor não recebe conclusão do pedido no PDV; não é possível filtrar pedido não finalizado pela autorização do pagamento.');
  if (p.canal && !CANAIS.includes(p.canal)) throw new Error('Canal inválido.');
  const contato = normalizar(p.emailOuTelefone), digitos = String(p.emailOuTelefone || '').replace(/\D/g, '');
  if (contato && !contato.includes('@') && digitos.length < 8) throw new Error('Informe o e-mail ou telefone completo para buscar.');
  const itens = pagamentos(d.store.allTransactions()).filter(({ base: b, eventos }) => {
    const data = Date.parse(b.eventDate || b.dataHora);
    return (!unidades || unidades.includes(b.unidade)) && (!d.unidadesPermitidas || d.unidadesPermitidas.has(b.unidade)) && data >= janela.desde && data <= janela.ate
      && (!p.nomeCliente || normalizar(b.nomeCliente || b.cardHolder).includes(normalizar(p.nomeCliente)))
      && (p.valor == null || Math.abs(Math.round(b.valor * 100) - Math.round(p.valor * 100)) <= 10)
      && (!p.finalCartao || b.last4 === p.finalCartao)
      && (!contato || (contato.includes('@') ? normalizar(b.emailCliente) === contato : String(b.telefoneCliente || '').replace(/\D/g, '') === digitos))
      && (!p.numeroPedido || String(b.merchantReference) === String(p.numeroPedido)) && (!p.psp || b.pspReference === p.psp)
      && (!p.status || estadoPagamento({ base: b, eventos }).status === p.status)
      && (!p.canal || (b.canal || 'NAO_INFORMADO') === p.canal);
  }).sort((a, b) => String(b.base.eventDate || b.base.dataHora).localeCompare(String(a.base.eventDate || a.base.dataHora)));
  const solicitacoes = itens.length && !d.somentePublico ? await d.refunds.listAll() : [];
  return { fonte: 'eventos_recebidos_no_monitor', consultadoEm: new Date().toISOString(), periodo: { desde: new Date(janela.desde).toISOString(), ate: new Date(janela.ate).toISOString() },
    total: itens.length, mostrando: Math.min(limite, itens.length), pedidos: itens.slice(0, limite).map((i) => projetar(i, mapa, solicitacoes)),
    cobertura: 'Somente pagamentos com autorização recebida e ainda retida no Monitor. Ausência de resultado não comprova ausência de cobrança. Canal e conclusão no PDV podem não estar disponíveis.' };
}
function encontrar(p, transacoes) {
  if (!p.psp && !p.numeroPedido) throw new Error('Informe psp ou numeroPedido.');
  const lista = pagamentos(transacoes).filter(({ base: b }) => (!p.psp || b.pspReference === p.psp) && (!p.numeroPedido || b.merchantReference === p.numeroPedido) && (!p.unidade || b.unidade === p.unidade));
  if (lista.length !== 1) throw new Error(lista.length ? 'Mais de um pagamento corresponde ao pedido. Informe o PSP exato e a unidade.' : 'Pagamento não encontrado no Monitor.');
  return lista[0];
}
async function obter(p, op) {
  const d = dependencias(op);
  if (!d.store.estaCarregado()) throw new Error('Monitor ainda carregando.');
  const mapa = await d.catalogo.mapaDeUnidades();
  const unidade = p.unidade ? resolverUnidade(p.unidade, mapa)[0].codigo : undefined;
  const pedido = encontrar({ ...p, unidade }, d.store.allTransactions());
  return { ...projetar(pedido, mapa, await d.refunds.listAll()), linhaDoTempo: pedido.eventos.map(linha) };
}
module.exports = { buscar, obter, encontrar, pagamentos, projetar, estadoPagamento, normalizar, resolverUnidade, periodo, statusEvento, sucesso, mascarar, ESTORNOS, STATUS, CANAIS };

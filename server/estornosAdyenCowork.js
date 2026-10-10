// Checkout API, separada das credenciais de disputas. Nenhuma escrita pode
// partir do modelo: preparar -> tarefa/push -> assinatura Master -> executar.
const crypto = require('crypto');
const monitor = require('./pedidosMonitor');
const { createCache } = require('./liveCache');
const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
function configuracao(conta, env = process.env) {
  let contas;
  try { contas = JSON.parse(env.ADYEN_CHECKOUT_CONTAS || '{}'); } catch { throw new Error('ADYEN_CHECKOUT_CONTAS inválido.'); }
  const c = contas[conta];
  if (!c || !/^ADYEN_CHECKOUT_API_KEY(?:_\d+)?$/.test(c.keyEnv || '') || !env[c.keyEnv]) throw new Error('Checkout não habilitado para esta conta. Configure ADYEN_CHECKOUT_CONTAS e sua chave específica no servidor.');
  const base = String(c.baseUrl || '').replace(/\/$/, '');
  // Não aceitar URL do chamador, redirects, credenciais na URL ou host arbitrário.
  if (!/^https:\/\/(?:checkout-test\.adyen\.com|[a-z0-9-]+-checkout-live\.adyenpayments\.com\/checkout)\/v72$/.test(base)) throw new Error('URL Checkout inválida; use endpoint oficial Adyen v72.');
  if (c.onlineExclusivo !== true) throw new Error('Confirme no servidor que a conta atende exclusivamente pagamentos online.');
  return { base, chave: env[c.keyEnv], reversaoHabilitada: c.reversaoHabilitada === true };
}
function criarServico({ db, store, refunds, suporteChat, env = process.env, fetchImpl = (url, op) => globalThis.fetch(url, op) }) {
  const registros = db.collection('coworkEstornosAdyen');
  // Só para projeção de consultas. Reservas/decisões financeiras usam leitura
  // direta + create atômico, nunca este cache.
  const cache = createCache(async () => (await registros.get()).docs.map((d) => d.data()), 5 * 60 * 1000);
  const referencia = (b) => registros.doc(hash(`${b.merchantAccountCode}\0${b.pspReference}`));
  async function chatDoProtocolo(protocolo) {
    if (!/^\d+$/.test(String(protocolo)) || Number(protocolo) < 1) throw new Error('protocoloChat deve ser o número do protocolo de suporte.');
    const chat = (await suporteChat.listAll()).find((c) => Number(c.numeroTicket) === Number(protocolo));
    if (!chat) throw new Error('Protocolo de origem não encontrado.');
    return chat;
  }
  async function plano(p) {
    if (!store.estaCarregado()) throw new Error('Monitor ainda carregando.');
    const pedido = monitor.encontrar({ psp: p.psp }, store.allTransactions()), b = pedido.base;
    if (!/^[a-zA-Z0-9]{8,80}$/.test(b.pspReference) || !b.merchantAccountCode) throw new Error('Pagamento sem PSP/conta Adyen verificáveis.');
    const cfg = configuracao(b.merchantAccountCode, env);
    if (!monitor.sucesso(b) || b.moeda !== 'BRL' || (b.canal && b.canal !== 'ONLINE')) throw new Error('Somente pagamento online aprovado em BRL pode ser tratado por esta ferramenta.');
    const centavos = Math.round(Number(b.valor) * 100);
    if (!Number.isSafeInteger(centavos) || centavos <= 0) throw new Error('Valor original inválido.');
    const valor = p.valor == null ? b.valor : p.valor;
    if (typeof valor !== 'number' || !Number.isFinite(valor) || valor <= 0 || Math.abs(valor * 100 - Math.round(valor * 100)) > 0.000001 || valor > b.valor) throw new Error('Valor inválido: use reais, no máximo duas casas decimais, sem exceder a venda.');
    if (pedido.eventos.some((t) => monitor.ESTORNOS.has(t.eventCode) || /CHARGEBACK|CAPTURE_FAILED|EXPIRE/.test(t.eventCode))) throw new Error('Já há estorno/cancelamento, disputa ou falha neste pagamento. Confira o histórico antes de qualquer nova ação financeira.');
    const capturas = pedido.eventos.filter((t) => t.eventCode === 'CAPTURE' && monitor.sucesso(t));
    const operacao = Math.round(valor * 100) === centavos ? 'reversals' : 'refunds';
    if (operacao === 'reversals' && (!cfg.reversaoHabilitada || capturas.length > 1)) throw new Error('Reversão total exige habilitação explícita de conta sem split/múltiplas capturas.');
    if (operacao === 'refunds' && (capturas.length !== 1 || Math.round(capturas[0].valor * 100) < Math.round(valor * 100))) throw new Error('Estorno parcial exige uma captura confirmada suficiente no Monitor.');
    const chat = await chatDoProtocolo(p.protocoloChat);
    const motivo = String(p.motivo || '').trim();
    if (motivo.length < 5 || motivo.length > 600) throw new Error('Descreva o motivo em 5 a 600 caracteres.');
    const anteriores = (await refunds.listAll()).filter((r) => r.unidade === b.unidade && [b.pspReference, b.merchantReference].filter(Boolean).includes(r.pedidoId));
    for (const item of anteriores) {
      const r = await refunds.getOne(item.id); // Não decidir dinheiro com cache antigo.
      if (r && (r.status === 'APROVADO' || ['EM_ANDAMENTO', 'FINALIZADO'].includes(r.execucaoStatus))) throw new Error('Existe execução interna de estorno. Reconcilie-a antes de enviar dinheiro pela Adyen.');
    }
    return { psp: b.pspReference, conta: b.merchantAccountCode, unidade: b.unidade, valor, valorOriginal: b.valor,
      moeda: 'BRL', operacao, baseUrl: cfg.base, motivo, protocoloChat: Number(chat.numeroTicket), chatId: chat.id };
  }
  async function preparar(p) {
    const v = await plano(p);
    const anterior = await referencia({ merchantAccountCode: v.conta, pspReference: v.psp }).get();
    if (anterior.exists) throw new Error('Já existe um envio financeiro para este PSP. Use consultar_estorno_adyen; não tente outra chave.');
    return { entrada: { ...v, intencaoId: crypto.randomUUID() }, resumo: `Adyen: ${v.operacao === 'refunds' ? 'estornar parcialmente' : 'cancelar/estornar'} R$ ${v.valor.toFixed(2)} · ${v.unidade} · #${v.protocoloChat}`,
      detalhes: [{ rotulo: 'Unidade', valor: v.unidade }, { rotulo: 'Conta Adyen', valor: v.conta }, { rotulo: 'PSP original', valor: v.psp },
        { rotulo: 'Valor autorizado', valor: `BRL ${v.valor.toFixed(2)}` }, { rotulo: 'Protocolo de origem', valor: String(v.protocoloChat) },
        { rotulo: 'Motivo', valor: monitor.mascarar(v.motivo) }, { rotulo: 'Aviso', valor: 'Recebimento pela API não comprova crédito ao cliente. Acompanhar webhook; não reenviar em caso de timeout.' }] };
  }
  function compacto(r, eventos = []) {
    const relacionados = [...(r?.eventosAdyen || []), ...eventos].filter((t) => monitor.ESTORNOS.has(t.eventCode)
      && (r?.intencaoId ? !!r.referenciaAdyen && t.pspReference === r.referenciaAdyen : true))
      .sort((a, b) => String(a.eventDate || a.dataHora).localeCompare(String(b.eventDate || b.dataHora)));
    const ultimo = relacionados.at(-1), status = ultimo && monitor.statusEvento(ultimo);
    return { psp: r?.psp || null, status: status === 'FALHA_ESTORNO' ? 'RECUSADO' : status === 'ESTORNO_REVERTIDO' ? 'REVERTIDO'
      : ['ESTORNADO', 'CANCELADO'].includes(status) ? 'CONFIRMADO_PELA_ADYEN' : r?.status || 'SEM_SOLICITACAO_CONHECIDA',
      referencia: r?.referenciaAdyen || ultimo?.pspReference || null, data: ultimo?.eventDate || ultimo?.dataHora || r?.atualizadoEm || null,
      valor: r?.valor ?? ultimo?.valor ?? null, protocoloChat: r?.protocoloChat || null, aprovadoPor: monitor.mascarar(r?.aprovadoPor) || null,
      previsaoCredito: null, creditoConfirmadoAoCliente: false, cartaCancelamento: null,
      aviso: 'Não há prazo de crédito confirmado nesta fonte. Recebimento não é confirmação; mesmo confirmação do processamento Adyen pode ter falha/reversão posterior.',
      ...(r?.httpStatus ? { httpStatus: r.httpStatus } : {}), ...(r?.auditoriaPendente ? { auditoriaPendente: true } : {}) };
  }
  async function anotar(r) {
    const estado = compacto(r);
    await suporteChat.registrarEventoFinanceiro(r.chatId, { eventoId: hash(`${r.intencaoId}:${estado.status}`),
      resumo: `Estorno Adyen do protocolo #${r.protocoloChat}: ${estado.status}. Valor BRL ${r.valor.toFixed(2)}. Referência ${r.referenciaAdyen || r.psp}. Não há prazo de crédito confirmado.`,
      textoPublico: estado.status === 'CONFIRMADO_PELA_ADYEN'
        ? 'A Adyen confirmou o processamento do cancelamento/estorno. Isso ainda não confirma o crédito na sua conta; não recebemos um prazo bancário específico.'
        : estado.status === 'RECEBIDO' ? 'A Adyen recebeu a solicitação de cancelamento/estorno. Ainda aguardamos a confirmação do processamento; o crédito na sua conta não está confirmado.'
          : 'A solicitação de estorno precisa de conferência pela equipe. Ainda não podemos confirmar a devolução.' });
  }
  async function executar(p) {
    const a = p._aprovacao;
    if (!a?.autorizacaoId || !a.usuarioId || !['senha', 'digital'].includes(a.metodo) || !p.intencaoId) throw new Error('Estorno exige autorização autenticada do Master.');
    const v = await plano(p);
    for (const k of Object.keys(v)) if (v[k] !== p[k]) throw new Error('Dados do pagamento mudaram desde a autorização. Revise o pagamento.');
    const ref = referencia({ merchantAccountCode: v.conta, pspReference: v.psp });
    let registro = { ...v, intencaoId: p.intencaoId, autorizacaoId: a.autorizacaoId, aprovadoPor: a.email || a.usuarioId,
      status: 'ENVIANDO', atualizadoEm: new Date().toISOString() };
    // Reserva persistente POR PAGAMENTO, inclusive contra chaves diferentes e
    // duas aprovações simultâneas. Nunca liberada por timeout/falha local.
    await ref.create(registro).catch(() => { throw new Error('Envio já reservado para este pagamento; consulte o resultado, não reenvie.'); });
    cache.invalidar();
    const cfg = configuracao(v.conta, env);
    const corpo = { merchantAccount: v.conta, reference: `NoPulso-${v.protocoloChat}-${p.intencaoId}` };
    if (v.operacao === 'refunds') corpo.amount = { currency: v.moeda, value: Math.round(v.valor * 100) };
    try {
      const resposta = await fetchImpl(`${cfg.base}/payments/${encodeURIComponent(v.psp)}/${v.operacao}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/json', 'X-API-Key': cfg.chave, 'Idempotency-Key': p.intencaoId }, body: JSON.stringify(corpo) });
      const dados = await resposta.json().catch(() => ({}));
      const valido = resposta.ok && dados.status === 'received' && typeof dados.pspReference === 'string'
        && dados.paymentPspReference === v.psp && dados.merchantAccount === v.conta;
      registro.status = valido ? 'RECEBIDO' : resposta.status >= 400 && resposta.status < 500 && resposta.status !== 408 && resposta.status !== 409 ? 'RECUSADO' : 'RESULTADO_INCERTO';
      registro.httpStatus = resposta.status;
      registro.referenciaAdyen = valido ? dados.pspReference : null;
    } catch {
      registro.status = 'RESULTADO_INCERTO';
    }
    registro.atualizadoEm = new Date().toISOString();
    // Não sobrescrever webhooks que podem chegar durante a chamada HTTP.
    await ref.update({ status: registro.status, atualizadoEm: registro.atualizadoEm,
      referenciaAdyen: registro.referenciaAdyen || null, ...(registro.httpStatus ? { httpStatus: registro.httpStatus } : {}) });
    registro = (await ref.get()).data();
    cache.invalidar();
    // Webhook pode chegar antes da resposta HTTP. Só associar ao nosso envio
    // depois de conhecer a referência da modificação; nunca pelo valor/nome.
    if (registro.referenciaAdyen) {
      for (const t of store.allTransactions().filter((t) => t.pspReference === registro.referenciaAdyen && t.originalReference === registro.psp)) await registrarWebhook(t);
      registro = (await ref.get()).data();
    }
    try { await anotar(registro); } catch {
      registro.auditoriaPendente = true;
      await ref.update({ auditoriaPendente: true });
      cache.invalidar();
    }
    return compacto(registro);
  }
  async function consultar(p) {
    if (!p.psp) throw new Error('Informe o PSP do pagamento.');
    let pedido, falha;
    try {
      if (!store.estaCarregado()) throw new Error('Monitor ainda carregando.');
      pedido = monitor.encontrar(p, store.allTransactions());
    } catch (e) { falha = e; }
    let ref;
    if (pedido) ref = referencia(pedido.base);
    else {
      // A limpeza do Monitor não apaga a trilha financeira persistente.
      const encontrados = (await cache.cached()).filter((r) => r.psp === p.psp && (!p.unidade || r.unidade === p.unidade));
      if (encontrados.length !== 1) throw falha || new Error('Envio não encontrado ou ambíguo.');
      ref = referencia({ merchantAccountCode: encontrados[0].conta, pspReference: p.psp });
    }
    const snap = await ref.get(), r = snap.exists ? snap.data() : { psp: p.psp };
    const eventos = pedido?.eventos || r.eventosAdyen || [];
    return { ...compacto(r, eventos), eventos: eventos.filter((t) => monitor.ESTORNOS.has(t.eventCode)).map((t) => ({ referencia: t.pspReference, evento: t.eventCode, status: monitor.statusEvento(t), data: t.eventDate || t.dataHora, valor: t.valor })) };
  }
  async function registrarWebhook(t) {
    if (!monitor.ESTORNOS.has(t.eventCode) || !t.originalReference || !t.merchantAccountCode) return null;
    const ref = referencia({ merchantAccountCode: t.merchantAccountCode, pspReference: t.originalReference });
    const inicial = await ref.get();
    if (!inicial.exists || !inicial.data().referenciaAdyen) return null;
    await db.runTransaction(async (tr) => {
      const snap = await tr.get(ref), r = snap.data();
      if (!r || (r.referenciaAdyen && r.referenciaAdyen !== t.pspReference)) return;
      const eventos = (r.eventosAdyen || []).filter((x) => !(x.pspReference === t.pspReference && x.eventCode === t.eventCode));
      eventos.push({ pspReference: t.pspReference, eventCode: t.eventCode, success: t.success ?? null, status: t.status || null,
        eventDate: t.eventDate || null, dataHora: t.dataHora, valor: t.valor });
      tr.update(ref, { eventosAdyen: eventos.slice(-20) });
    });
    cache.invalidar();
    const r = (await ref.get()).data();
    if (r.referenciaAdyen && r.referenciaAdyen !== t.pspReference) return null;
    try { await anotar(r); } catch { await ref.update({ auditoriaPendente: true }); cache.invalidar(); }
    return compacto(r);
  }
  async function listar() { return (await cache.cached()).map((r) => ({ unidade: r.unidade, ...compacto(r) })); }
  return { preparar, executar, consultar, listar, registrarWebhook };
}
let padrao;
function servico() {
  if (!padrao) padrao = criarServico({ db: require('./firestore'), store: require('./store'), refunds: require('./refunds'), suporteChat: require('./suporteChat') });
  return padrao;
}
module.exports = { configuracao, criarServico, preparar: (p) => servico().preparar(p), executar: (p) => servico().executar(p), consultar: (p) => servico().consultar(p), listar: () => servico().listar(), registrarWebhook: (t) => servico().registrarWebhook(t) };

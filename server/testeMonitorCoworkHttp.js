const assert = require('node:assert/strict');
async function testar({ DOCS, pedir, postarJson, token }) {
  const store = require('./store'), suporte = require('./suporteChat'), qa = require('./qaAprovacoes');
  const envs = ['NOPULSO_AGENT_API_TOKEN', 'NOPULSO_AGENT_MASTER', 'ADYEN_CHECKOUT_CONTAS', 'ADYEN_CHECKOUT_API_KEY'];
  const antes = Object.fromEntries(envs.map((k) => [k, process.env[k]])), fetchAntes = globalThis.fetch;
  let envios = 0;
  process.env.NOPULSO_AGENT_API_TOKEN = 'conector-somente-do-teste-local';
  process.env.NOPULSO_AGENT_MASTER = process.env.MASTER_EMAIL;
  process.env.ADYEN_CHECKOUT_API_KEY = 'checkout-falso-sem-valor';
  process.env.ADYEN_CHECKOUT_CONTAS = JSON.stringify({ TESTE_MONITOR: { keyEnv: 'ADYEN_CHECKOUT_API_KEY', baseUrl: 'https://checkout-test.adyen.com/v72', onlineExclusivo: true, reversaoHabilitada: true } });
  globalThis.fetch = async (url, op) => {
    if (String(url).startsWith('https://checkout-test.adyen.com/v72/')) {
      envios++; assert.equal(op.method, 'POST'); assert(op.headers['Idempotency-Key']);
      return { ok: true, status: 200, json: async () => ({ status: 'received', merchantAccount: 'TESTE_MONITOR', paymentPspReference: 'HTTPPSP000001', pspReference: 'HTTPMOD000001' }) };
    }
    return fetchAntes(url, op);
  };
  const cab = { 'x-agent-token': process.env.NOPULSO_AGENT_API_TOKEN };
  const executar = (action, input, chave) => postarJson('/api/agent/execute', { action, input }, { ...cab, ...(chave ? { 'Idempotency-Key': chave } : {}) });
  try {
    const chat = await suporte.criar({ nome: 'Cliente teste', contato: 'teste@example.com', assunto: 'Financeiro', texto: 'Gostaria de conferir meu pagamento.' });
    store.addOrUpdate({ pspReference: 'HTTPPSP000001', merchantReference: 'HTTP-PEDIDO-01', merchantAccountCode: 'TESTE_MONITOR', unidade: 'Dominos Garanhuns',
      eventCode: 'AUTHORISATION', success: true, status: 'APROVADO', nomeCliente: 'José Geová', valor: 89.8, moeda: 'BRL', canal: 'ONLINE', last4: '1234', dataHora: new Date().toISOString() });
    assert.equal((await pedir('/api/agent/tools')).status, 401);
    const lista = await pedir('/api/agent/tools', cab); assert.equal(lista.status, 200, lista.corpo);
    assert(lista.corpo.includes('buscar_pedidos_monitor'));
    const busca = await executar('buscar_pedidos_monitor', { psp: 'HTTPPSP000001', nomeCliente: 'jose geova' });
    assert.equal(busca.status, 200, busca.corpo); assert.equal(JSON.parse(busca.corpo).resultado.total, 1);
    const detalhe = await executar('obter_pedido_monitor', { psp: 'HTTPPSP000001' });
    assert.equal(detalhe.status, 200, detalhe.corpo); assert.equal(JSON.parse(detalhe.corpo).resultado.statusPedido, 'NAO_INFORMADO');
    const input = { psp: 'HTTPPSP000001', protocoloChat: chat.numeroTicket, motivo: 'Teste de estorno sem operação real.' };
    const pendente = await executar('solicitar_estorno_adyen', input, 'http-monitor-1');
    assert.equal(pendente.status, 200, pendente.corpo); const pedido = JSON.parse(pendente.corpo);
    assert(pedido.pendente); assert.equal(envios, 0);
    const registro = DOCS.get('qaAprovacoes/' + pedido.autorizacaoId);
    assert(registro.tarefaId, 'Autorização precisa da tarefa persistente do Master');
    assert.equal(DOCS.get('tarefas/' + registro.tarefaId).origem, 'autorizacao-master');
    const headers = { Authorization: 'Bearer ' + token };
    const autorizar = (password) => postarJson(`/api/qa-aprovacoes/${pedido.autorizacaoId}/aprovar`, { password, revisao: qa.revisao(registro) }, headers);
    assert.equal((await autorizar('errada')).status, 400); assert.equal(envios, 0);
    const confirmado = await autorizar(process.env.MASTER_PASSWORD);
    assert.equal(confirmado.status, 200, confirmado.corpo); assert.equal(envios, 1);
    const repetido = await executar('solicitar_estorno_adyen', input, 'http-monitor-1');
    assert.equal(JSON.parse(repetido.corpo).repetida, true); assert.equal(envios, 1);
    assert.equal((await executar('solicitar_estorno_adyen', { ...input, valor: 1 }, 'http-monitor-1')).status, 400);
    const recebido = await executar('consultar_estorno_adyen', { psp: 'HTTPPSP000001' });
    assert.equal(JSON.parse(recebido.corpo).resultado.status, 'RECEBIDO');
    const evento = { pspReference: 'HTTPMOD000001', originalReference: 'HTTPPSP000001', merchantAccountCode: 'TESTE_MONITOR', unidade: 'Dominos Garanhuns',
      eventCode: 'CANCEL_OR_REFUND', success: true, valor: 89.8, dataHora: new Date().toISOString() };
    store.addOrUpdate(evento);
    const estornos = require('./estornosAdyenCowork');
    await estornos.registrarWebhook(evento); await estornos.registrarWebhook(evento);
    const atualizado = await suporte.getOne(chat.id);
    assert.equal(atualizado.notasInternas.length, 2, 'Recebido e confirmação, sem duplicar webhook');
    assert.equal(atualizado.mensagens.length, 3);
    const publico = await suporte.getPublico(chat.id, chat.token);
    assert(!JSON.stringify(publico).includes('eventosFinanceiros')); assert(!JSON.stringify(publico).includes('notasInternas'));
    for (let i = 0; i < 8; i++) await suporte.consumirConsultaPedidoPublico(chat.id);
    await assert.rejects(suporte.consumirConsultaPedidoPublico(chat.id), /Limite/);
    await suporte.finalizar(chat.id, { autorEmail: 'teste' });
    const reaberto = await executar('reabrir_chat_suporte', { protocolo: String(chat.numeroTicket), motivo: 'Retomar conferência do cliente' }, 'http-reabre-1');
    assert.equal(reaberto.status, 200, reaberto.corpo); assert.equal((await suporte.getOne(chat.id)).status, 'ABERTO');
    await suporte.restringirAposConclusao(chat.id); await suporte.finalizar(chat.id, { autorEmail: 'teste' });
    assert.equal((await executar('reabrir_chat_suporte', { protocolo: String(chat.numeroTicket), motivo: 'Não deve liberar histórico' }, 'http-reabre-protegido')).status, 400);
    console.log('✓ Monitor/Cowork HTTP: busca, detalhe, tarefa de Hoje, aprovação real, idempotência, estorno simulado, webhook, privacidade, limite público e reabertura protegida.');
  } finally {
    globalThis.fetch = fetchAntes;
    for (const [k, v] of Object.entries(antes)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}
module.exports = { testar };

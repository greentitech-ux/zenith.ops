// Sem rede, credenciais ou operações reais. Executa regras e gateway reais
// contra persistência/API falsas; --sabotar deve terminar com falha.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const monitor = require('./pedidosMonitor');
const publico = require('./consultaPedidoPublico');
const { criarServico, configuracao } = require('./estornosAdyenCowork');
const agregador = require('./pedidosAgregadorCowork');
if (process.argv.includes('--sabotar')) monitor.sucesso = () => true;
let passou = 0;
async function teste(nome, fn) { await fn(); passou++; console.log(`✓ ${nome}`); }
function banco() {
  const docs = new Map();
  const snap = (k) => ({ exists: docs.has(k), data: () => structuredClone(docs.get(k)) });
  let seq = 0;
  return { docs, runTransaction: async (fn) => fn({ get: (ref) => ref.get(), update: (ref, v) => ref.update(v) }), collection: (col) => ({
    get: async () => ({ docs: [...docs.keys()].filter((k) => k.startsWith(`${col}/`)).map(snap) }),
    doc(id = `novo-${++seq}`) {
      const k = `${col}/${id}`;
      return { id, get: async () => snap(k), create: async (v) => { if (docs.has(k)) throw new Error('ALREADY_EXISTS'); docs.set(k, structuredClone(v)); },
        set: async (v) => { docs.set(k, structuredClone(v)); }, update: async (v) => { if (!docs.has(k)) throw new Error('NOT_FOUND'); docs.set(k, { ...docs.get(k), ...structuredClone(v) }); } };
    },
  }) };
}
const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const mapa = { GAR: { codigo: 'GAR', nome: 'Dominos Garanhuns', apelidos: ['Dom Garanhuns'] }, TIR: { codigo: 'TIR', nome: 'Dominos Tirol', apelidos: [] }, MIL: { codigo: 'MIL', nome: 'MilkyMoo Tirol', apelidos: [] } };
const tx = (extra = {}) => ({ pspReference: 'PSP00000001', merchantReference: '250', merchantAccountCode: 'DOM19911', unidade: 'GAR',
  eventCode: 'AUTHORISATION', success: true, status: 'APROVADO', nomeCliente: 'José Geová', valor: 89.80, moeda: 'BRL', canal: 'ONLINE',
  last4: '1234', metodo: 'visa', emailCliente: 'jose@exemplo.com', telefoneCliente: '11999998888', dataHora: `${hoje}T12:00:00-03:00`, ...extra });
const deps = (lista, outros = {}) => ({ store: { allTransactions: () => lista, estaCarregado: () => true }, catalogo: { mapaDeUnidades: async () => mapa }, refunds: { listAll: async () => [] }, ...outros });
function fixture({ eventos = [tx()], fetchImpl, chats, envExtra = {} } = {}) {
  const db = banco(), notas = [], mensagens = [];
  const chat = { id: 'chat-1', numeroTicket: 12453, status: 'ABERTO' };
  const env = { ADYEN_CHECKOUT_API_KEY: 'segredo-falso-nao-real', ADYEN_CHECKOUT_CONTAS: JSON.stringify({ DOM19911: { keyEnv: 'ADYEN_CHECKOUT_API_KEY', baseUrl: 'https://checkout-test.adyen.com/v72', onlineExclusivo: true, reversaoHabilitada: true } }), ...envExtra };
  let chamadas = 0, request;
  const entregas = new Set();
  const suporteChat = chats || { listAll: async () => [chat], getOne: async () => chat,
    registrarEventoFinanceiro: async (id, p) => { if (entregas.has(p.eventoId)) return; entregas.add(p.eventoId); notas.push({ resumo: p.resumo }); mensagens.push({ texto: p.textoPublico }); },
    registrarNotaInterna: async (id, p) => notas.push(p), adicionarMensagem: async (id, p) => mensagens.push(p) };
  const servico = criarServico({ db, store: deps(eventos).store, refunds: { listAll: async () => [], getOne: async () => null }, suporteChat, env,
    fetchImpl: async (url, opt) => { chamadas++; request = { url, opt }; return fetchImpl ? fetchImpl(url, opt) : { ok: true, status: 200,
      json: async () => ({ merchantAccount: 'DOM19911', paymentPspReference: 'PSP00000001', pspReference: 'MOD00000001', status: 'received' }) }; } });
  return { db, servico, env, notas, mensagens, chamadas: () => chamadas, request: () => request };
}
const pedido = { psp: 'PSP00000001', protocoloChat: 12453, motivo: 'Cliente solicitou cancelamento do pedido.' };
const assinatura = { autorizacaoId: 'qa-1', usuarioId: 'master-1', email: 'master@exemplo.com', metodo: 'digital' };
async function main() {
  await teste('nome sem acento + apelido + tolerância em centavos, retorno protegido', async () => {
    const r = await monitor.buscar({ unidade: 'GARANHUNS', nomeCliente: 'jose geo', valor: 89.90, finalCartao: '1234' }, deps([tx()]));
    assert.equal(r.total, 1); assert.equal(r.pedidos[0].statusPedido, 'NAO_INFORMADO');
    assert.equal(r.pedidos[0].statusPagamento, 'AUTORIZADO'); assert.equal(r.pedidos[0].finalCartao, '**** 1234');
    assert(!JSON.stringify(r).includes('jose@exemplo.com')); assert(!JSON.stringify(r).includes('11999998888'));
    assert.equal((await monitor.buscar({ valor: 89.91 }, deps([tx()]))).total, 0);
  });
  await teste('datas inclusivas em São Paulo e datas inválidas rejeitadas', async () => {
    const r = monitor.periodo({}, new Date('2026-10-10T01:00:00Z'));
    assert.equal(new Date(r.desde).toISOString(), '2026-10-09T03:00:00.000Z');
    assert.equal(new Date(r.ate).toISOString(), '2026-10-10T02:59:59.999Z');
    assert.throws(() => monitor.periodo({ desde: '2026-02-30' }));
    assert.throws(() => monitor.periodo({ desde: 'ontem' }));
    assert.throws(() => monitor.periodo({ desde: '2026-10-10', ate: '2026-10-09' }));
  });
  await teste('unidade ambígua nunca vira busca global, filtros inválidos falham', async () => {
    await assert.rejects(monitor.buscar({ unidade: 'Tirol' }, deps([tx()])), /ambígua/);
    await assert.rejects(monitor.buscar({ unidade: 'inexistente' }, deps([tx()])), /não encontrada/);
    for (const p of [{ finalCartao: '12' }, { limite: 0 }, { valor: '89.8' }, { emailOuTelefone: '123' }, { status: 'PEDIDO_NAO_FINALIZADO' }]) await assert.rejects(monitor.buscar(p, deps([tx()])));
    assert.equal((await monitor.buscar({ emailOuTelefone: '11999998888' }, deps([tx()]))).total, 1);
    await assert.rejects(monitor.buscar({}, deps([], { store: { estaCarregado: () => false } })), /carregando/);
  });
  await teste('PSPs distintos e contas distintas não se misturam pelo número do pedido', async () => {
    const eventos = [tx(), tx({ pspReference: 'PSP00000002', valor: 50 }), tx({ pspReference: 'MOD00000001', originalReference: 'PSP00000001', eventCode: 'REFUND', status: 'ESTORNADO' })];
    const r = await monitor.obter({ psp: 'PSP00000001' }, deps(eventos));
    assert.equal(r.linhaDoTempo.length, 2); assert.equal(r.statusPagamento, 'ESTORNADO');
    assert.equal((await monitor.obter({ psp: 'PSP00000002' }, deps(eventos))).statusPagamento, 'AUTORIZADO');
    await assert.rejects(monitor.obter({ numeroPedido: '250' }, deps(eventos)), /Mais de um/);
    const outraConta = tx({ merchantAccountCode: 'OUTRA', eventCode: 'REFUND', originalReference: 'PSP00000001', status: 'ESTORNADO' });
    assert.equal((await monitor.obter({ psp: 'PSP00000001' }, deps([tx(), outraConta]))).linhaDoTempo.length, 1);
  });
  await teste('captura/cancelamento legado sem sucesso explícito não vira confirmação', async () => {
    assert.equal(monitor.statusEvento(tx({ eventCode: 'CAPTURE', success: undefined, status: 'CAPTURE' })), 'DESCONHECIDO');
    assert.equal(monitor.statusEvento(tx({ eventCode: 'CANCEL_OR_REFUND', success: false })), 'FALHA_ESTORNO');
    assert.equal(monitor.statusEvento(tx({ eventCode: 'REFUND', success: undefined, status: 'ESTORNADO' })), 'ESTORNADO');
  });
  await teste('estorno parcial não aparece como devolução total e falha de captura prevalece', async () => {
    const parcial = tx({ eventCode: 'REFUND', originalReference: 'PSP00000001', pspReference: 'REFPARCIAL', valor: 20, status: 'ESTORNADO' });
    const r = await monitor.obter({ psp: 'PSP00000001' }, deps([tx(), parcial]));
    assert.equal(r.statusPagamento, 'ESTORNADO_PARCIAL'); assert.equal(r.valorEstornoProcessado, 20);
    assert.equal((await monitor.buscar({ status: 'ESTORNADO_PARCIAL' }, deps([tx(), parcial]))).total, 1);
    assert.equal(monitor.statusEvento(tx({ eventCode: 'CAPTURE_FAILED' })), 'FALHA_CAPTURA');
  });
  await teste('pedido da loja não é confirmação de dinheiro devolvido', async () => {
    const r = await monitor.obter({ psp: 'PSP00000001' }, deps([tx()], { refunds: { listAll: async () => [{ id: 'r1', pedidoId: '250', unidade: 'GAR', status: 'APROVADO', requestedByEmail: 'loja@exemplo.com' }] } }));
    assert.equal(r.solicitacoesLoja[0].confirmacaoAdyen, false); assert.equal(r.previsaoCredito, null);
    assert(!JSON.stringify(r).includes('loja@exemplo.com'));
  });
  await teste('restrição autenticada de loja aplicada antes do limite', async () => {
    const r = await monitor.buscar({ limite: 1 }, deps([tx(), tx({ pspReference: 'PSP00000002', unidade: 'TIR' })], { unidadesPermitidas: new Set(['TIR']) }));
    assert.equal(r.total, 1); assert.equal(r.pedidos[0].unidade, 'TIR');
  });
  await teste('visitante pode consultar sem login, mas não listar candidatos ou dados sensíveis', async () => {
    let tentativas = 0;
    const op = { consumirTentativa: async () => { tentativas++; }, buscar: (p) => monitor.buscar(p, deps([tx()])) };
    assert((await publico.consultar({ unidade: 'Garanhuns', nomeCliente: 'José', valor: '89,80' }, op)).aviso);
    assert.equal(tentativas, 0);
    const input = { unidade: 'Garanhuns', nomeCliente: 'jose geova', valor: '89,80', finalCartao: '1234' };
    const r = await publico.consultar(input, op);
    assert.equal(r.publico.statusPagamento, 'AUTORIZADO'); assert.equal(tentativas, 1);
    assert(!JSON.stringify(r.publico).includes('PSP00000001')); assert(!JSON.stringify(r.publico).includes('1234'));
    assert((await publico.consultar({ ...input, finalCartao: '9999' }, op)).aviso);
    assert((await publico.consultar(input, { ...op, unidadeFixa: new Set(['TIR']) })).aviso);
    await assert.rejects(publico.consultar(input, { ...op, consumirTentativa: async () => { throw new Error('limite'); } }), /limite/);
  });
  await teste('Checkout exige configuração própria e recusa destinos não oficiais', async () => {
    assert.throws(() => configuracao('DOM19911', { ADYEN_DISPUTES_API_KEY: 'nao-utilizar' }), /Checkout/);
    const f = fixture();
    f.env.ADYEN_CHECKOUT_CONTAS = JSON.stringify({ DOM19911: { keyEnv: 'ADYEN_CHECKOUT_API_KEY', baseUrl: 'https://evil.test/v72', onlineExclusivo: true } });
    assert.throws(() => configuracao('DOM19911', f.env), /URL/);
  });
  await teste('preparo gera prévia fixa; sem assinatura não movimenta dinheiro', async () => {
    const f = fixture(), p = await f.servico.preparar(pedido);
    assert.equal(f.chamadas(), 0); assert(p.detalhes.some((d) => d.rotulo === 'PSP original'));
    await assert.rejects(f.servico.executar(p.entrada), /autorização/);
    assert.equal(f.chamadas(), 0);
  });
  await teste('recebido não vira confirmado; reserva bloqueia duas chaves/aprovações simultâneas', async () => {
    const f = fixture(); const p1 = await f.servico.preparar(pedido), p2 = await f.servico.preparar(pedido);
    const r = await Promise.allSettled([p1, p2].map((p) => f.servico.executar({ ...p.entrada, _aprovacao: assinatura })));
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1); assert.equal(f.chamadas(), 1);
    assert.equal(r.find((x) => x.status === 'fulfilled').value.status, 'RECEBIDO');
    assert.equal(f.request().opt.headers['Idempotency-Key'], p1.entrada.intencaoId);
    assert.equal(f.request().opt.redirect, 'error'); assert(!('amount' in JSON.parse(f.request().opt.body)));
    assert.equal(f.notas.length, 1); assert.equal(f.mensagens.length, 1);
    assert.equal((await f.servico.consultar({ psp: pedido.psp })).creditoConfirmadoAoCliente, false);
    await assert.rejects(f.servico.preparar(pedido), /Já existe/);
  });
  await teste('timeout fica incerto e não permite reenvio nem nova intenção', async () => {
    const f = fixture({ fetchImpl: async () => { throw new Error('timeout'); } });
    const p = await f.servico.preparar(pedido);
    const r = await f.servico.executar({ ...p.entrada, _aprovacao: assinatura });
    assert.equal(r.status, 'RESULTADO_INCERTO');
    await assert.rejects(f.servico.executar({ ...p.entrada, _aprovacao: assinatura }), /reservado/);
    await assert.rejects(f.servico.preparar(pedido), /Já existe/); assert.equal(f.chamadas(), 1);
  });
  await teste('mudança do valor aprovado e pagamento recusado impedem envio', async () => {
    const eventos = [tx()], f = fixture({ eventos }), p = await f.servico.preparar(pedido);
    eventos[0].valor = 100;
    await assert.rejects(f.servico.executar({ ...p.entrada, _aprovacao: assinatura }), /mudaram|captura/);
    const recusado = fixture({ eventos: [tx({ success: false, status: 'RECUSADO' })] });
    await assert.rejects(recusado.servico.preparar(pedido), /aprovado/); assert.equal(recusado.chamadas(), 0);
    assert.equal(f.chamadas(), 0);
  });
  await teste('parcial só com captura confirmada e valor válido em centavos', async () => {
    const f = fixture({ eventos: [tx(), tx({ eventCode: 'CAPTURE', pspReference: 'CAP00000001', originalReference: pedido.psp, status: 'CAPTURE' })] });
    for (const valor of [-1, 0, 0.001, 100, '20']) await assert.rejects(f.servico.preparar({ ...pedido, valor }));
    const p = await f.servico.preparar({ ...pedido, valor: 20.05 });
    await f.servico.executar({ ...p.entrada, _aprovacao: assinatura });
    assert(f.request().url.endsWith('/refunds')); assert.equal(JSON.parse(f.request().opt.body).amount.value, 2005);
    await assert.rejects(fixture().servico.preparar({ ...pedido, valor: 20 }), /captura/);
  });
  await teste('webhook confirma processamento, falha posterior revoga confirmação', async () => {
    const eventos = [tx()], f = fixture({ eventos }), p = await f.servico.preparar(pedido);
    await f.servico.executar({ ...p.entrada, _aprovacao: assinatura });
    eventos.push(tx({ pspReference: 'MOD00000001', originalReference: pedido.psp, eventCode: 'CANCEL_OR_REFUND', dataHora: `${hoje}T13:00:00-03:00` }));
    await f.servico.registrarWebhook(eventos.at(-1)); await f.servico.registrarWebhook(eventos.at(-1));
    assert.equal(f.notas.length, 2); assert.equal(f.mensagens.length, 2);
    assert.equal((await f.servico.consultar({ psp: pedido.psp })).status, 'CONFIRMADO_PELA_ADYEN');
    eventos.push(tx({ pspReference: 'MOD00000001', originalReference: pedido.psp, eventCode: 'REFUND_FAILED', dataHora: `${hoje}T14:00:00-03:00` }));
    await f.servico.registrarWebhook(eventos.at(-1));
    assert.equal(f.notas.length, 3); assert.equal((await f.servico.listar())[0].status, 'RECUSADO');
    assert.equal((await f.servico.consultar({ psp: pedido.psp })).status, 'RECUSADO');
    eventos.length = 0;
    assert.equal((await f.servico.consultar({ psp: pedido.psp })).status, 'RECUSADO', 'Histórico financeiro sobrevive à limpeza do Monitor');
  });
  await teste('HTTP 4xx recusado e resposta inesperada incerta, sem exibir payload bruto', async () => {
    for (const [status, esperado] of [[422, 'RECUSADO'], [200, 'RESULTADO_INCERTO'], [500, 'RESULTADO_INCERTO']]) {
      const f = fixture({ fetchImpl: async () => ({ ok: status === 200, status, json: async () => ({ segredo: 'nao-vazar' }) }) });
      const p = await f.servico.preparar(pedido), r = await f.servico.executar({ ...p.entrada, _aprovacao: assinatura });
      assert.equal(r.status, esperado); assert(!JSON.stringify(r).includes('nao-vazar'));
    }
  });
  await teste('agregadores sem fonte retornam indisponibilidade, não zero pedidos', async () => {
    assert.equal((await agregador.buscar({ canal: '99FOOD', unidade: 'Tirol' }, {})).disponivel, false);
    assert.equal((await agregador.buscar({ canal: 'IFOOD', unidade: 'Tirol' }, { listAllCached: async () => [] })).disponivel, false);
    const r = await agregador.buscar({ canal: 'IFOOD', unidade: 'Garanhuns', numeroPedido: '250' }, { listAllCached: async () => [{ id: 'a', unidade: 'GAR', unidadeNome: 'Dominos Garanhuns', numeroPedido: '250', dataHora: `${hoje}T15:00:00Z`, status: 'CANCELLED', raw: { telefone: 'segredo' } }] });
    assert.equal(r.total, 1); assert.equal(r.pedidos[0].status, 'CANCELLED'); assert(!JSON.stringify(r).includes('segredo'));
  });
  await testarGateway();
  console.log(`${passou} cenários aprovados. Nenhuma chamada externa realizada.`);
}
async function testarGateway() {
  const db = banco(), aprovadas = [], mensagens = [], notas = [];
  const master = { id: 'm1', role: 'master', active: true, email: 'master@local' };
  const chats = [{ id: 'c1', numeroTicket: 12379, status: 'FINALIZADO' }, { id: 'c2', numeroTicket: 12380, status: 'FINALIZADO', restritoAposConclusao: true }];
  let financeiro = 0, pushes = 0;
  const stubs = {
    './firestore': db, './users': { findByIdentifier: async () => master }, './pedidosMonitor': monitor,
    './estornosAdyenCowork': { preparar: async (p) => ({ entrada: p, resumo: 'Prévia de estorno', detalhes: [] }), executar: async () => { financeiro++; } },
    './qaAprovacoes': { criar: async (p) => { aprovadas.push(p); return { id: 'qa-1' }; }, registrarEntregaPush: async () => {} },
    './push': { notifyQaAprovacaoPendente: async () => { pushes++; return {}; } },
    './suporteChat': { listAll: async () => chats, registrarNotaInterna: async (id, p) => notas.push(p),
      atualizarStatusAtendimento: async (id) => { chats.find((c) => c.id === id).status = 'ABERTO'; }, adicionarMensagem: async (id, p) => mensagens.push(p) },
  };
  const arquivo = path.join(__dirname, 'coworkApi.js'), m = new Module(arquivo, module);
  m.filename = arquivo; m.paths = module.paths;
  m.require = (id) => id.startsWith('.') ? (stubs[id] || {}) : require(id);
  m._compile(fs.readFileSync(arquivo, 'utf8'), arquivo);
  const api = m.exports, original = process.env.NOPULSO_AGENT_MASTER;
  process.env.NOPULSO_AGENT_MASTER = 'master@local';
  try {
    await teste('gateway expõe esquemas fechados e aprovação antes de executar dinheiro', async () => {
      const tools = api.ferramentasMcp();
      for (const n of ['buscar_pedidos_monitor', 'obter_pedido_monitor', 'solicitar_estorno_adyen', 'consultar_estorno_adyen', 'reabrir_chat_suporte', 'buscar_pedidos_agregador']) assert(tools.some((t) => t.name === n));
      const escrita = tools.find((t) => t.name === 'solicitar_estorno_adyen');
      assert(escrita.inputSchema.required.includes('idempotencyKey')); assert.equal(escrita.inputSchema.additionalProperties, false);
      await assert.rejects(api.executar({ nome: escrita.name, entrada: pedido }), /idempotencyKey/);
      await assert.rejects(api.executar({ nome: escrita.name, entrada: { ...pedido, _aprovacao: assinatura }, idempotencyKey: 'injecao' }), /não usa: _aprovacao/);
      const r = await api.executar({ nome: escrita.name, entrada: { ...pedido, confirmar: true }, idempotencyKey: 'financeiro-1' });
      assert.equal(r.pendente, true); assert.equal(aprovadas.length, 1); assert.equal(pushes, 1); assert.equal(financeiro, 0);
      assert.equal(aprovadas[0].tipo, 'cowork.executar');
      const repetida = await api.executar({ nome: escrita.name, entrada: pedido, idempotencyKey: 'financeiro-1' });
      assert.equal(repetida.repetida, true); assert.equal(aprovadas.length, 1);
      await assert.rejects(api.executar({ nome: escrita.name, entrada: { ...pedido, valor: 1 }, idempotencyKey: 'financeiro-1' }), /outra intenção/);
    });
    await teste('reabre chat comum uma única vez; chat protegido não é reexposto', async () => {
      const entrada = { protocolo: '12379', motivo: 'Recebemos a resposta do financeiro' };
      const r = await api.executar({ nome: 'reabrir_chat_suporte', entrada, idempotencyKey: 'reabrir-1' });
      assert(r.ok); assert.equal(chats[0].status, 'ABERTO'); assert.equal(notas.length, 1);
      await api.executar({ nome: 'reabrir_chat_suporte', entrada, idempotencyKey: 'reabrir-1' }); assert.equal(notas.length, 1);
      await assert.rejects(api.executar({ nome: 'reabrir_chat_suporte', entrada: { ...entrada, protocolo: '12380' }, idempotencyKey: 'protegido-1' }), /protegida/);
      assert.equal(chats[1].status, 'FINALIZADO');
      await api.executar({ nome: 'responder_chat_suporte', entrada: { protocolo: '12379', texto: 'Estamos conferindo o pedido.' }, idempotencyKey: 'resposta-1' });
      assert.equal(mensagens.length, 1);
    });
  } finally { if (original === undefined) delete process.env.NOPULSO_AGENT_MASTER; else process.env.NOPULSO_AGENT_MASTER = original; }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });

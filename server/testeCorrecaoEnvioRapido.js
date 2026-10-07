const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
async function testar(fonte = fs.readFileSync(__dirname + '/abastecimentoCarrinho.js', 'utf8')) {
  const dados = new Map(); let seq = 0, falhar = false;
  const copiar = v => v == null ? v : JSON.parse(JSON.stringify(v));
  const ref = path => ({ id: path.split('/').pop(), path,
    get: async () => ({ exists: dados.has(path), data: () => copiar(dados.get(path)) }),
    set: async v => dados.set(path, copiar(v)), update: async v => dados.set(path, { ...dados.get(path), ...copiar(v) }), delete: async () => dados.delete(path) });
  const db = { collection: nome => ({ doc: id => ref(nome + '/' + (id || 'n' + ++seq)), get: async () => ({ docs: [] }), orderBy() { return this; } }),
    runTransaction: async fn => {
      const ops = [];
      const resultado = await fn({ get: r => r.get(), update: (r, v) => ops.push(() => r.update(v)), set: (r, v) => ops.push(() => r.set(v)) });
      if (falhar) throw new Error('Falha simulada no commit');
      for (const op of ops) await op();
      return resultado;
    } };
  const ctx = { module: { exports: {} }, require: n => n === './firestore' ? db : n === './liveCache' ? require('./liveCache') : {}, console, Date, setTimeout, clearTimeout };
  vm.runInNewContext(fonte, ctx);
  const ab = ctx.module.exports, key = id => 'abastecimentoCarrinho/' + id;
  const pizzas = n => ({ calabresa: n, pepperoni: 5, mussarela: 5 });
  const seed = (envio = {}) => {
    dados.clear();
    dados.set(key('p'), { id: 'p', tipo: 'PEDIDO', pizzas: pizzas(55), insumos: [], atendidoPorEnvioId: 'e' });
    dados.set(key('e'), { id: 'e', tipo: 'ENVIO', pizzas: pizzas(55), insumos: [], atendePedidoId: 'p', observacao: 'Envio rápido (igual ao pedido)', recebidoEm: '2026-10-07T13:29:00Z', ...envio });
  };
  const solicitar = () => ab.registrarPedidoCorrecao('p', { acao: 'alterar', propostaPizzas: pizzas(5), propostaInsumos: [], numeroTicket: 12375, motivo: '55 deveria ser 5' });
  const decidir = aprovar => ab.decidirCorrecao('p', { aprovar, porEmail: 'master@teste', porNome: 'Master' });
  seed(); await solicitar();
  assert.equal(dados.get(key('e')).pizzas.calabresa, 55, 'solicitação não aplica antes de aprovação');
  await decidir(true);
  for (const id of ['p', 'e']) {
    assert.equal(dados.get(key(id)).pizzas.calabresa, 5);
    assert.equal(dados.get(key(id)).historicoCorrecoes[0].antes.pizzas.calabresa, 55);
  }
  assert.equal(dados.get(key('e')).correcaoPedido.numeroTicket, 12375);
  assert.equal(dados.get(key('e')).recebidoEm, '2026-10-07T13:29:00Z');
  await assert.rejects(() => decidir(true), /já foi decidida/);
  await ab.registrarPedidoCorrecao('p', { acao: 'alterar', propostaPizzas: pizzas(7), propostaInsumos: [], numeroTicket: 12376 });
  await decidir(true);
  assert.equal(dados.get(key('e')).pizzas.calabresa, 7);
  assert.equal(dados.get(key('e')).historicoCorrecoes.length, 2, 'preserva correções anteriores');
  seed({ envioRapido: true, observacao: 'Texto atualizado' }); await solicitar(); await decidir(true);
  assert.equal(dados.get(key('e')).pizzas.calabresa, 5, 'vínculo explícito não depende de descrição');
  seed(); await solicitar(); await decidir(false);
  assert.equal(dados.get(key('e')).pizzas.calabresa, 55);
  for (const patch of [{ observacao: 'Envio manual' }, { envioRapido: false }, { atendePedidoId: 'outro' }]) {
    seed(patch); await solicitar(); await decidir(true);
    assert.equal(dados.get(key('e')).pizzas.calabresa, 55, 'não propaga a envio independente');
  }
  for (const patch of [{ pizzas: pizzas(12) }, { correcao: { numeroTicket: 12387, status: 'pendente' } }]) {
    seed(patch); await solicitar(); await assert.rejects(() => decidir(true), /separadamente|pendente/);
    assert.equal(dados.get(key('p')).pizzas.calabresa, 55, 'conflito não aplica metade');
  }
  seed(); await solicitar(); falhar = true;
  await assert.rejects(() => decidir(true), /Falha simulada/); falhar = false;
  assert.equal(dados.get(key('p')).pizzas.calabresa, 55); assert.equal(dados.get(key('e')).pizzas.calabresa, 55);
  seed(); await solicitar();
  dados.get(key('p')).correcao.propostaInsumos = [{ descricao: 'Guardanapo', quantidade: 3 }];
  await decidir(true); assert.equal(dados.get(key('e')).insumos[0].quantidade, '3');
  seed();
  await ab.registrarPedidoCorrecao('e', { acao: 'alterar', propostaPizzas: pizzas(12), propostaInsumos: [], numeroTicket: 12387 });
  await ab.decidirCorrecao('e', { aprovar: true });
  assert.equal(dados.get(key('e')).envioRapido, false);
  await solicitar(); await decidir(true);
  assert.equal(dados.get(key('e')).pizzas.calabresa, 12, 'preserva correção própria do envio');
  // Criação rápida não copia uma tela antiga: usa o pedido atual e vincula atomicamente.
  dados.clear(); dados.set(key('p'), { id: 'p', tipo: 'PEDIDO', pizzas: pizzas(5), insumos: [] });
  const novo = await ab.criar({ tipo: 'ENVIO', atendePedidoId: 'p', envioRapido: true, pizzas: pizzas(55), insumos: [] });
  assert.equal(novo.pizzas.calabresa, 5); assert.equal(dados.get(key('p')).atendidoPorEnvioId, novo.id);
  await assert.rejects(() => ab.criar({ tipo: 'ENVIO', atendePedidoId: 'p', envioRapido: true, pizzas: pizzas(55) }), /já foi atendido/);
}
if (require.main === module) testar().then(() => console.log('✓ Correção do pedido sincroniza envio rápido, com histórico e atomicidade')).catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { testar };

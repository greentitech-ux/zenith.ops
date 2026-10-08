'use strict';
const assert = require('assert/strict');

async function testar({ DOCS, postarJson }) {
  const base = 'http://127.0.0.1:8899';
  const anterior = process.env.APP_BASE_URL;
  const atorAnterior = process.env.NOPULSO_AGENT_MASTER;
  process.env.APP_BASE_URL = base;
  process.env.NOPULSO_AGENT_MASTER = process.env.MASTER_EMAIL;
  try {
    const fu = require('./formulariosUnidades');
    const cw = require('./coworkApi');
    await fu.criar({ unidade: 'Loja teste link público', razaoSocial: 'Loja teste', cnpj: '11.222.333/0001-81' }, 'teste');
    const entrada = { tipo: 'deposito', unidade: 'Loja teste link público', modo: 'link' };
    const r = (await cw.executar({ nome: 'criar_formulario', entrada, idempotencyKey: 'link-publico-novo' })).resultado;
    assert.equal(r.linkValidado, true);
    const url = new URL(r.linkPreenchimento);
    assert.equal(url.pathname, '/preencher');
    for (const rota of ['/preencher', '/formulario-preencher', '/formulario-preencher.html']) {
      const pagina = await fetch(base + rota + url.search, { redirect: 'manual' });
      assert.equal(pagina.status, 200);
      assert.match(await pagina.text(), /api\/formularios-publico\/preencher/);
    }
    assert.equal((await fetch(base + '/api/formularios-publico/preencher/invalido')).status, 404);
    const { validarLinkPreenchimento } = require('./formularioLinkPublico');
    const formulario = { id: r.id, numeroTicket: 12382, tokenPreenchimento: url.searchParams.get('token') };
    await assert.rejects(validarLinkPreenchimento(base, { ...formulario, tokenPreenchimento: 'invalido' }), /não passou na validação/);
    const realFetch = global.fetch;
    try {
      for (const falha of ['404', 'login', 'redirect', 'timeout', 'api']) {
        global.fetch = async (url, opcoes) => {
          assert.equal(opcoes.redirect, 'error');
          if (falha === 'redirect' || falha === 'timeout') throw new Error(falha);
          if (falha === '404') return new Response('Cannot GET', { status: 404 });
          if (falha === 'login') return new Response('<html>Login</html>', { headers: { 'content-type': 'text/html' } });
          if (String(url).includes('/api/')) return new Response('{}', { status: 404 });
          return realFetch(url, opcoes);
        };
        await assert.rejects(cw.executar({ nome: 'criar_formulario', entrada, idempotencyKey: 'link-falha-' + falha }), /não passou na validação/);
        await assert.rejects(cw.executar({ nome: 'criar_formulario', entrada, idempotencyKey: 'link-publico-novo' }), /não passou na validação/);
      }
    } finally { global.fetch = realFetch; }
    const repetir = (await cw.executar({ nome: 'criar_formulario', entrada, idempotencyKey: 'link-recuperado' })).resultado;
    assert.equal(repetir.id, r.id, 'Falha de validação não duplica formulário');

    const dados = { unidade: 'LOJA_TESTE', motivoEstorno: 'Cobrança duplicada', valorVenda: 30, formaPagamento: 'Crédito', bandeira: 'Visa', dataVenda: '2026-10-08', valorEstornar: 30, nomeCliente: 'Cliente Teste', cpfCnpjCliente: '529.982.247-25', telefoneCliente: '81999999999', pixChave: 'teste@exemplo.local', pixNomeTitular: 'Cliente Teste', pixBanco: 'Banco teste' };
    const enviar = async (payload) => {
      const form = new FormData();
      form.append('payload', JSON.stringify(payload));
      form.append('anexos', new Blob(['comprovante local'], { type: 'image/png' }), 'comprovante.png');
      return fetch(base + '/api/refund-requests/publico', { method: 'POST', body: form });
    };
    const resposta = await enviar(dados);
    const resultado = await resposta.json();
    assert.equal(resposta.status, 200, JSON.stringify(resultado));
    const tarefa = DOCS.get('tarefas/' + resultado.id);
    const estorno = await require('./refunds').getOne(resultado.estornoId);
    assert.equal(tarefa.vinculo.id, estorno.id);
    assert.equal(estorno.origemTarefa.id, tarefa.id);
    assert.equal(estorno.numeroTicket, tarefa.numeroTicket);
    assert.equal(estorno.status, 'PENDENTE');
    assert.equal(estorno.anexos.length, 1);
    assert.equal(estorno.pixChave, dados.pixChave);
    await assert.rejects(require('./refunds').gerarFormulario(estorno.id, {}, 'teste'), /aprovado/i);
    const contar = () => [...DOCS.keys()].filter(k => /^(tarefas|refundRequests)\//.test(k)).length;
    const antes = contar();
    assert.equal((await enviar({ ...dados, nomeCliente: '' })).status, 400);
    assert.equal(contar(), antes, 'Validação inválida não persiste tarefa solta');
    const db = require('./firestore');
    const batchOriginal = db.batch;
    try {
      db.batch = () => { const lote = batchOriginal(); lote.commit = async () => { throw new Error('Falha simulada no commit'); }; return lote; };
      assert.equal((await enviar(dados)).status, 400);
      assert.equal(contar(), antes, 'Falha no commit não persiste nenhum dos registros');
    } finally { db.batch = batchOriginal; }
    if (process.env.TESTE_FORMULARIO_DASHBOARD === '1') {
      console.log('✓ Formulário público: rotas e conector sem login com proteção do dashboard ativa');
      return;
    }
    // Tarefas antigas de triagem conservam o protocolo e o comprovante ao
    // usar a ação autenticada já existente de criar o estorno.
    const usuario = (await require('./users').list()).find(u => u.email === process.env.MASTER_EMAIL);
    const antiga = await require('./tarefas').criar({ titulo: 'Estorno legado', unidade: dados.unidade, usuario, responsavel: usuario,
      origem: 'estorno-cliente', triagem: { tipoSugerido: 'estorno', estorno: { ...dados, origem: 'cliente' } },
      anexosIniciais: estorno.anexos });
    const token = (await require('./auth').login(process.env.MASTER_EMAIL, process.env.MASTER_PASSWORD)).token;
    const promovida = await postarJson('/api/refund-requests', { tarefaOrigemId: antiga.id, unidade: dados.unidade, password: process.env.MASTER_PASSWORD }, { Authorization: 'Bearer ' + token });
    assert.equal(promovida.status, 200, JSON.stringify(promovida));
    const registro = [...DOCS.entries()].find(([k,v]) => k.startsWith('refundRequests/') && v.origemTarefa?.id === antiga.id)?.[1];
    assert.equal(registro.numeroTicket, antiga.numeroTicket);
    assert.equal(registro.anexos[0].path, estorno.anexos[0].path);
    console.log('✓ Formulário público: conector, aliases sem login, token, falhas HTTP, estorno vinculado, gravação atômica e triagem antiga');
  } finally {
    if (anterior === undefined) delete process.env.APP_BASE_URL; else process.env.APP_BASE_URL = anterior;
    if (atorAnterior === undefined) delete process.env.NOPULSO_AGENT_MASTER; else process.env.NOPULSO_AGENT_MASTER = atorAnterior;
  }
}
module.exports = { testar };

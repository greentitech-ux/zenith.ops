'use strict';

// A Central precisa conversar com uma maquina sem virar uma porta de entrada
// para o NOC inteiro. Este teste cobre o contrato publico da aba: a lista nao
// vaza segredo tecnico, o historico e limitado e a resposta do agente volta
// para a mesma thread.
const assert = require('assert/strict');

async function testarHttp({ token, pedir, postarJson }) {
  const cab = { Authorization: 'Bearer ' + token };
  assert.equal((await pedir('/api/beniboy/computadores')).status, 401, 'sem sessão não lista computadores da Central');

  const listaResp = await pedir('/api/beniboy/computadores', cab);
  assert.equal(listaResp.status, 200, 'Central lista computadores para Master');
  const lista = JSON.parse(listaResp.corpo);
  const alvo = lista.find((c) => c.codigo === 'BRAC' && c.posto === 'PC01');
  assert.ok(alvo, 'máquina de teste aparece na lista da Central');
  assert.equal(Object.hasOwn(alvo, 'agentToken'), false, 'segredo do agente não sai na lista da Central');
  assert.equal(Object.hasOwn(alvo, 'ip'), false, 'IP não sai na lista da Central');

  const antes = await pedir('/api/beniboy/computadores/BRAC/PC01/mensagens', cab);
  assert.equal(antes.status, 200, 'Central abre a conversa da máquina');
  const corpoAntes = JSON.parse(antes.corpo);
  assert.equal(Object.hasOwn(corpoAntes.computador, 'agentToken'), false, 'segredo não sai no detalhe da conversa');

  const enviada = await postarJson('/api/beniboy/computadores/BRAC/PC01/mensagens', { texto: 'Teste Central → computador' }, cab);
  assert.equal(enviada.status, 200, 'Central envia mensagem para a máquina');
  const resposta = await postarJson('/api/loja-status/BRAC/computadores/PC01/chat-responder', { texto: 'Teste computador → Central' }, { 'x-noc-token': 'tok-bracos' });
  assert.equal(resposta.status, 200, 'agente responde com token da máquina');

  const depois = JSON.parse((await pedir('/api/beniboy/computadores/BRAC/PC01/mensagens', cab)).corpo);
  assert.ok(depois.mensagens.some((m) => m.texto === 'Teste Central → computador' && m.de === 'suporte'));
  assert.ok(depois.mensagens.some((m) => m.texto === 'Teste computador → Central' && m.de === 'computador'));
  assert.ok(depois.mensagens.every((m) => !Object.hasOwn(m, 'deEmail')), 'e-mail interno não sai no histórico da Central');
  console.log('✓ Central ↔ computadores: acesso, dados mínimos, envio e resposta do agente.');
}

module.exports = { testarHttp };

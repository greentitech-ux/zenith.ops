'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const resposta = texto => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: texto }] });
const modelo = { chamadas: [], responder: async () => resposta('Resposta de teste do Beniboy.') };
class ModeloFalso {
  constructor() { this.messages = { create: async entrada => { modelo.chamadas.push(entrada); return modelo.responder(entrada); } }; }
}
async function esperar(teste) {
  for (let i = 0; i < 100; i++) { if (await teste()) return; await new Promise(r => setTimeout(r, 20)); }
  assert.fail('Beniboy não respondeu ao pedido; ficou somente o link.');
}
async function testarHttp({ DOCS, postarJson, pedir, token }) {
  const suporte = require('./suporteChat');
  const bot = require('./suporteBot');
  const headers = { Authorization: 'Bearer ' + token };
  let liberar;
  modelo.responder = () => new Promise(resolve => { liberar = () => resolve(resposta('Vou verificar os arquivos solicitados.')); });
  const abertura = await postarJson('/api/suporte-chat/iniciar', { nome: 'Teste local', contato: 'teste@example.com', assunto: 'Outro', texto: 'Preciso dos arquivos XML do mês de setembro.' });
  assert.equal(abertura.status, 200, abertura.corpo);
  const c = JSON.parse(abertura.corpo), chave = 'suporteChats/' + c.id;
  await esperar(() => liberar);
  const iniciado = DOCS.get(chave);
  assert.equal(iniciado.mensagens.at(-1).aviso, 'protocolo');
  assert.equal(iniciado.aguardandoHumano, true, 'Recibo não retira o pedido da fila');
  assert.equal(iniciado.atendidoPorEmail, null);
  const entrada = modelo.chamadas.at(-1).messages;
  assert.equal(entrada.at(-1).role, 'user');
  assert(!JSON.stringify(entrada).includes(c.token), 'Token do acompanhamento não vai ao modelo');
  liberar();
  await esperar(() => DOCS.get(chave).mensagens.length === 3);
  const publico = await pedir(`/api/suporte-chat/${c.id}?token=${c.token}`);
  assert.equal(publico.status, 200);
  assert.match(JSON.parse(publico.corpo).mensagens.at(-1).texto, /arquivos solicitados/);
  const central = await pedir('/api/suporte-chats', headers);
  assert.equal(central.status, 200, central.corpo);
  assert.equal(JSON.parse(central.corpo).find(x => x.id === c.id).mensagens.length, 3, 'Central vê aviso e resposta');
  const quantas = modelo.chamadas.length;
  await bot.responderConversa(c.id);
  assert.equal(modelo.chamadas.length, quantas, 'Não duplica resposta ao consultar novamente');
  modelo.responder = async () => resposta('Continuamos no mesmo protocolo.');
  assert.equal((await postarJson(`/api/suporte-chat/${c.id}/mensagem`, { token: c.token, texto: 'Pode continuar por aqui?' })).status, 200);
  await esperar(() => DOCS.get(chave).mensagens.at(-1).texto === 'Continuamos no mesmo protocolo.');
  // Compatibilidade com conversa antiga que ficou apenas no recibo, sem migração.
  for (const sufixo of ['', '.html']) {
    const legado = { ...iniciado, id: 'legado-resposta' + sufixo, mensagens: iniciado.mensagens.map(m => { const v = { ...m, texto: m.texto.replace('/meu-atendimento#', '/meu-atendimento' + sufixo + '#') }; delete v.aviso; return v; }) };
    DOCS.set('suporteChats/' + legado.id, legado);
    assert(await bot.responderConversa(legado.id));
    assert.match(DOCS.get('suporteChats/' + legado.id).mensagens.at(-1).texto, /mesmo protocolo/);
  }
  // Falha/retorno vazio não abandona quem está esperando; permite nova tentativa.
  for (const falhar of [async () => { throw new Error('Falha simulada de API'); }, async () => ({ stop_reason: 'end_turn', content: [] }), async () => ({ stop_reason: 'refusal', content: [] })]) {
    modelo.responder = falhar;
    await suporte.adicionarMensagem(c.id, { de: 'visitante', token: c.token, texto: 'Ainda preciso de ajuda.' });
    const r = await bot.responderConversa(c.id);
    assert.equal(r.chamouAtendente, true);
    assert.equal(DOCS.get(chave).aguardandoHumano, true);
    assert.match(DOCS.get(chave).mensagens.at(-1).texto, /encaminhado ao time/);
    assert(!DOCS.get(chave).mensagens.at(-1).texto.includes('simulada'));
  }
  modelo.responder = async () => resposta('Atendimento retomado.');
  await suporte.adicionarMensagem(c.id, { de: 'visitante', token: c.token, texto: 'Consegue me ajudar agora?' });
  assert(await bot.responderConversa(c.id));
  // A resposta humana da Central continua interrompendo o bot.
  assert.equal((await postarJson(`/api/suporte-chats/${c.id}/responder`, { texto: 'O time assumiu.' }, headers)).status, 200);
  await suporte.adicionarMensagem(c.id, { de: 'visitante', token: c.token, texto: 'Obrigado.' });
  const antesHumano = modelo.chamadas.length;
  assert.equal(await bot.responderConversa(c.id), null);
  assert.equal(modelo.chamadas.length, antesHumano);
  // Campo interno nunca é aceito de um visitante nem faz sumir sua mensagem.
  await suporte.adicionarMensagem(c.id, { de: 'visitante', token: c.token, texto: 'Mais informações.', aviso: 'protocolo' });
  assert.equal(DOCS.get(chave).mensagens.at(-1).aviso, undefined);
  console.log('✓ Beniboy HTTP: abertura + recibo + resposta, Central e visitante, continuidade, legado, API indisponível/vazia, fila de espera e humano assumindo.');
}
async function testarSabotagem() {
  const arquivo = path.join(__dirname, 'suporteBot.js');
  const fonte = fs.readFileSync(arquivo, 'utf8');
  async function executar(codigo) {
    const chat = { id: 'c', status: 'ABERTO', mensagens: [{ de: 'visitante', texto: 'Preciso de ajuda.' }, { de: 'suporte', bot: true, aviso: 'protocolo', texto: 'Recibo automático' }] };
    const mocks = { './suporteChat': { getOne: async () => chat, adicionarMensagem: async (id, m) => { chat.mensagens.push(m); return chat; } }, './agenteAcoes': { obterContexto: async () => ({}) }, '@anthropic-ai/sdk': class { constructor() { this.messages = { create: async () => resposta('Atendimento iniciou.') }; } } };
    const mod = new Module(arquivo, module); mod.filename = arquivo; mod.paths = module.paths; mod.require = id => mocks[id] || {};
    mod._compile(codigo, arquivo);
    assert(await mod.exports.responderConversa('c'), 'Recibo bloqueou a resposta');
    assert.equal(chat.mensagens.at(-1).texto, 'Atendimento iniciou.');
  }
  const anterior = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = 'modelo-local';
  try {
    await executar(fonte);
    await assert.rejects(executar(fonte.replace('const msgs = mensagensDeAtendimento(chat);', 'const msgs = chat.mensagens || [];')), /Recibo bloqueou/);
    console.log('✓ Regressão reproduzida: restaurar o bloqueio antigo faz o teste falhar.');
  } finally { if (anterior === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = anterior; }
}
module.exports = { ModeloFalso, testarHttp, testarSabotagem };
if (require.main === module) testarSabotagem().catch(e => { console.error(e); process.exitCode = 1; });

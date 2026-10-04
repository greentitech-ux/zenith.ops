'use strict';
const assert = require('assert/strict');
const { criarServico } = require('./chatDigitando');
async function testar() {
  let instante = 10000;
  const s = criarServico({ agora: () => instante });
  try {
    const chat = { id: 'a', status: 'ABERTO' };
    const v = s.emitir(chat, 'visitante'), p = s.emitir(chat, 'suporte', 'atendente-1');
    assert.equal(s.emitir(chat, 'visitante'), v, 'consulta existente não recria o canal');
    assert.equal(s.validar('b', v), null, 'capacidade não abre outra conversa');
    assert.equal(s.sinalizar('a', 'forjado', true), false);
    s.sinalizar('a', v, true);
    assert.equal(s.estado('a', 'suporte').ativo, true);
    assert.equal(s.estado('a', 'visitante').ativo, false, 'não mostra a própria digitação');
    instante += 100; s.sinalizar('a', v, true);
    assert.equal(s.estado('a', 'suporte').prazoMs, 7900, 'não renova a cada tecla');
    instante += 8000; s.limpar(); assert.equal(s.estado('a', 'suporte').ativo, false);
    const outro = s.emitir(chat, 'suporte', 'atendente-2');
    s.sinalizar('a', p, true); s.sinalizar('a', outro, true); s.sinalizar('a', p, false);
    assert.equal(s.estado('a', 'visitante').ativo, true, 'parar um atendente não apaga o outro');
    s.emitir({ ...chat, status: 'FINALIZADO' }, 'visitante');
    assert.equal(s.validar('a', v), null, 'encerrar revoga concessões');
    const novo = s.emitir(chat, 'visitante'); instante += 15 * 60000 + 1;
    assert.equal(s.validar('a', novo), null, 'capacidade expira');
    // Sabotagem: uma validação que ignora o id é detectada pela mesma invariante.
    const sabotada = (id, token) => s.validar('a', token);
    const valido = s.emitir(chat, 'visitante');
    assert.throws(() => assert.equal(sabotada('b', valido), null));
    console.log('✓ Digitando: isolamento, frequência, expiração, múltiplos atendentes, revogação e sabotagem.');
  } finally { s.fechar(); }
}
async function testarHttp({ DOCS, token, pedir, postarJson, LEITURAS }) {
  DOCS.set('suporteChats/digitando-http', { id:'digitando-http', nome:'Visitante teste', contato:'teste@invalid', token:'visitante-teste', status:'ABERTO', mensagens:[] });
  await require('./suporteChat').registrarPedidoVerificado('digitando-http', null);
  const url = '/api/suporte-chat/digitando-http';
  assert.equal((await pedir(url+'?token=errado')).status,404);
  const visitante = JSON.parse((await pedir(url+'?token=visitante-teste')).corpo);
  assert.match(visitante.digitacaoToken, /^[a-f0-9]{48}$/);
  assert.equal((await pedir('/api/suporte-chats')).status,401);
  const lista = JSON.parse((await pedir('/api/suporte-chats', {Authorization:'Bearer '+token})).corpo);
  const suporte = lista.find(c=>c.id==='digitando-http');
  assert.ok(suporte.digitacaoToken && suporte.digitacaoToken!==visitante.digitacaoToken);
  const leiturasAntes = LEITURAS.docs;
  for (let i=0;i<10;i++) assert.equal((await postarJson(url+'/digitando',{token:visitante.digitacaoToken,ativo:true})).status,200);
  assert.equal(LEITURAS.docs,leiturasAntes,'sinais de digitação não consultam Firestore');
  assert.equal((await postarJson('/api/suporte-chat/outra/digitando',{token:visitante.digitacaoToken,ativo:true})).status,404);
  assert.equal((await postarJson(url+'/digitando',{token:visitante.digitacaoToken,ativo:true,texto:'rascunho proibido'})).status,400);
  await postarJson('/api/suporte-chats/digitando-http/finalizar',{}, {Authorization:'Bearer '+token});
  assert.equal((await postarJson(url+'/digitando',{token:visitante.digitacaoToken,ativo:true})).status,404);
  console.log('✓ Digitando HTTP: concessões autorizadas, token falso/outra conversa/texto bloqueados, sem leituras extras.');
}
async function testarSSE() {
  const express = require('express'), app = express(); app.use(express.json());
  let instante=10000;
  const servico=criarServico({agora:()=>instante}); servico.registrarRotas(app);
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`, abortos=[];
  const ler=async reader=>{
    let timer;
    try {const resultado=await Promise.race([reader.read(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('SSE não entregou o sinal')),1500);})]);return new TextDecoder().decode(resultado.value);}
    finally {clearTimeout(timer);}
  };
  try {
    const chat={id:'a',status:'ABERTO'},v=servico.emitir(chat,'visitante'),p=servico.emitir(chat,'suporte','p');
    const b=servico.emitir({id:'b',status:'ABERTO'},'visitante');
    assert.equal((await fetch(base+`/api/suporte-chat/b/digitando-stream?token=${v}`)).status,404);
    const conectar=async(id,token)=>{
      const ab=new AbortController();abortos.push(ab);
      const r=await fetch(base+`/api/suporte-chat/${id}/digitando-stream?token=${token}`,{signal:ab.signal});
      assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/text\/event-stream/);
      return r.body.getReader();
    };
    const aReader=await conectar('a',v),bReader=await conectar('b',b);
    assert.match(await ler(aReader),/"ativo":false/);assert.match(await ler(bReader),/"ativo":false/);
    await fetch(base+'/api/suporte-chat/a/digitando',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:p,ativo:true})});
    assert.match(await ler(aReader),/"ativo":true/,'evento chega imediatamente, sem poll');
    const outra=bReader.read().then(()=>true,()=>false);
    assert.equal(await Promise.race([outra,new Promise(resolve=>setTimeout(()=>resolve(false),80))]),false,'outra conversa não recebe o sinal');
    instante+=8001;servico.limpar();assert.match(await ler(aReader),/"ativo":false/,'expiração remove o aviso');
    console.log('✓ Digitando SSE HTTP: evento imediato, capacidade limitada à conversa e expiração.');
  } finally {
    for(const ab of abortos)ab.abort();servico.fechar();server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
}
module.exports = { testar, testarHttp, testarSSE };
if (require.main===module) (async()=>{await testar();await testarSSE();})().catch(e=>{console.error(e);process.exitCode=1;});

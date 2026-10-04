'use strict';
const assert = require('assert/strict');
const agente = require('./agenteAndroid');

async function testar() {
  const suporte = {user:{cargo:'suporte',permissions:{sections:['network-private']}}};
  assert.equal(agente.podeBaixarInstalador(suporte),true);
  assert.equal(agente.podeBaixarInstalador({isMaster:true}),true);
  for(const req of [{isMaster:true,isQaMaster:true},{isAdmin:true,user:{}},{user:{cargo:'suporte',permissions:{sections:['suporte']}}},{user:{cargo:'tecnico',permissions:{sections:['network-private']}}},{}]) {
    assert.equal(agente.podeBaixarInstalador(req),false);
  }
  // Sabotagem do cadastro: remover NOC do Suporte deve reprovar o acesso esperado.
  assert.throws(()=>assert.equal(agente.podeBaixarInstalador({...suporte,user:{...suporte.user,permissions:{sections:[]}}}),true));
  const ambiente = process.env.AGENTE_ANDROID_URL;
  const fetchOriginal = global.fetch;
  const express = require('express');
  const app = express();
  app.get('/apk', (req,res)=>agente.baixarInstalador(req.headers['x-permitido'] ? Object.assign(req,suporte) : req,res));
  const servidor = app.listen(0,'127.0.0.1');
  await new Promise(r=>servidor.once('listening',r));
  const endereco = 'http://127.0.0.1:'+servidor.address().port+'/apk';
  const apk = Buffer.from([0x50,0x4b,0x03,0x04,1,2,3]);
  let chamadas = 0;
  try {
    process.env.AGENTE_ANDROID_URL='https://arquivos.exemplo/assinado.apk';
    global.fetch=async (url,opcoes)=>{
      if(String(url).startsWith('http://127.0.0.1:')) return fetchOriginal(url,opcoes);
      chamadas++;
      assert.equal(opcoes.headers,undefined,'Nunca encaminhar credencial NoPulso para a origem');
      return new Response(apk);
    };
    assert.equal((await fetch(endereco)).status,403);
    assert.equal(chamadas,0,'Negar antes de consultar origem');
    let resposta=await fetch(endereco,{headers:{'x-permitido':'1'}});
    assert.equal(resposta.status,200);
    assert.match(resposta.headers.get('content-type'),/android.package-archive/);
    assert.match(resposta.headers.get('content-disposition'),/\.apk/);
    assert.match(resposta.headers.get('cache-control'),/no-store/);
    assert.deepEqual(Buffer.from(await resposta.arrayBuffer()),apk);
    global.fetch=async (url,opcoes)=>String(url).startsWith('http://127.0.0.1:') ? fetchOriginal(url,opcoes) : new Response('<html>Login</html>');
    resposta=await fetch(endereco,{headers:{'x-permitido':'1'}});
    assert.equal(resposta.status,502,'Não entregar HTML como APK');
    process.env.AGENTE_ANDROID_URL='';
    assert.equal((await fetch(endereco,{headers:{'x-permitido':'1'}})).status,503);
    for(const url of ['http://inseguro/arquivo.apk','https://usuario:senha@exemplo/arquivo.apk','invalido']) {
      process.env.AGENTE_ANDROID_URL=url; assert.equal(agente.urlDoApk(),'');
    }
    console.log('✓ Instalador Android: Master/Suporte + NOC, sem Admin implícito, APK/HTML, origem ausente e sabotagem.');
  } finally {
    global.fetch=fetchOriginal;
    if(ambiente===undefined) delete process.env.AGENTE_ANDROID_URL; else process.env.AGENTE_ANDROID_URL=ambiente;
    await new Promise(r=>servidor.close(r));
  }
}
async function testarHttp({DOCS,token,pedir}) {
  const jwt=require('jsonwebtoken');
  const ids=['apk-suporte-noc','apk-suporte-sem-noc','apk-tecnico-noc','apk-admin'];
  ids.forEach((id,i)=>DOCS.set('users/'+id,{username:id,role:'user',active:true,cargo:i<2?'suporte':'tecnico',isAdmin:i===3,somenteNoc:false,permissions:{sections:i===1?['suporte']:['network-private'],unidades:[]}}));
  const ambiente=process.env.AGENTE_ANDROID_URL;
  process.env.AGENTE_ANDROID_URL='';
  try {
    assert.equal((await pedir('/api/loja-status/agente-android/baixar')).status,401);
    assert.equal((await pedir('/api/loja-status/agente-android/baixar',{Authorization:'Bearer '+token})).status,503);
    for(let i=0;i<ids.length;i++) {
      const t=jwt.sign({sub:ids[i],role:'user'},process.env.JWT_SECRET,{expiresIn:'5m'});
      const cabecalhos={Authorization:'Bearer '+t};
      assert.equal((await pedir('/api/loja-status/agente-android/baixar',cabecalhos)).status,i===0?503:403);
      const me=await pedir('/api/me',cabecalhos);
      assert.equal(JSON.parse(me.corpo).podeBaixarAgenteAndroid,i===0);
    }
    console.log('✓ Instalador Android por HTTP autenticado: anônimo bloqueado e cargo/permissão verificados no servidor.');
  } finally { if(ambiente===undefined) delete process.env.AGENTE_ANDROID_URL; else process.env.AGENTE_ANDROID_URL=ambiente; }
}
module.exports={testar,testarHttp};
if(require.main===module) testar().catch(e=>{console.error(e);process.exitCode=1;});

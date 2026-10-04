'use strict';
const assert=require('assert/strict');
const agente=require('./agenteAndroid');
async function testar() {
  let chamadas=0,tempo=1000,publicado=false;
  const consultar=async()=>{chamadas++;await new Promise(r=>setTimeout(r,10));return new Response(null,{status:publicado?200:404,headers:{'content-length':publicado?'1580000':'0'}});};
  const anuncio=agente.criarAnuncio({consultar,agora:()=>tempo});
  const url='https://arquivos.example/agente.apk';
  const antes=await Promise.all(Array.from({length:25},()=>anuncio(url)));
  assert.equal(chamadas,1,'Uma consulta compartilhada, não uma por aparelho');
  assert.ok(antes.every(v=>v.versao===0 && v.url===''),'Não avisar APK inexistente');
  await anuncio(url);assert.equal(chamadas,1,'Esperar antes de tentar publicação novamente');
  tempo+=30001;publicado=true;
  const depois=await Promise.all(Array.from({length:25},()=>anuncio(url)));
  assert.equal(chamadas,2);
  assert.ok(depois.every(v=>v.versao===agente.VERSAO_AGENTE_ANDROID && v.url===url));
  tempo+=86400000;await anuncio(url);assert.equal(chamadas,2,'Publicação imutável confirmada não consulta a cada heartbeat');
  assert.deepEqual(await anuncio(''),{versao:0,url:''});
  assert.throws(()=>assert.equal(antes[0].versao,agente.VERSAO_AGENTE_ANDROID),'Sabotagem: anúncio prematuro detectado');
  const fonte=require('fs').readFileSync(require('path').join(__dirname,'../android/app/src/main/java/br/com/nopulso/agente/Atualizacao.kt'),'utf8');
  assert.match(fonte,/versao_avisada/);assert.match(fonte,/areNotificationsEnabled/);
  console.log('✓ Atualização Android: publicação confirmada, cache concorrente, ausência de APK e anúncio prematuro detectado.');
}
async function testarHttp({postarJson}) {
  const original=agente.metadadosAtualizacao;
  let chamadas=0;
  agente.metadadosAtualizacao=async()=>{chamadas++;return {versao:agente.VERSAO_AGENTE_ANDROID,url:'https://arquivos.example/agente.apk'};};
  try {
    const android=await postarJson('/api/loja-status/heartbeat',{unidade:'AVISO_APK_TESTE',posto:'TABLET',userAgent:'NoPulsoAgente/4 (Linux; Android 14)'});
    assert.equal(android.status,200);
    assert.equal(JSON.parse(android.corpo).atualizacaoAndroid.versao,agente.VERSAO_AGENTE_ANDROID);
    const pc=await postarJson('/api/loja-status/heartbeat',{unidade:'AVISO_APK_TESTE',posto:'PC',userAgent:'NOCZenith/141'});
    assert.equal(pc.status,200);assert.equal(JSON.parse(pc.corpo).atualizacaoAndroid,undefined);
    assert.equal(chamadas,1,'Windows não precisa receber ou consultar versão Android');
    console.log('✓ Atualização Android HTTP: metadados no heartbeat existente, Windows preservado.');
  } finally {agente.metadadosAtualizacao=original;}
}
module.exports={testar,testarHttp};
if(require.main===module) testar().catch(e=>{console.error(e);process.exitCode=1;});

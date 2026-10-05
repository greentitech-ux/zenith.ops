'use strict';
const assert=require('assert/strict'),Module=require('module');
const seg=require('./pushSeguranca');
const keys={p256dh:Buffer.concat([Buffer.from([4]),Buffer.alloc(64,7)]).toString('base64url'),auth:Buffer.alloc(16,9).toString('base64url')};
const sub=id=>({endpoint:'https://fcm.googleapis.com/fcm/send/'+id,keys});
const docs=new Map(),original=Module._load;
let gravacoes=0;
const collection={doc(id){return {id,async get(){return {exists:docs.has(id),data:()=>docs.get(id)};},async set(d){gravacoes++;docs.set(id,d);},async delete(){docs.delete(id);}};},async get(){return {docs:[...docs.values()].map(d=>({data:()=>d}))};}};
Module._load=function(nome,pai,...args){
  if(pai?.filename===require.resolve('./push')){
    if(nome==='./firestore')return {collection:()=>collection};
    if(nome==='./users')return {list:async()=>[]};
    if(nome==='./alertasCentral')return {};
    if(nome==='web-push')return {setVapidDetails(){}};
  }
  return original.call(this,nome,pai,...args);
};
(async()=>{try{
  const push=require('./push');
  for(const endpoint of ['http://127.0.0.1/x','https://localhost/x','https://169.254.169.254/x','https://fcm.googleapis.com.evil.example/x','https://evil.example/x','https://user@fcm.googleapis.com/x','https://fcm.googleapis.com:444/x']){
    assert.throws(()=>seg.endpointSeguro(endpoint));
    await assert.rejects(()=>push.addSubscription({...sub('x'),endpoint},{userId:'a'}));
  }
  assert.equal(gravacoes,0);
  assert.throws(()=>seg.validarSubscricao({endpoint:sub('x').endpoint,keys:{}}));
  assert.notEqual(seg.idSubscricao(sub('a'.repeat(500)+'1').endpoint),seg.idSubscricao(sub('a'.repeat(500)+'2').endpoint));
  await assert.rejects(()=>push.migrarSubscricao(sub('ausente').endpoint,sub('novo'),keys.auth));
  assert.equal(gravacoes,0);
  await push.addSubscription(sub('antigo'),{userId:'a',isMaster:true});
  await assert.rejects(()=>push.migrarSubscricao(sub('antigo').endpoint,sub('novo'),Buffer.alloc(16,1).toString('base64url')));
  assert.equal(gravacoes,1);
  await assert.rejects(()=>push.removeSubscription(sub('antigo').endpoint,'outro'));
  assert.equal(docs.size,1);
  await push.migrarSubscricao(sub('antigo').endpoint,sub('novo'),keys.auth);
  assert.equal(docs.size,1);assert.equal(docs.get(seg.idSubscricao(sub('novo').endpoint)).meta.userId,'a');
  await push.removeSubscription(sub('novo').endpoint,'a');assert.equal(docs.size,0);
  assert.throws(()=>assert.ok(!seg.provaDePosse(keys.auth,keys.auth)),'sabotagem detecta prova alterada');
  console.log('✓ Push seguro: SSRF, chaves, colisão, renovação, prova de posse e exclusão por dono.');
}finally{Module._load=original;}})().catch(e=>{console.error(e);process.exitCode=1;});

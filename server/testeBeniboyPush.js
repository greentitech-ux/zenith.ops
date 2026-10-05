'use strict';
// Dependências simuladas: não envia notificações nem toca em contas reais.
const assert=require('assert/strict'),Module=require('module');
const antigoLoad=Module._load;
const enviados=[];
let contas=[{id:'master',role:'master'},{id:'tec',cargo:'tecnico'},{id:'operador',cargo:'operador'}];
const subs=[
  {endpoint:'https://teste/master',meta:{userId:'master',isMaster:true}},
  {endpoint:'https://teste/central',meta:{userId:'master',isMaster:true,appBeniboy:true}},
  {endpoint:'https://teste/tec',meta:{userId:'tec',appBeniboy:true}},
  {endpoint:'https://teste/operador',meta:{userId:'operador',appBeniboy:true}},
];
const chaves={publica:process.env.VAPID_PUBLIC_KEY,privada:process.env.VAPID_PRIVATE_KEY};
process.env.VAPID_PUBLIC_KEY='simulada';process.env.VAPID_PRIVATE_KEY='simulada';
Module._load=function(nome,pai,...resto){
  if(pai?.filename===require.resolve('./push')){
    if(nome==='web-push') return {setVapidDetails(){},async sendNotification(sub,payload){enviados.push({endpoint:sub.endpoint,dados:JSON.parse(payload)});}};
    if(nome==='./firestore') return {collection(){return {async get(){return {docs:subs.map(s=>({data:()=>s}))};}};}};
    if(nome==='./users') return {async list(){return contas;}};
    if(nome==='./alertasCentral') return {async registrar(){}};
  }
  return antigoLoad.call(this,nome,pai,...resto);
};
(async()=>{
  try{
    const push=require('./push');
    await push.notifyChatBeniboy({id:'chat-teste'},'Novo atendimento','Teste');
    assert.deepEqual(enviados.map(e=>e.endpoint),['https://teste/master','https://teste/central','https://teste/tec']);
    assert.ok(enviados.every(e=>e.dados.beniboy && e.dados.url==='/atendimento/central?chat=chat-teste'));
    contas=contas.map(u=>u.id==='tec'?{...u,cargo:'operador'}:u);enviados.length=0;
    await push.notifyChatBeniboy({id:'chat-teste'},'Mensagem','Teste');
    assert.ok(!enviados.some(e=>e.endpoint==='https://teste/tec'),'revogação usa cargo atual');
    assert.throws(()=>assert.ok(true===enviados.some(e=>e.endpoint==='https://teste/tec')),'sabotagem detecta cargo revogado');
    enviados.length=0;await push.notifySolicitacao('Financeiro','Teste','financeiro');
    assert.deepEqual(enviados.map(e=>e.endpoint),['https://teste/master'],'Central não recebe outras áreas');
    console.log('✓ Push Beniboy: identidade própria, cargos atuais, revogação e isolamento do NoPulso.');
  }finally{
    Module._load=antigoLoad;
    for(const [nome,valor] of [['VAPID_PUBLIC_KEY',chaves.publica],['VAPID_PRIVATE_KEY',chaves.privada]]){if(valor===undefined)delete process.env[nome];else process.env[nome]=valor;}
  }
})().catch(e=>{console.error(e);process.exitCode=1;});

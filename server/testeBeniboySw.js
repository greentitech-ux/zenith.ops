'use strict';
const assert=require('assert/strict'),fs=require('fs'),vm=require('vm');
const eventos={},avisos=[];
const self={
  location:{origin:'https://nopulso.teste'},
  addEventListener(nome,funcao){eventos[nome]=funcao;},
  skipWaiting(){},
  registration:{async showNotification(titulo,dados){avisos.push({titulo,dados});}},
  clients:{async claim(){},async matchAll(){return [];},async openWindow(url){avisos.push({abriu:url});}},
};
vm.runInNewContext(fs.readFileSync(require.resolve('./public/beniboy-sw.js'),'utf8'),{self,URL});
(async()=>{
  let promessa;
  eventos.push({data:{json:()=>({title:'Financeiro'})},waitUntil:p=>promessa=p});
  assert.equal(avisos.length,0,'não exibe alerta de outra área');
  eventos.push({data:{json:()=>({title:'Atendimento',beniboy:true,chatId:'123'})},waitUntil:p=>promessa=p});
  await promessa;
  assert.equal(avisos[0].dados.icon,'/beniboy-app-192.png');
  assert.equal(avisos[0].dados.data.url,'/atendimento/central?chat=123');
  eventos.notificationclick({notification:{close(){},data:avisos[0].dados.data},waitUntil:p=>promessa=p});
  await promessa;
  assert.equal(avisos[1].abriu,'https://nopulso.teste/atendimento/central?chat=123');
  eventos.notificationclick({notification:{close(){},data:{url:'https://externo.invalid/atendimento'}},waitUntil:p=>promessa=p});
  assert.equal(avisos.length,2,'não abre destino externo');
  assert.throws(()=>assert.equal(avisos[0].dados.icon,'/favicon.ico'),'sabotagem detecta ícone errado');
  console.log('✓ Worker Beniboy: somente atendimento, ícone próprio, conversa certa e URL externa bloqueada.');
})().catch(e=>{console.error(e);process.exitCode=1;});

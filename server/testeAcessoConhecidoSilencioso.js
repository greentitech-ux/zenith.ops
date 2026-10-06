'use strict';
// Executa o handler real com histórico/push locais; não usa API nem banco de produção.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const fonte=fs.readFileSync(path.join(__dirname,'index.js'),'utf8');
const inicio=fonte.indexOf("app.post('/api/loja-status/:codigo/computadores/:posto/acesso-remoto'");
const fim=fonte.indexOf('\n});',inicio)+4;
assert(inicio>=0 && fim>inicio);
const handlerFonte=fonte.slice(inicio,fim);
const lsFonte=fs.readFileSync(path.join(__dirname,'lojaStatus.js'),'utf8');
const funcoes=lsFonte.slice(lsFonte.indexOf('function idAnydeskLimpo('),lsFonte.indexOf('async function setConfig('));
async function testar(src){
  const eventos=[],avisos=[];let handler;
  const cfg={acessosConhecidos:[{id:'1504619001',nome:'STT HOME'}],push:true};
  const contexto={console:{log(){},error(){}},app:{post:(url,fn)=>handler=fn},construirUnidadesMapa:async()=>({DOM_BESSA:'DOMINOS BESSA'}),push:{notifyAcessoRemotoDetectado:async(...args)=>avisos.push(args)}};
  vm.createContext(contexto);vm.runInContext(funcoes,contexto);
  contexto.lojaStatus={
    registrarAcessoRemoto:async(codigo,posto,detalhe,token,sessao)=>{if(token!=='token-local')throw Error('Token inválido');eventos.push({codigo,posto,detalhe,sessao});return {nome:'DOM-BESSA-DISPATCH'};},
    getConfig:async()=>({acessosConhecidos:cfg.acessosConhecidos}),
    acessoConhecidoDe:contexto.acessoConhecidoDe,pushAcessoRemotoAtivo:async()=>cfg.push,
  };
  vm.runInContext(src,contexto);
  async function enviar(detalhe,sessao=true,token='token-local'){
    const resposta={status:200,status(n){this.status=n;return this;},json(r){this.corpo=r;}};
    await handler({params:{codigo:'DOM_BESSA',posto:'dispatch'},headers:{'x-noc-token':token},body:{detalhe,sessao}},resposta);
    return resposta;
  }
  const conhecido='AnyDesk · info 2026-10-06 02:03:43.515 gsvc 27332 19768 13 anynet.any_socket - Accept request from 1504619001 (via relay).';
  assert.equal((await enviar(conhecido)).corpo.ok,true);assert.equal(avisos.length,0);
  assert.equal(eventos.length,1);assert.equal(eventos[0].detalhe,conhecido);
  await enviar('AnyDesk · incoming session from 555444333');assert.equal(avisos.length,1);
  await enviar('AnyDesk · incoming session from 1504619001123');assert.equal(avisos.length,2);
  assert.equal(contexto.acessoConhecidoDe('AnyDesk session 12345678901234567',[{id:'1234567890123456'}]),null);
  await enviar('AnyDesk serviço conectado',false);assert.equal(avisos.length,2);
  await enviar('AnyDesk · incoming session from 555444333',true,'inválido');assert.equal(avisos.length,2);assert.equal(eventos.length,4);
  cfg.acessosConhecidos=[];
  await enviar(conhecido);assert.equal(avisos.length,3);
  cfg.push=false;
  await enviar('AnyDesk · incoming session from 555444333');assert.equal(avisos.length,3);assert.equal(eventos.length,6);
}
(async()=>{
  await testar(handlerFonte);
  const sabotado=handlerFonte.replace('ehSessao && !conhecido &&','ehSessao &&');
  assert.notEqual(sabotado,handlerFonte);await assert.rejects(()=>testar(sabotado));
  console.log('OK: STT HOME sem alarme, desconhecidos alertam, histórico preservado, serviço silencioso, ID parcial não libera, token inválido bloqueado, configuração e sabotagem.');
})().catch(e=>{console.error(e);process.exitCode=1;});

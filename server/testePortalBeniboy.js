'use strict';
const assert=require('assert/strict');
async function testarHttp({DOCS,pedir,postarJson}){
  const jwt=require('jsonwebtoken'),auth=require('./auth');
  const cargos=[['tecnico',true],['suporte',true],['operador',false]];
  for(const [cargo,permitido] of cargos){
    const id='portal-beniboy-'+cargo;
    DOCS.set('users/'+id,{id,role:'user',active:true,cargo,cargos:[cargo],somenteNoc:false,permissions:{sections:[],unidades:[]}});
    const token=jwt.sign({sub:id,role:'user'},process.env.JWT_SECRET);
    const h={Authorization:'Bearer '+token};
    const acesso=await pedir('/api/beniboy/acesso',h);
    assert.equal(acesso.status,200);
    assert.equal(JSON.parse(acesso.corpo).permitido,permitido);
    assert.equal((await pedir('/api/suporte-chats',h)).status,permitido?200:403,'servidor protege a fila');
    if(!permitido) assert.equal((await postarJson('/api/push/subscribe',{appBeniboy:true},h)).status,403,'operador não inscreve alertas internos');
    if(permitido){
      DOCS.get('users/'+id).cargo='operador';DOCS.get('users/'+id).cargos=['operador'];
      auth.invalidarUsuario(id);
      assert.equal((await pedir('/api/suporte-chats',h)).status,403,'revogação não depende de esconder o botão');
    }
    DOCS.delete('users/'+id);auth.invalidarUsuario(id);
  }
  assert.equal((await pedir('/api/beniboy/acesso')).status,401);
  assert.equal((await postarJson('/api/push/subscribe',{appBeniboy:true})).status,401);
  for(const url of ['/atendimento','/atendimento/entrar','/atendimento/central','/atendimento/sw.js','/manifest-beniboy.json','/beniboy-app-192.png','/beniboy-app-512.png']){
    assert.equal((await pedir(url)).status,200,'arquivo público disponível: '+url);
  }
  console.log('✓ Portal Beniboy HTTP: Técnico/Suporte, operador bloqueado, revogação, anônimo sem acesso interno e arquivos do atalho.');
}
module.exports={testarHttp};

'use strict';
const assert=require('assert/strict');
const central=require('./centralSubdominio');
const oficial='https://www.nopulso.com.br';
function pedido(path, originalUrl=path, accept='text/html'){
  return {method:'GET',path,originalUrl,headers:{host:central.hostAtendimento(),accept}};
}

assert.equal(central.destino(pedido('/'),oficial),'/atendimento/central');
assert.equal(central.destino(pedido('/beniboy','/beniboy?chat=123'),oficial),'/atendimento/central?chat=123');
assert.equal(central.destino(pedido('/noc-maquinas','/noc-maquinas?unidade=DOM'),oficial),`${oficial}/noc-maquinas?unidade=DOM`);
assert.equal(central.destino(pedido('/api/me','/api/me','application/json'),oficial),null);
assert.equal(central.destino({...pedido('/'),headers:{host:'www.nopulso.com.br',accept:'text/html'}},oficial),null);
assert.equal(central.manifesto({scope:'/atendimento/',start_url:'/atendimento/central'}).scope,'/');
console.log('✓ Central em subdomínio: raiz, legado, isolamento, API e manifesto.');

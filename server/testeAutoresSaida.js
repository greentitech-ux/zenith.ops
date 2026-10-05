'use strict';
const assert = require('node:assert/strict');
async function testar(modulo = require('./autoresSaida')){
  const { listar, resolver } = modulo;
  let lista = [
    {id:'loja',nome:'Leisly',active:true,permissions:{unidades:['Mooca']}},
    {id:'admin',nome:'André',isAdmin:true,permissions:{unidades:['Mooca','Carrao']},empresaId:'arc'},
    {id:'fora',nome:'Outra loja',permissions:{unidades:['Carrao']}},
    {id:'admin-fora',nome:'Admin fora',isAdmin:true,permissions:{unidades:['Carrao']}},
    {id:'inativo',nome:'Inativo',active:false,permissions:{unidades:['Mooca']}},
    {id:'master',nome:'Master',role:'master',permissions:{unidades:['Mooca']}},
    {id:'empresa-fora',nome:'Cadastro incorreto',empresaId:'outra',permissions:{unidades:['Mooca']}},
    {id:'global',nome:'Admin sem vínculo',isAdmin:true,permissions:{unidades:[]}},
  ];
  const deps={users:{list:async()=>lista},empresas:{unidadesDaEmpresa:async id=>id==='arc'?['Mooca','Carrao']:['Outra']}};
  assert.deepEqual((await listar('Mooca',deps)).map(u=>u.id).sort(),['admin','loja']);
  assert.deepEqual(await resolver('admin','Mooca',deps),{criadoPorId:'admin',criadoPorNome:'André',criadoPorEmail:''});
  for(const id of ['fora','admin-fora','inativo','master','empresa-fora','global','texto livre']) await assert.rejects(()=>resolver(id,'Mooca',deps),/vinculado/);
  await assert.rejects(()=>resolver('loja','Carrao',deps),/vinculado/);
  lista=lista.map(u=>u.id==='admin'?{...u,permissions:{unidades:['Carrao']}}:u);
  await assert.rejects(()=>resolver('admin','Mooca',deps),/vinculado/,'revogação entre abrir e salvar');
  await assert.rejects(()=>listar('',deps),/unidade/);
  const regra=require('./saidaAvulsaEdicao');
  const f={id:'x',data:'2026-10-05',unidade:'Mooca',totalSaida:10,detalhesSaidas:[{descricao:'taxi',valor:10,criadoPorNome:'Antigo'}]};
  const p=regra.preparar(f,0,{criadoPorId:'loja',criadoPorNome:'Leisly',criadoPorEmail:'loja@teste',editadoPorEmail:'master@teste'});
  assert.equal(p.origem.detalhesSaidas[0].criadoPorId,'loja');
  assert.equal(p.origem.historico[0].valoresAnteriores.saida.criadoPorNome,'Antigo');
  const fs=require('node:fs'),vm=require('node:vm');
  const html=fs.readFileSync(__dirname+'/public/saidas.html','utf8');
  assert.match(html,/<select id="ed-saida-autor">/);
  assert.doesNotMatch(html,/<input[^>]*id="ed-saida-autor"/);
  const elementos={};const el=id=>elementos[id]||(elementos[id]={value:'',classList:{remove(){}},addEventListener(){}});
  const pendentes=[];
  const ctx={IS_MASTER:true,document:{getElementById:el},encodeURIComponent,escapeHtml:String,fetch:()=>new Promise(resolve=>pendentes.push(resolve))};
  vm.createContext(ctx);
  vm.runInContext(html.slice(html.indexOf('let ED_SAIDA = null;'),html.indexOf('function abrirEditarSaida(')),ctx);
  el('ed-saida-unidade').value='Mooca';
  const a=vm.runInContext("ED_SAIDA={unidade:'Mooca'};carregarAutoresSaida()",ctx);
  el('ed-saida-unidade').value='Carrao';
  const b=vm.runInContext('carregarAutoresSaida()',ctx);
  pendentes[1]({ok:true,json:async()=>[{id:'b',nome:'Usuário Carrao'}]});await b;
  pendentes[0]({ok:true,json:async()=>[{id:'a',nome:'Usuário Mooca'}]});await a;
  assert.match(el('ed-saida-autor').innerHTML,/Usuário Carrao/);
  assert.doesNotMatch(el('ed-saida-autor').innerHTML,/Usuário Mooca/,'resposta atrasada não reintroduz autor de outra unidade');
  console.log('OK: autores por unidade, Admin vinculado, empresa, inativo, revogação e histórico.');
}
module.exports={testar};
if(require.main===module) (async()=>{
  await testar();
  const fs=require('node:fs'),vm=require('node:vm'),m={exports:{}};
  const fonte=fs.readFileSync(__dirname+'/autoresSaida.js','utf8').replace("(u.permissions?.unidades || []).includes(unidade)",'true');
  vm.runInNewContext(fonte,{module:m});
  await assert.rejects(()=>testar(m.exports),{code:'ERR_ASSERTION'});
  console.log('OK: sabotagem sem filtro de unidade foi detectada.');
})().catch(e=>{console.error(e);process.exitCode=1;});

// Teste isolado: sem Firestore real, sem gravar dados de produção.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const salvos = new Map();
const colecoes = new Map();
const db = {
  collection(nome) {
    if (!colecoes.has(nome)) colecoes.set(nome, {
      doc(id = 'teste') { return { id, set: async r => salvos.set(nome + '/' + id, r), get: async () => ({exists:salvos.has(nome+'/'+id), data:()=>salvos.get(nome+'/'+id)}) }; },
      where() { return this; }, get: async () => ({docs:[],empty:true}),
    });
    return colecoes.get(nome);
  },
  runTransaction: async f => f({get:async()=>({docs:[]}),set:(ref,r)=>salvos.set('entregasLive/'+ref.id,r)}),
};
const cache = {createCache:f=>({cached:f,invalidar(){}})};
function carregar(nome, deps, sufixo='') {
  let src = fs.readFileSync(path.join(__dirname,nome),'utf8');
  if (process.argv.includes('--sabotagem') && nome === 'entregasLive.js') src = src.replace('itens.reduce((s,c)=>s+c.valor,0)', '0');
  const ctx = {module:{exports:{}},require:n=>deps[n],console};
  vm.runInNewContext(src+sufixo,ctx,{filename:nome});
  return ctx.module.exports;
}
const regras = carregar('entregasRegras.js', {'./firestore':db,'./liveCache':cache});
const drivers = {
  listarTodos:async()=>[{nome:'Luan',tipo:'MOOVERY_FIXO'}],
  pagamentoConfigurado:()=> 'manual', categoriaNome:()=> 'MOOVERY JANTA',
};
const live = carregar('entregasLive.js', {
  './firestore':db,'crypto':require('crypto'),'./storage':{},'./liveCache':cache,
  './entregasRegras':regras,'./entregadoresEntregas':drivers,
}, '\nmodule.exports.derivarTeste=completarDerivados;');
async function testar(){
  const camposManuais=[
    {label:'Retorno',quantidade:true,valor:true,observacaoObrigatoria:true},
    {label:'Extra',quantidade:false,valor:true,observacaoObrigatoria:true},
  ];
  const regra=await regras.salvar('CG',{modo:'fixo',empresas:[{nome:'MOOVERY JANTA',modo:'manual',camposManuais}]},'master');
  assert.equal(regra.empresas[0].camposManuais[0].campo,'retorno');
  const args={unidade:'CG',data:'2026-10-02',entregador:'MOOVERY JANTA',tipoRecebedor:'empresa',campos:{entrega:16,valor:156,garantido:20,itensManuais:[{campo:'retorno',quantidade:2,valor:15,observacao:'Endereço errado'},{campo:'extra',valor:8,observacao:'Distância'}]}};
  const registro=await live.create(args);
  assert.equal(registro.valor,199); // 156 + 20 + 15 + 8; nunca 2 × 15
  assert.equal(registro.quantTotal,16);
  assert.equal(registro.configCamposManuais.length,2);
  const pessoa=await live.create({...args,entregador:'Luan',tipoRecebedor:'entregador'});
  assert.equal(pessoa.valor,199);
  await assert.rejects(()=>live.create({...args,campos:{...args.campos,itensManuais:[{campo:'retorno',quantidade:1,valor:0}]}}),/observação/);
  await assert.rejects(()=>live.create({...args,campos:{...args.campos,itensManuais:[{campo:'inventado',valor:1}]}}),/não configurado/);
  await assert.rejects(()=>live.create({...args,campos:{...args.campos,itensManuais:[{campo:'retorno',quantidade:1.5}]}}),/Quantidade inválida/);
  await assert.rejects(()=>live.create({...args,campos:{...args.campos,itensManuais:[{campo:'extra',valor:-1}]}}),/valor monetário/);
  const patch={itensManuais:[{campo:'retorno',quantidade:1,valor:5,observacao:'Corrigido'},{campo:'extra',valor:0}]};
  live.derivarTeste(registro,patch);
  assert.equal(patch.valor,181);
  assert.equal(patch.itensManuais[1].valor,0);
  await regras.salvar('CG',{empresas:[{nome:'MOOVERY JANTA',modo:'manual',camposManuais:[],garantidoAtivo:false}]},'master');
  live.derivarTeste(registro,patch); // snapshot antigo independe da regra atual
  assert.equal(patch.valor,181);
  const semAdicionais=await live.create({...args,campos:{entrega:1,valor:10,garantido:50}});
  assert.equal(semAdicionais.garantido,0);
  assert.equal(semAdicionais.valor,10);
  const proibido={garantido:500};live.derivarTeste(semAdicionais,proibido);assert.equal(proibido.garantido,0);assert.equal(proibido.valor,10);
  const legado={valor:100};const mudanca={valor:120};live.derivarTeste(legado,mudanca);assert.equal(mudanca.valor,120);
  await assert.rejects(()=>regras.salvar('CG',{empresas:[{nome:'M',camposManuais:[camposManuais[0],camposManuais[0]]}]},'master'),/repetido/);
  const html=fs.readFileSync(path.join(__dirname,'public/entrega-lancamento.html'),'utf8');
  const render=html.slice(html.indexOf('function camposManuaisHtml('),html.indexOf('function lerCamposManuais('));
  const ctx={num:v=>Number(v)||0,escapeHtml:v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')};
  vm.runInNewContext(render,ctx);
  const saida=ctx.camposManuaisHtml(registro.configCamposManuais,registro.itensManuais);
  assert.match(saida,/Quantidade Retorno/);assert.match(saida,/Valor Retorno/);assert.match(saida,/Valor Extra/);
  assert.doesNotMatch(saida,/Quantidade Extra/);assert.match(saida,/data-obs="1"/);
  assert.doesNotMatch(ctx.camposManuaisHtml([{campo:'x',label:'<script>',valor:true}]),/<script>/);
  assert.match(html,/cadastro\?\.nome,empresa\?\.nome,config/); // trocar pessoa não reaproveita os valores
  console.log('OK: cadastro, empresa, entregador, totais, observações, validações, correção e histórico.');
}
testar().catch(e=>{console.error(e);process.exitCode=1;});

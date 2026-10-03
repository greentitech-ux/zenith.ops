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
  if (process.argv.includes('--sabotagem') && nome === 'entregasLive.js') src = src.replace('itens.reduce((s,c)=>s+(c.somarNoTotal ? c.valor : 0),0)', '0');
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
  assert.equal(regra.modo,'fixo');
  assert.equal(regra.empresaDeliveryAtivo,true); // as duas modalidades convivem
  const args={unidade:'CG',data:'2026-10-02',entregador:'MOOVERY JANTA',tipoRecebedor:'empresa',campos:{entrega:16,valor:156,garantido:20,itensManuais:[{campo:'retorno',quantidade:2,valor:15,observacao:'Endereço errado'},{campo:'extra',valor:8,observacao:'Distância'}]}};
  const registro=await live.create(args);
  assert.equal(registro.valor,199); // 156 + 20 + 15 + 8; nunca 2 × 15
  assert.equal(registro.quantTotal,16);
  assert.equal(registro.configCamposManuais.length,2);
  const pessoa=await live.create({...args,entregador:'Luan',tipoRecebedor:'entregador'});
  assert.equal(pessoa.valor,199);
  await regras.salvar('CG',{modo:'fixo',empresas:[{nome:'MOOVERY JANTA',modo:'manual',camposManuais:[{...camposManuais[0],somarNoTotal:false},camposManuais[1]]}]},'master');
  const informativo=await live.create(args);
  assert.equal(informativo.valor,184);
  assert.equal(informativo.itensManuais[0].valor,15);
  const informativoPatch={itensManuais:[{campo:'retorno',quantidade:2,valor:100,observacao:'Informativo',somarNoTotal:true},{campo:'extra',valor:8,observacao:'Distância'}]};
  live.derivarTeste(informativo,informativoPatch);
  assert.equal(informativoPatch.valor,184); // cliente não pode ligar o check
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
  const regrasHtml=fs.readFileSync(path.join(__dirname,'public/entregas-regras.html'),'utf8');
  assert.match(regrasHtml,/type="checkbox" id="r-empresa-delivery"/);
  assert.match(regrasHtml,/type="checkbox" id="r-cooperativa-fixo"/);
  assert.match(regrasHtml,/data-m="somarNoTotal"/);
  assert.doesNotMatch(regrasHtml,/type="radio" name="modo"/);
  drivers.listarTodos=async()=>[{nome:'Luan',tipo:'MOOVERY_FIXO'},{nome:'Cooperado',tipo:'OUTRO'}];
  drivers.pagamentoConfigurado=e=>e.nome==='Luan'?'manual':'unidade';
  drivers.categoriaNome=e=>e.nome==='Luan'?'MOOVERY JANTA':'ENTREGADOR';
  const mistura={modo:'fixo',empresaDeliveryAtivo:true,camposValor:[{label:'Entrega',base:'entrega',valorPadrao:8}],empresas:[{nome:'MOOVERY JANTA',modo:'manual'}]};
  await regras.salvar('CG',mistura,'master');
  const cooperado=await live.create({...args,entregador:'Cooperado',tipoRecebedor:'entregador',campos:{entrega:5,valor:999}});
  assert.equal(cooperado.valor,40); // tabela da cooperativa e empresa manual na mesma unidade
  assert.equal((await live.create({...args,campos:{entrega:5,valor:50,garantido:3}})).valor,53);
  await regras.salvar('CG',{...mistura,empresaDeliveryAtivo:false},'master');
  await assert.rejects(()=>live.create(args),/Delivery está desativada/);
  await assert.rejects(()=>live.create({...args,entregador:'Luan',tipoRecebedor:'entregador'}),/Delivery está desativada/);
  assert.equal((await regras.getPara('CG')).empresas.length,1); // desmarcar preserva cadastro
  await assert.rejects(()=>regras.salvar('CG',{modo:'plataforma',empresaDeliveryAtivo:false},'master'),/Selecione/);
  console.log('OK: cadastro, empresa, entregador, totais, observações, validações, correção e histórico.');
}
testar().catch(e=>{console.error(e);process.exitCode=1;});

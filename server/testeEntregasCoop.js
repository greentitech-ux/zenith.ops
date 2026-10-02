const assert=require('assert/strict');const fs=require('fs');const path=require('path');const Module=require('module');
const docs=new Map();let id=0;
function ref(n,k){return {id:k,get:async()=>({id:k,exists:docs.has(n+'/'+k),data:()=>structuredClone(docs.get(n+'/'+k))}),set:async v=>docs.set(n+'/'+k,structuredClone(v)),update:async v=>docs.set(n+'/'+k,{...docs.get(n+'/'+k),...structuredClone(v)})};}
const db={collection:n=>{const q={doc:k=>ref(n,k||String(++id)),where:()=>q,orderBy:()=>q,get:async()=>({empty:true,docs:[]})};return q;},runTransaction:fn=>fn({get:r=>r.get(),set:(r,v)=>r.set(v),update:(r,v)=>r.update(v)})};
function carregar(nome,mocks={},sabotar=false){
  const arquivo=path.join(__dirname,nome+'.js'),m=new Module(arquivo,module);m.filename=arquivo;m.paths=module.paths;
  m.require=k=>k==='./firestore'?db:k in mocks?mocks[k]:require(k);
  let fonte=fs.readFileSync(arquivo,'utf8');
  if(sabotar)fonte=fonte.replace('calcularCoop(regra,registro.entrega)','calcularCoop(regra,registro.entrega+registro.extra+registro.retorno)');
  m._compile(fonte,arquivo);return m.exports;
}
async function teste(sabotar=false){
  docs.clear();const regras=carregar('entregasRegras');
  const entregadores={listarTodos:async()=>[],encontrarAtivo:async()=>({nome:'Pedro Silva'})};
  const live=carregar('entregasLive',{'./entregasRegras':regras,'./storage':{},'./entregadoresEntregas':entregadores},sabotar);
  const salvar=(unidade,valor,ativo=true,modo='plataforma',outros={})=>regras.salvar(unidade,{modo,regraCoop:{ativo,valorEntrega:valor},...outros},'master');
  const criar=(unidade,campos={},outros={})=>live.create({unidade,data:'2026-10-02',entregador:'Pedro Silva',campos:{entrega:13,extra:4,retorno:3,pos00hs:6,foraDeArea:2,valor:100,coopRecebe:999,quantTotal:999,...campos},...outros});
  await salvar('Garanhuns',1,true,'fixo',{entregadoresFixos:['Pedro Silva'],camposValor:[{label:'Entrega',base:'entrega',valorPadrao:8},{label:'Pos 00h',base:'pos00hs',valorPadrao:.5},{label:'Fora de área',base:'foraDeArea',valorPadrao:2},{label:'Coop inválida',base:'extra',destino:'coopRecebe',valorPadrao:999}]});
  const a=await criar('Garanhuns');assert.equal(a.coopRecebe,13);assert.equal(a.quantTotal,20);assert.equal(a.valor,111,'O repasse não soma nem desconta do pagamento');
  await salvar('Outra',1.5);assert.equal((await criar('Outra')).coopRecebe,19.5);
  await salvar('Desativada',2,false);assert.equal((await criar('Desativada')).coopRecebe,0);
  assert.equal((await criar('Sem regra')).coopRecebe,0);
  assert.equal((await criar('Outra',{entrega:0,extra:99,retorno:99})).coopRecebe,0);
  await assert.rejects(salvar('Inválida',0),/maior que zero/);
  await salvar('Empresa',1,true,'plataforma',{empresas:[{nome:'Falcão',modo:'fixo',valorEntrega:7.5}]});
  const emp=await criar('Empresa',{entrega:10},{entregador:'Falcão',tipoRecebedor:'empresa'});assert.equal(emp.coopRecebe,10);assert.equal(emp.quantTotal,10);assert.equal(emp.valor,75);
  await salvar('Total',1,true,'plataforma',{modeloLancamento:'total'});const total=await criar('Total');assert.equal(total.coopRecebe,13);assert.equal(total.quantTotal,13);
  await salvar('Garanhuns',2);const antes=structuredClone(docs.get('entregasLive/'+a.id));assert.equal(antes.coopRecebe,13,'Trocar tarifa não altera o histórico');
  const editado=await live.editarDireto({entregaId:a.id,mudancas:{entrega:14,extra:2,coopRecebe:999,quantTotal:999},editadoPorEmail:'master'});
  assert.equal(editado.coopRecebe,14,'Correção usa a tarifa original');assert.equal(editado.quantTotal,19);
  const km=carregar('entregasKm',{'./entregasRegras':regras,'./entregadoresEntregas':entregadores});
  await salvar('KM',.75,true,'plataforma',{regraKm:{ativo:true,faixas:regras.FAIXAS_KM.map(f=>({id:f.id,valor:8}))}});
  const turno=await km.darEntrada({unidade:'KM',data:'2026-10-01',entregador:'Pedro Silva',horaEntrada:'18:00'});
  await km.darSaida({id:turno.id,horaSaida:'00:30',quantidades:{ate49:5,ate59:2}});
  const regKm=docs.get('entregasLive/km-'+turno.id);assert.equal(regKm.coopRecebe,5.25);assert.equal(regKm.quantTotal,7);assert.equal(regKm.data,'2026-10-01');
  const html=fs.readFileSync(path.join(__dirname,'public/entrega-lancamento.html'),'utf8');
  assert(!html.includes('Sugestão (entregas + extra)'));
  assert(/id="f-quantTotal"[^>]*readonly/.test(html));
  const elementos=new Map(['entrega','extra','retorno','quantTotal'].map(c=>['f-'+c,{value:{entrega:'13',extra:'4',retorno:'3',quantTotal:'999'}[c]}]));
  const fn=html.match(/function atualizarSugestao\(\)\{[\s\S]*?\n\}/)[0];
  new Function('document','num',fn+';atualizarSugestao()')({getElementById:k=>elementos.get(k)},Number);
  assert.equal(elementos.get('f-quantTotal').value,20);
  const obter=k=>{if(!elementos.has(k))elementos.set(k,{value:'',selectedOptions:[],classList:{toggle(_classe,ocultar){this.oculto=ocultar}}});return elementos.get(k)};
  let regraTela={modo:'plataforma',regraCoop:{ativo:true,valorEntrega:1.5}};
  const preview=html.match(/function atualizarPreviewCalculado\(\)\{[\s\S]*?\n\}/)[0];
  const rodar=new Function('regraAtual','atualizarSugestao','ehModeloTotal','document','num','fmtMoney','empresaSelecionada',preview+';atualizarPreviewCalculado()');
  const conferir=()=>rodar(()=>regraTela,()=>{},()=>false,{getElementById:obter},Number,v=>Number(v).toFixed(2),()=>null);
  conferir();assert.equal(obter('preview-coop-linha').classList.oculto,false);assert.equal(obter('preview-coopRecebe').textContent,'19.50');
  regraTela.regraCoop.ativo=false;conferir();assert.equal(obter('preview-coop-linha').classList.oculto,true);assert.equal(obter('f-coopRecebe').value,'0.00');
}
(async()=>{await teste();console.log('✓ COOP só por entrega: ativo/inativo, tarifas por unidade, fixo/manual/empresa/total/KM, histórico, correção e quantidade total automática');let falhou=false;try{await teste(true)}catch(e){falhou=true}assert(falhou,'Sabotagem deve falhar');console.log('✓ Sabotagem detectada: incluir Extra/Retorno no COOP reprova o teste');})().catch(e=>{console.error(e);process.exitCode=1});

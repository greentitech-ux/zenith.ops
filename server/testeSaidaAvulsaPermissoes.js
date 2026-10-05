'use strict';
const assert = require('assert/strict'), fs = require('fs'), vm = require('vm');
const regra = require('./saidaAvulsaEdicao');
const fonte = fs.readFileSync(__dirname + '/index.js', 'utf8');
const fechamentoFonte = fs.readFileSync(__dirname + '/fechamentosLive.js', 'utf8');
async function testar(sabotagem = false) {
  const docs = new Map();
  const f = (id,u,data) => ({id,unidade:u,data,gerente:'Leisly',totalSaida:50,detalhesSaidas:[{descricao:'uber',valor:30},{descricao:'gelo',valor:20}],historico:[]});
  docs.set('A__2026-10-04',f('A__2026-10-04','A','2026-10-04'));
  docs.set('B__2026-10-05',{...f('B__2026-10-05','B','2026-10-05'),detalhesSaidas:[],totalSaida:0});
  const COLLECTION={doc:id=>({path:id})};
  const snap = id => ({exists:docs.has(id),data:()=>structuredClone(docs.get(id))});
  const db={runTransaction:async fn=>{
    const writes=[];
    const result=await fn({get:async r=>{assert.equal(writes.length,0,'leituras antes de escritas');return snap(r.path);},update:(r,p)=>writes.push([r.path,p])});
    writes.forEach(([id,p])=>docs.set(id,{...docs.get(id),...structuredClone(p)}));return result;
  }};
  const contexto={require:()=>regra,COLLECTION,db,getOne:async id=>snap(id).data(),docId:(u,d)=>u+'__'+d,defsExtrasDaUnidade:async()=>[],
    recomputarTotais:(m)=>{m.faturamento=100;m.totalDeclarado=100-m.totalSaida;m.diferenca=-m.totalSaida;},fechamentosCache:{invalidar(){}}};
  vm.createContext(contexto);
  vm.runInContext(fechamentoFonte.slice(fechamentoFonte.indexOf('async function editarSaidaPainel('),fechamentoFonte.indexOf('module.exports =')),contexto);
  const handlers={};let criado;
  const auth={requireMasterOrAdmin:()=>{},podeVerUnidade:(req,u)=>req.isMaster||req.permitidas.includes(u)};
  const routeCtx={app:{patch:(url,...h)=>handlers.patch=h.at(-1),post:(url,...h)=>handlers.post=h.at(-1)},auth,
    require:n=>n==='./autoresSaida'?{resolver:async(id,u)=>{assert.equal(id,'andre-id');assert.ok(['A','B'].includes(u));return {criadoPorId:id,criadoPorNome:'André',criadoPorEmail:'andre@teste'};}}:regra,fechamentosData:[],broadcast(){},fechamentosLive:{getOne:contexto.getOne,editarSaidaPainel:contexto.editarSaidaPainel,
    adicionarSaidaDireto:async dados=>{criado=dados;return dados;}},saidasPainel:{},construirUnidadesMapa:async()=>({A:'Loja A',B:'Loja B'}),redes:{redeDaUnidade:()=> 'BRAVO'}};
  vm.createContext(routeCtx);
  let trecho=fonte.slice(fonte.indexOf("app.patch('/api/fechamentos/:id/saidas/:indice'"),fonte.indexOf('// mesmas colunas do painel'));
  if(sabotagem) trecho=trecho.replace("['criadoPorNome', 'criadoPorId', 'criadoPorEmail'].some(k => req.body[k] !== undefined) && !req.isMaster",'false');
  vm.runInContext(trecho,routeCtx);
  const req=(body,master=false,permitidas=['A','B'])=>({body,isMaster:master,permitidas,user:{id:'andre-id',email:'andre@teste',nome:'André'},params:{id:'A__2026-10-04',indice:'0'}});
  const chamar=async (handler,r)=>{const res={codigo:200,status(n){this.codigo=n;return this;},json(d){this.dados=d;return this;}};await handler(r,res);return res;};
  assert.equal((await chamar(handlers.patch,req({criadoPorId:'andre-id'}))).codigo,403,'Admin não pode falsificar autoria');
  assert.equal((await chamar(handlers.patch,req({criadoPorNome:'Livre'},true))).codigo,400,'nome livre recusado até para Master');
  assert.equal((await chamar(handlers.patch,req({unidade:'C'}))).codigo,403,'destino não permitido');
  assert.equal((await chamar(handlers.patch,req({valor:40},false,['B']))).codigo,403,'origem não permitida');
  assert.equal((await chamar(handlers.patch,req({data:'2026-02-30'}))).codigo,400);
  assert.equal((await chamar(handlers.patch,req({data:'2026-10-06'}))).codigo,400,'destino sem fechamento');
  assert.equal(docs.get('A__2026-10-04').totalSaida,50,'falha sem escrita parcial');
  assert.equal((await chamar(handlers.patch,req({valor:35}))).codigo,200);
  assert.equal(docs.get('A__2026-10-04').totalSaida,55);
  assert.equal(docs.get('A__2026-10-04').detalhesSaidas[0].criadoPorNome,undefined,'edição de valor não troca autor legado');
  assert.equal((await chamar(handlers.patch,req({criadoPorId:'andre-id'},true))).codigo,200);
  assert.equal(docs.get('A__2026-10-04').detalhesSaidas[0].criadoPorNome,'André');
  assert.equal((await chamar(handlers.patch,req({unidade:'B',data:'2026-10-05',valor:32}))).codigo,200);
  assert.equal(docs.get('A__2026-10-04').totalSaida,20);
  assert.equal(docs.get('A__2026-10-04').detalhesSaidas[1].descricao,'gelo','índice do irmão preservado');
  assert.equal(docs.get('B__2026-10-05').totalSaida,32);
  assert.equal(docs.get('B__2026-10-05').detalhesSaidas[0].criadoPorNome,'André');
  const r=req({excluir:true});r.params.id='B__2026-10-05';
  assert.equal((await chamar(handlers.patch,r)).codigo,200);
  assert.equal(docs.get('B__2026-10-05').totalSaida,0);
  assert.equal(docs.get('B__2026-10-05').detalhesSaidas[0].excluida,true);
  assert.ok(docs.get('B__2026-10-05').historico.length>=2);
  await chamar(handlers.post,req({unidade:'A',data:'2026-10-04',descricao:'taxi',valor:10,criadoPorNome:'FALSO'}));
  assert.equal(criado.editadoPorNome,'André');assert.equal(criado.editadoPorEmail,'andre@teste');
  // Executa a leitura real do painel: autor antigo fica, novo usa autor do item.
  const painelFonte=fs.readFileSync(__dirname+'/saidasPainel.js','utf8'),leitura={};vm.createContext(leitura);
  vm.runInContext(painelFonte.slice(painelFonte.indexOf('function linhasDeFechamento('),painelFonte.indexOf('// O MESMO fechamento')),leitura);
  const legado=f('legado','A','2026-10-04');
  assert.equal(leitura.linhasDeFechamento(legado,{})[0].criadoPorNome,'Leisly');
  legado.detalhesSaidas.push({descricao:'taxi',valor:10,criadoPorNome:'André',criadoPorEmail:'andre@teste'});
  assert.equal(leitura.linhasDeFechamento(legado,{})[2].criadoPorNome,'André');
  assert.equal(leitura.linhasDeFechamento(docs.get('B__2026-10-05'),{}).length,0);
  assert.match(fechamentoFonte,/criadoPorNome: editadoPorNome \|\| editadoPorEmail/);
  const html=fs.readFileSync(__dirname+'/public/saidas.html','utf8');
  for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(m[1]);
}
async function testarHttp({DOCS,enviarJson,postarJson,pedir}) {
  const headers={},hash=require('bcryptjs').hashSync('SenhaTeste!2026',4);
  for(const perfil of ['loja','admin','master']) {
    const email='saida-permissao-'+perfil+'@teste.local';
    DOCS.set('users/saida-permissao-'+perfil,{email,username:'saida-permissao-'+perfil,nome:'André',passwordHash:hash,active:true,role:perfil==='master'?'master':'user',isAdmin:perfil==='admin',permissions:{sections:['lancamento','sangria'],unidades:['Saida A','Saida B']}});
    const login=await postarJson('/api/auth/login',{identifier:email,password:'SenhaTeste!2026'});
    assert.equal(login.status,200,login.corpo);headers[perfil]={Authorization:'Bearer '+JSON.parse(login.corpo).token};
  }
  const seed=(id,u,data)=>DOCS.set('fechamentosLive/'+id,{id,unidade:u,unidadeNome:u,grupo:'BRAVO',data,gerente:'Leisly',totalSaida:30,detalhesSaidas:[{descricao:'uber',valor:30}],historico:[]});
  require('./users').invalidar();
  let autores=await pedir('/api/saidas-painel/autores?unidade=Saida%20A',headers.master);
  assert.equal(autores.status,200,autores.corpo);
  const elegiveis=JSON.parse(autores.corpo);
  assert.ok(elegiveis.some(u=>u.id==='saida-permissao-admin'));
  assert.ok(elegiveis.some(u=>u.id==='saida-permissao-loja'));
  assert.ok(!elegiveis.some(u=>u.id==='saida-permissao-master'));
  assert.equal((await pedir('/api/saidas-painel/autores?unidade=Saida%20A',headers.admin)).status,403);
  seed('Saida_A__2026-10-04','Saida A','2026-10-04');seed('Saida_B__2026-10-05','Saida B','2026-10-05');
  require('./fechamentosLive').invalidarCache();
  const rota='/api/fechamentos/Saida_A__2026-10-04/saidas/0';
  assert.equal((await enviarJson('PATCH',rota,{valor:40},headers.loja)).status,403);
  assert.equal((await enviarJson('PATCH',rota,{criadoPorNome:'Outro'},headers.admin)).status,403);
  assert.equal((await enviarJson('PATCH',rota,{unidade:'Outra'},headers.admin)).status,403);
  let r=await enviarJson('PATCH',rota,{valor:35},headers.admin);assert.equal(r.status,200,r.corpo);
  assert.equal(DOCS.get('fechamentosLive/Saida_A__2026-10-04').gerente,'Leisly');
  r=await enviarJson('PATCH',rota,{criadoPorNome:'André'},headers.master);assert.equal(r.status,400,r.corpo);
  r=await enviarJson('PATCH',rota,{criadoPorId:'id-inexistente'},headers.master);assert.equal(r.status,400,r.corpo);
  r=await enviarJson('PATCH',rota,{criadoPorId:'saida-permissao-admin'},headers.master);assert.equal(r.status,200,r.corpo);
  r=await enviarJson('PATCH',rota,{unidade:'Saida B',data:'2026-10-05'},headers.admin);assert.equal(r.status,200,r.corpo);
  assert.equal(DOCS.get('fechamentosLive/Saida_A__2026-10-04').totalSaida,0);
  assert.equal(DOCS.get('fechamentosLive/Saida_B__2026-10-05').totalSaida,65);
  r=await enviarJson('PATCH','/api/fechamentos/Saida_B__2026-10-05/saidas/1',{excluir:true},headers.admin);assert.equal(r.status,200,r.corpo);
  assert.equal(DOCS.get('fechamentosLive/Saida_B__2026-10-05').totalSaida,30);
  r=await postarJson('/api/fechamentos/saidas',{unidade:'Saida A',data:'2026-10-04',descricao:'taxi',valor:12,criadoPorNome:'Falso'},headers.admin);assert.equal(r.status,200,r.corpo);
  assert.equal(DOCS.get('fechamentosLive/Saida_A__2026-10-04').detalhesSaidas.at(-1).criadoPorNome,'André');
  await require('./testeAutoresSaida').testar();
  await testar();await assert.rejects(()=>testar(true),/Admin não pode falsificar autoria/);
  console.log('✓ Saídas avulsas HTTP autenticado: Master/Admin, autoria exclusiva do Master, usuário real, origem/destino, transação, exclusão com histórico e sabotagem.');
}
module.exports={testarHttp};
if(require.main===module) (async()=>{await testar();await assert.rejects(()=>testar(true),/Admin não pode falsificar autoria/);console.log('OK: rotas reais, Admin/Master, origem/destino, valor, data, exclusão, autoria, histórico, transação e sabotagem.');})().catch(e=>{console.error(e);process.exitCode=1;});

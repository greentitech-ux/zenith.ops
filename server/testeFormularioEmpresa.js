'use strict';
const assert=require('node:assert/strict');
async function testar({DOCS,fakeDb,port}){
  const fm=require('./formularios'),fu=require('./formulariosUnidades'),jwt=require('jsonwebtoken');
  await fu.criar({unidade:'Empresa Origem',razaoSocial:'Razão Origem',cnpj:'11.222.333/0001-81'},'teste');
  await fu.criar({unidade:'Empresa Destino',razaoSocial:'Razão Destino',cnpj:'50.625.368/0001-13'},'teste');
  const master=(await require('./users').list()).find(u=>u.role==='master');
  DOCS.set('users/operador-empresa',{id:'operador-empresa',role:'user',active:true,permissions:{sections:['formularios'],unidades:[]}});
  const h=id=>({Authorization:'Bearer '+jwt.sign({sub:id,role:id===master.id?'master':'user'},process.env.JWT_SECRET),'Content-Type':'application/json'});
  const base={tipo:'avulso',unidade:'Empresa Origem',rascunho:true,campos:{favorecido:'Pessoa Teste'},linhas:[{data:'12/10/2026',descricao:'Serviço',valor:180}],anexos:[{nome:'comprovante.pdf',path:'teste/doc',tipo:'application/pdf'}]};
  const f=await fm.criar(base),dados={campos:f.campos,linhas:f.linhas,unidade:'Empresa Destino',motivoEmpresa:'Lançamento na empresa errada'};
  const put=async(id,body,user=master.id)=>{const r=await fetch(`http://127.0.0.1:${port}/api/formularios/${id}`,{method:'PUT',headers:h(user),body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  assert.equal((await put(f.id,dados,'operador-empresa')).status,403);
  assert.equal((await put(f.id,{...dados,motivoEmpresa:''})).status,400);
  assert.equal((await put(f.id,{...dados,unidade:'inexistente'})).status,400);
  const resp=await put(f.id,dados);assert.equal(resp.status,200,JSON.stringify(resp.body));
  const novo=await fm.getOne(f.id);assert.equal(novo.unidade,'Empresa Destino');assert.equal(novo.razaoSocial,'Razão Destino');assert.equal(novo.campos.cnpj,'50.625.368/0001-13');
  assert.equal(novo.numeroTicket,f.numeroTicket);assert.equal(novo.status,'RASCUNHO');assert.equal(novo.valorTotal,180);assert.deepEqual(novo.anexos,f.anexos);assert.equal(novo.campos.favorecido,'Pessoa Teste');
  assert.equal(novo.historicoEmpresas.length,1);assert.equal(novo.historicoEmpresas[0].antes.unidade,'Empresa Origem');assert.equal(novo.historicoEmpresas[0].porEmail,master.email);
  assert.equal((await put(f.id,{...dados,campos:novo.campos})).body.semMudanca,true);assert.equal((await fm.getOne(f.id)).historicoEmpresas.length,1);
  const signed=await fm.criar({...base,rascunho:false});const s=DOCS.get('formularios/'+signed.id),token=s.assinaturas.favorecido.token;
  for(const a of Object.values(s.assinaturas)){a.assinadoEm=new Date().toISOString();a.nome='Teste';a.imagem='data:image/png;base64,AAAA';}s.status='ASSINADO';s.tokenPreenchimento='link-antigo';
  const corrigido=await put(signed.id,{...dados,campos:s.campos,linhas:s.linhas});assert.equal(corrigido.status,200);assert(corrigido.body.assinaturasDescartadas>0);
  const atual=await fm.getOne(signed.id);assert.equal(atual.status,'PENDENTE');assert.equal(atual.tokenPreenchimento,null);assert.notEqual(atual.assinaturas.favorecido.token,token);
  await assert.rejects(fm.assinar(signed.id,token,{nome:'Teste',imagem:'data:image/png;base64,AAAA'}),/inválido|revogado/);
  for(const campo of ['enviadoConecta','enviadoPagamento']){const b=await fm.criar(base);DOCS.get('formularios/'+b.id)[campo]={em:new Date().toISOString()};assert.equal((await put(b.id,dados)).status,400);assert.equal((await fm.getOne(b.id)).unidade,'Empresa Origem');}
  const ligado=await fm.criar({...base,origem:{tipo:'solicitacao',id:'origem-empresa',numero:12345}});
  DOCS.set('solicitacoes/origem-empresa',{id:'origem-empresa',unidade:'Empresa Origem'});
  assert.equal((await put(ligado.id,dados)).status,400,'origem de outra empresa bloqueada');
  DOCS.get('solicitacoes/origem-empresa').unidade='Empresa Destino';assert.equal((await put(ligado.id,dados)).status,200,'origem corrigida permite corrigir documento');
  const concorrente=await fm.criar(base),tx=fakeDb.runTransaction;
  try{fakeDb.runTransaction=fn=>{DOCS.set('formularios/'+concorrente.id,{...DOCS.get('formularios/'+concorrente.id),enviadoConecta:{protocolo:'envio-concorrente'}});return tx(fn);};assert.equal((await put(concorrente.id,dados)).status,400);}finally{fakeDb.runTransaction=tx;}
  assert.equal((await fm.getOne(concorrente.id)).unidade,'Empresa Origem');
  console.log('✓ Troca de empresa HTTP: Master, motivo, cadastro fiscal, histórico, valores/anexos/protocolo preservados, assinaturas revogadas, origem e envio concorrente protegidos.');
}
module.exports={testar};
if(require.main===module){
  process.env.JWT_SECRET='teste-empresa';process.env.ENCRYPTION_KEY='11'.repeat(32);
  const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),Module=require('node:module');
  if(process.argv.includes('--sabotagem')){const orig=Module._extensions['.js'];Module._extensions['.js']=(m,file)=>{if(file!==path.join(__dirname,'formularios.js'))return orig(m,file);const src=fs.readFileSync(file,'utf8');assert(src.includes('Object.assign(patch, { unidade: cadastro.unidade,'));m._compile(src.replace('Object.assign(patch, { unidade: cadastro.unidade,','Object.assign(patch, { unidade: r.unidade,'),file);};}
  const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>{const file=path.join(__dirname,'testeRotas.js'),src=fs.readFileSync(file,'utf8').split('setTimeout(async () => {')[0].replace(/\b8899\b/g,String(port));const m=new Module(file,module);m.filename=file;m.paths=module.paths;m._compile(src+`\nsetTimeout(()=>require('./testeFormularioEmpresa').testar({DOCS,fakeDb,port:${port}}).then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)}),2500);`,file);});});
}

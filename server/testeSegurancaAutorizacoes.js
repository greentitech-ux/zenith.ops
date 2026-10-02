// Teste isolado: dois processos simulados compartilham o banco persistente.
const assert=require('assert/strict');
const fs=require('fs');const path=require('path');const Module=require('module');
const docs=new Map();let sequencia=0;let fila=Promise.resolve();
const copia=x=>structuredClone(x);
const db={collection:n=>({doc:(id=String(++sequencia))=>({id,
  get:async()=>({id,exists:docs.has(n+'/'+id),data:()=>copia(docs.get(n+'/'+id))}),
  set:async x=>docs.set(n+'/'+id,copia(x)),
  update:async x=>docs.set(n+'/'+id,{...docs.get(n+'/'+id),...copia(x)})
})}),runTransaction:fn=>{
  const p=fila.then(()=>fn({get:r=>r.get(),update:(r,x)=>r.update(x)}));
  fila=p.catch(()=>{});return p;
}};
function carregar(nome,sabotagem=false){
  const arquivo=path.join(__dirname,nome+'.js');const mod=new Module(arquivo,module);
  mod.filename=arquivo;mod.paths=module.paths;
  mod.require=id=>id==='./firestore'?db:id==='./users'?{list:async()=>[],findByIdentifier:async()=>null}:id==='./tarefas'?{}:id==='./auth'?{emptyPermissions:()=>({sections:[],unidades:[],vaultSubgroups:[],tiposSolicitacao:[]}),invalidarUsuario:()=>{}}:id==='bcryptjs'||id==='./sessions'?{}:require(id);
  let fonte=fs.readFileSync(arquivo,'utf8');
  if(sabotagem)fonte=fonte.replace('a.execucaoId ||','false ||').replace("!['pendente','erro'].includes(a.status)",'false');
  mod._compile(fonte,arquivo);return mod.exports;
}
async function testar(sabotagem=false){
  const a=carregar('qaAprovacoes',sabotagem),b=carregar('qaAprovacoes',sabotagem),pk=carregar('passkeys');
  const criar=()=>a.criar({tipo:'teste',resumo:'Ação',payload:{alvo:'u'},criadoPorEmail:'agente'});
  const p=await criar(),rev=a.revisao(p);
  const resultados=await Promise.allSettled([a.reservarExecucao(p.id,rev,'master'),b.reservarExecucao(p.id,rev,'master')]);
  assert.equal(resultados.filter(r=>r.status==='fulfilled').length,1,'A ação não pode ser reservada duas vezes');
  const reserva=resultados.find(r=>r.status==='fulfilled').value;
  await assert.rejects(carregar('qaAprovacoes').reservarExecucao(p.id,rev,'master'),'Reiniciar não libera a execução');
  await assert.rejects(a.marcarDecidido(p.id,{status:'rejeitado'}));
  await assert.rejects(a.marcarDecidido(p.id,{status:'aprovado',execucaoId:'outro'}));
  await a.marcarDecidido(p.id,{status:'aprovado',execucaoId:reserva.execucaoId,decididoPorEmail:'master'});
  await assert.rejects(a.reservarExecucao(p.id,rev,'master'));
  assert.deepEqual((await a.obter(p.id)).historico.map(e=>e.evento),['PEDIDO_CRIADO','EXECUCAO_INICIADA','AUTORIZADO_E_EXECUTADO']);
  const alterada=await criar(),antiga=a.revisao(alterada);
  docs.get('qaAprovacoes/'+alterada.id).payload.alvo='outro';
  await assert.rejects(a.reservarExecucao(alterada.id,antiga,'master'),/dados mudaram/);
  await assert.rejects(a.marcarDecidido(alterada.id,{status:'rejeitado',revisaoEsperada:antiga}),/dados mudaram/);
  const vencida=await criar();docs.get('qaAprovacoes/'+vencida.id).expiraEm='2020-01-01';
  await assert.rejects(a.reservarExecucao(vencida.id,a.revisao(await a.obter(vencida.id)),'master'),/vencido/);
  const token=pk.emitirConfirmacao('master',{id:p.id,revisao:rev});
  assert.equal(pk.confirmacaoValida(token,'master'),false,'Confirmação específica não autoriza outra rota');
  assert.equal(pk.consumirConfirmacaoAutorizacao(token,'outro',p.id,rev),false);
  assert.equal(pk.consumirConfirmacaoAutorizacao(token,'master','outro',rev),false);
  assert.equal(pk.consumirConfirmacaoAutorizacao(token,'master',p.id,'outra'),false);
  assert.equal(pk.consumirConfirmacaoAutorizacao(token,'master',p.id,rev),true);
  assert.equal(pk.consumirConfirmacaoAutorizacao(token,'master',p.id,rev),false,'Uso único');
  const generico=pk.emitirConfirmacao('master');
  assert.equal(pk.confirmacaoValida(generico,'master'),true,'Outras confirmações continuam funcionando');
  assert.equal(pk.consumirConfirmacaoAutorizacao(generico,'master',p.id,rev),false);
  const users=carregar('users');
  const antes={permissions:{sections:['tarefas'],unidades:['Loja A'],vaultSubgroups:[],tiposSolicitacao:[]},cargos:[]};
  docs.set('users/alvo',{email:'alvo@teste',role:'user',...copia(antes)});
  const depois={...copia(antes),cargos:['operador']};
  await users.aplicarPermissoesAutorizadas('alvo',antes,depois,['cargos']);
  assert.deepEqual(docs.get('users/alvo').cargos,['operador']);
  await assert.rejects(users.aplicarPermissoesAutorizadas('alvo',antes,depois,['cargos']),/acesso mudou/);
  assert.deepEqual(docs.get('users/alvo').permissions,antes.permissions,'Alterar cargo não apaga seções');
  docs.get('users/alvo').permissions.unidades.push('Loja B');
  await assert.rejects(users.aplicarPermissoesAutorizadas('alvo',depois,{...depois,permissions:antes.permissions},['unidades']),/acesso mudou/);
  const html=fs.readFileSync(path.join(__dirname,'public/autorizacoes.html'),'utf8');
  const fn=html.match(/function coluna\(a\)\{[\s\S]*?\n\}/)[0];
  const coluna=new Function('FEITOS','vencido',fn+';return coluna')(new Map(),()=>false);
  assert.equal(coluna({status:'executando'}),'executando','Execução em curso nunca aparece como recusada');
}
(async()=>{
  await testar();console.log('✓ Autorização: reserva persistente, concorrência, revisão, auditoria e digital específica de uso único');
  docs.clear();sequencia=0;
  let detectou=false;try{await testar(true)}catch(e){detectou=true;}
  assert(detectou,'Sabotagem precisa reprovar');console.log('✓ Sabotagem detectada: remover a trava permite duplicação e reprova o teste');
})().catch(e=>{console.error(e);process.exitCode=1});

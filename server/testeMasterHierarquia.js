const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const dados = new Map();
const snapshot = (id, data) => ({id,exists:!!data,data:()=>data});
function referencia(nome,id){return {id,caminho:nome+'/'+id,get:async()=>snapshot(id,dados.get(nome+'/'+id)),set:async v=>dados.set(nome+'/'+id,v),delete:async()=>dados.delete(nome+'/'+id)};}
const db = {
  collection(nome){ return {
    doc:id=>referencia(nome,id),
    where(c,op,v){return {get:async()=>({docs:[...dados].filter(([k,d])=>k.startsWith(nome+'/') && d[c]===v).map(([k,d])=>snapshot(k.split('/')[1],d))})};},
  };},
  runTransaction:async fn=>{
    const ops=[];
    const resultado=await fn({get:r=>r.get(),set:(r,v)=>ops.push(()=>dados.set(r.caminho,v)),delete:r=>ops.push(()=>dados.delete(r.caminho))});
    ops.forEach(f=>f());return resultado;
  },
};
function carregar(nome,deps,env={MASTER_EMAIL:'original@teste.local'}){
  let src=fs.readFileSync(path.join(__dirname,nome),'utf8');
  if(process.argv.includes('--sabotagem') && nome==='masterHierarquia.js') src=src.replace('usuario.id === id','true');
  const c={require:n=>deps[n],module:{exports:{}},process:{env},console};vm.runInNewContext(src,c);return c.module.exports;
}
async function testar(){
  const original={id:'original',email:'original@teste.local',role:'master'};
  const inferior={id:'inferior',email:'outro@teste.local',role:'master',qaMaster:true};
  dados.set('users/original',original);dados.set('users/inferior',inferior);
  const h=carregar('masterHierarquia.js',{'./firestore':db});
  assert.equal(await h.ehPrincipal(original),true);
  assert.equal(await h.ehPrincipal({...inferior,qaMaster:false,isMasterPrincipal:true}),false);
  assert.equal(await h.ehPrincipal({...original,qaMaster:true}),false);
  await assert.rejects(()=>h.exigirGerenciaMaster(original,inferior),/principal/);
  dados.set('users/original',{...original,email:'novo@teste.local'});
  const reiniciado=carregar('masterHierarquia.js',{'./firestore':db},{MASTER_EMAIL:'outro@teste.local'});
  assert.equal(await reiniciado.resolverId(),'original'); // persistente, não muda com o env
  const semDonoDb={collection:()=>({doc:()=>({get:async()=>({exists:false})})})};
  assert.equal(await carregar('masterHierarquia.js',{'./firestore':semDonoDb},{}).ehPrincipal(inferior),false);
  let sessoes=0,passkeys=0;
  const users=carregar('users.js',{
    bcryptjs:{},crypto:require('crypto'),'./firestore':db,
    './auth':{emptyPermissions:()=>({}),invalidarUsuario(){}},
    './liveCache':{createCache:f=>({cached:f,invalidar(){}})},
    './sessions':{encerrarTodasDoUsuario:async()=>sessoes++},
    './masterHierarquia':h,'./passkeys':{removerTodasDoUsuario:async()=>passkeys++},
  });
  await assert.rejects(()=>users.remove('original',original),/não pode ser excluído/);
  await assert.rejects(()=>users.remove('inferior',{id:'outro',role:'master'}),/principal/);
  assert.ok(dados.has('users/original'));assert.ok(dados.has('users/inferior'));
  await users.remove('inferior',original);
  assert.equal(dados.has('users/inferior'),false);
  assert.equal(dados.get('usuariosExcluidos/inferior').excluidoPorId,'original');
  assert.equal(sessoes,1);assert.equal(passkeys,1);
  const html=fs.readFileSync(path.join(__dirname,'public/usuarios.html'),'utf8');
  assert.match(html,/u\.isMasterPrincipal\?'':`<button/);
  const server=fs.readFileSync(path.join(__dirname,'index.js'),'utf8');
  assert.match(server,/exigirGerenciaMaster\(alvo, req\.user\)/);
  assert.match(server,/users\.remove\(req\.params\.id, req\.user\)/);
  console.log('OK: identidade persistente, bloqueio de escalada, exclusão subordinada, auditoria, sessões e proteção da conta principal.');
}
testar().catch(e=>{console.error(e);process.exitCode=1;});

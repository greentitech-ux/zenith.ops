'use strict';
const assert=require('assert/strict');
const {avisarEntrada}=require('./avisosLogin');
function testar() {
  const mensagens=[[],[],[],[],[]];
  const clientes=mensagens.map((m,i)=>({userId:['principal','secundario','qa','comum','principal'][i],isMasterPrincipal:i===0||i===4,isMaster:i<3,res:{destroyed:i===4,write:p=>m.push(p)}}));
  assert.equal(avisarEntrada(clientes,{id:'comum',username:'Junius'},{metodo:'senha',computador:{codigo:'PATTEO',posto:'PC1'},nomeUnidade:'Saltiverso Patteo'}),1);
  assert.match(mensagens[0][0],/usuario-entrou/);assert.match(mensagens[0][0],/Saltiverso Patteo/);
  assert.equal(mensagens.slice(1).flat().length,0,'Não entregar para outro Master, QA, usuário ou conexão encerrada');
  assert.equal(avisarEntrada(clientes,{id:'principal'},{metodo:'senha'}),0,'Não avisar o próprio login');
  assert.equal(avisarEntrada(clientes,{id:'comum'},{metodo:'refresh'}),0);
  assert.equal(avisarEntrada(clientes,{id:'comum'},{metodo:'biometria'}),1);
  // Sabotagem: elevar o Master secundário precisa reprovar a expectativa.
  clientes[1].isMasterPrincipal=true;
  assert.throws(()=>assert.equal(avisarEntrada(clientes,{id:'comum'},{metodo:'senha'}),1));
  console.log('✓ Aviso de entrada: somente Master principal, senha/biometria, sem refresh, sem histórico e sabotagem detectada.');
}
async function testarHttp({DOCS,token,pedir,postarJson,http}) {
  const jwt=require('jsonwebtoken');
  const me=await pedir('/api/me',{Authorization:'Bearer '+token});
  assert.equal(JSON.parse(me.corpo).isMasterPrincipal,true);
  const comum='aviso-login-usuario',secundario='aviso-login-master';
  DOCS.set('users/'+comum,{username:comum,role:'user',active:true,cargo:'tecnico',somenteNoc:false,passwordHash:require('bcryptjs').hashSync('SenhaAviso!2026',4),permissions:{sections:[],unidades:[]}});
  DOCS.set('users/'+secundario,{username:secundario,role:'master',active:true});
  const tk=id=>jwt.sign({sub:id,role:id===secundario?'master':'user'},process.env.JWT_SECRET,{expiresIn:'5m'});
  const conexoes=[];
  async function abrir(t) {
    return new Promise((resolve,reject)=>{
      const c={texto:'',req:null};conexoes.push(c);
      c.req=http.request({host:'127.0.0.1',port:8899,path:'/api/stream?token='+encodeURIComponent(t)},res=>{
        if(res.statusCode!==200){res.resume();reject(Error('Stream negado: '+res.statusCode));return;}
        res.on('data',d=>{c.texto+=d;if(c.texto.includes('event: hello'))resolve(c);});
      });c.req.on('error',reject);c.req.setTimeout(8000,()=>c.req.destroy(Error('Timeout do SSE')));c.req.end();
    });
  }
  try {
    const principal=await abrir(token),outro=await abrir(tk(secundario)),usuario=await abrir(tk(comum));
    const corpo={identifier:comum,password:'SenhaAviso!2026'};
    const sucesso=await postarJson('/api/auth/login',corpo);assert.equal(sucesso.status,200);
    await new Promise(r=>setTimeout(r,80));
    assert.equal((principal.texto.match(/event: usuario-entrou/g)||[]).length,1);
    assert.equal(outro.texto.includes('usuario-entrou'),false);assert.equal(usuario.texto.includes('usuario-entrou'),false);
    await pedir('/api/me',{Authorization:'Bearer '+JSON.parse(sucesso.corpo).token});
    assert.equal((await postarJson('/api/auth/login',{...corpo,password:'Errada'})).status,401);
    await new Promise(r=>setTimeout(r,80));
    assert.equal((principal.texto.match(/event: usuario-entrou/g)||[]).length,1,'Falha ou navegação não gera aviso');
    console.log('✓ Aviso por HTTP/SSE real: login avisa só o principal; outro Master e funcionário não recebem; falha e /api/me não avisam.');
  } finally {conexoes.forEach(c=>c.req?.destroy());}
}
if(require.main===module)testar();
module.exports={testar,testarHttp};

'use strict';
const assert=require('assert/strict');
const crypto=require('crypto');
const {criarServico,COOKIE}=require('./nocLogin');
async function testar() {
  let aparelho={agentToken:'segredo-android',agenteAndroidVersao:3};
  const s=criarServico({segredo:'teste-jwt-android',lerComputador:async()=>aparelho});
  const req={ip:'203.0.113.1',headers:{'user-agent':'Chrome Android'}};
  const origem='https://www.nopulso.com.br';
  const desafio=s.desafio(req);
  const assinatura=crypto.createHmac('sha256',aparelho.agentToken).update('noc-local\n'+origem+'\n'+desafio).digest('hex');
  const prova={desafio,codigo:'19855',posto:'TABLET',assinatura};
  await assert.rejects(()=>s.automatico({...prova,assinatura:'0'.repeat(64)},req,origem));
  await assert.rejects(()=>s.automatico(prova,{...req,ip:'203.0.113.2'},origem));
  const cookie=await s.automatico(prova,req,origem);
  assert.equal((await s.validarPedido({...req,headers:{...req.headers,cookie:COOKIE+'='+cookie}})).codigo,'19855');
  await assert.rejects(()=>s.automatico(prova,req,origem));
  aparelho.agentToken='rotacionado';
  assert.equal(await s.validarPedido({...req,headers:{...req.headers,cookie:COOKIE+'='+cookie}}),null);
  aparelho={agentToken:'segredo-android',agenteAndroidVersao:2};
  await assert.rejects(()=>s.emitir('19855','TABLET',aparelho.agentToken,req));
  aparelho={agentToken:'segredo-android',agenteAndroidVersao:3,windowsAntigo:true};
  await assert.rejects(()=>s.emitir('19855','TABLET',aparelho.agentToken,req));
  assert.throws(()=>assert.equal(aparelho.windowsAntigo,false),'Sabotagem de cadastro detectada');
  console.log('✓ Login Android: v3 autenticada, assinatura, IP, replay, rotação de segredo, v2 e Windows antigo bloqueados.');
}
async function testarHttp({DOCS,postarJson,pedir,http}) {
  const ls=require('./lojaStatus');
  const c=await ls.cadastrarComputador('19855','Tablet login Android','atendimento');
  const segredo=await ls.garantirAgentToken(c.codigo,c.posto);
  const bater=token=>postarJson('/api/loja-status/heartbeat',{unidade:c.codigo,posto:c.posto,agenteAndroidVersao:3,userAgent:'NoPulsoAgente/3 (Linux; Android 14)',abertoDesde:Date.now(),token});
  await bater('errado');
  assert.equal((await ls.computadorParaLoginNoc(c.codigo,c.posto)).agenteAndroidVersao,undefined);
  await bater(segredo);
  assert.equal((await ls.computadorParaLoginNoc(c.codigo,c.posto)).agenteAndroidVersao,3);
  const usuario='android-login-teste';
  DOCS.set('users/'+usuario,{username:usuario,passwordHash:require('bcryptjs').hashSync('SenhaAndroid!2026',4),role:'user',active:true,cargo:'operador',somenteNoc:true,permissions:{sections:[],unidades:['19855']}});
  // HTTP direto: não usar o wrapper que sintetiza prova NOC para os outros testes.
  async function enviar(url,dados,cookie) {
    return new Promise((resolve,reject)=>{
      const corpo=JSON.stringify(dados);const headers={'Content-Type':'application/json','Content-Length':Buffer.byteLength(corpo),'User-Agent':'Chrome Android teste'};
      if(cookie) headers.Cookie=cookie;
      const r=http.request({host:'127.0.0.1',port:8899,path:url,method:'POST',headers},res=>{let b='';res.on('data',d=>b+=d);res.on('end',()=>resolve({status:res.statusCode,dados:JSON.parse(b),headers:res.headers}));});r.on('error',reject);r.end(corpo);
    });
  }
  const login={identifier:usuario,password:'SenhaAndroid!2026'};
  assert.equal((await enviar('/api/auth/login',login)).status,403);
  const desafio=(await enviar('/api/noc-login/desafio',{})).dados.desafio;
  const origem=new URL(process.env.APP_BASE_URL || 'https://www.nopulso.com.br').origin;
  const assinatura=crypto.createHmac('sha256',segredo).update('noc-local\n'+origem+'\n'+desafio).digest('hex');
  const validado=await enviar('/api/noc-login/automatico',{desafio,codigo:c.codigo,posto:c.posto,assinatura});
  assert.equal(validado.status,200);
  const cookie=validado.headers['set-cookie'][0].split(';')[0];
  assert.equal((await enviar('/api/auth/login',login,cookie)).status,200);
  DOCS.get('users/'+usuario).permissions.unidades=['OUTRA'];require('./auth').invalidarUsuario(usuario);
  const fora=await enviar('/api/auth/login',login,cookie);
  assert.equal(fora.status,403);assert.equal(fora.dados.code,'UNIDADE_NOC_NAO_AUTORIZADA');
  console.log('✓ Android HTTP real: heartbeat falso não habilita; token habilita; navegador validado entra só na unidade permitida.');
}
module.exports={testar,testarHttp};
if(require.main===module) testar().catch(e=>{console.error(e);process.exitCode=1;});

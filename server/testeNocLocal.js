'use strict';
const assert=require('assert/strict');
const {spawn}=require('child_process');
const net=require('net');
const crypto=require('crypto');
const {SCRIPT}=require('./nocLocalScript');
const {criarServico,COOKIE,unidadePermitida}=require('./nocLogin');
(async()=>{
  assert.ok(process.env.HYPERV_TEST_PWSH,'Defina HYPERV_TEST_PWSH');
  const reserva=net.createServer();await new Promise(r=>reserva.listen(0,'127.0.0.1',r));
  const porta=reserva.address().port;await new Promise(r=>reserva.close(r));
  const origem='https://www.nopulso.com.br',segredo='apenas-teste-local';
  const fonte=`& {\n${SCRIPT}\n} '${origem}' 'SALTIVERSO_PATTEO' 'CAIXA1' '${segredo}' ${porta}`;
  const processo=spawn(process.env.HYPERV_TEST_PWSH,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(fonte,'utf16le').toString('base64')],{stdio:['ignore','pipe','pipe']});
  let erros='';processo.stderr.on('data',d=>erros+=d);
  try {
    const req={ip:'203.0.113.1',headers:{'user-agent':'teste-real'}};
    const servico=criarServico({segredo:'jwt-teste-local',lerComputador:async(c,p)=>c==='SALTIVERSO_PATTEO'&&p==='CAIXA1'?{agentToken:segredo,agenteVersao:141}:null});
    const desafio=servico.desafio(req);
    const url=`http://127.0.0.1:${porta}/validar`;
    let r;
    for(let i=0;i<40;i++) {
      try {r=await fetch(url,{method:'POST',headers:{Origin:origem,'Content-Type':'application/json'},body:JSON.stringify({desafio}),signal:AbortSignal.timeout(4000)});break;}
      catch(e){if(processo.exitCode!==null)throw Error(erros);await new Promise(ok=>setTimeout(ok,100));}
    }
    assert.ok(r,erros);assert.equal(r.status,200,erros);
    const prova=await r.json();
    assert.equal(r.headers.get('access-control-allow-origin'),origem);
    assert.ok(!JSON.stringify(prova).includes(segredo),'Não expõe segredo do agente');
    const esperado=crypto.createHmac('sha256',segredo).update('noc-local\n'+origem+'\n'+desafio).digest('hex');
    assert.equal(prova.assinatura,esperado);
    await assert.rejects(()=>servico.automatico({...prova,desafio,assinatura:'0'.repeat(64)},req,origem));
    await assert.rejects(()=>servico.automatico({...prova,desafio}, {...req,ip:'203.0.113.2'},origem));
    await assert.rejects(()=>servico.automatico({...prova,desafio}, {...req,headers:{'user-agent':'outro'}},origem));
    const cookie=await servico.automatico({...prova,desafio},req,origem);
    assert.equal((await servico.validarPedido({...req,headers:{...req.headers,cookie:COOKIE+'='+cookie}})).codigo,'SALTIVERSO_PATTEO');
    await assert.rejects(()=>servico.automatico({...prova,desafio},req,origem),'Replay negado');
    const pre=await fetch(url,{method:'OPTIONS',headers:{Origin:origem,'Access-Control-Request-Method':'POST'}});assert.equal(pre.status,204);
    const negado=await fetch(url,{method:'POST',headers:{Origin:'https://malicioso.example','Content-Type':'application/json'},body:JSON.stringify({desafio})});assert.equal(negado.status,403);assert.equal(negado.headers.get('access-control-allow-origin'),null);
    assert.equal(await unidadePermitida({permissions:{unidades:['SALTIVERSO_PATTEO']}},'SALTIVERSO_PATTEO'),true);
    assert.equal(await unidadePermitida({isAdmin:true,permissions:{unidades:['OUTRA']}},'SALTIVERSO_PATTEO'),false);
    assert.equal(await unidadePermitida({permissions:{unidades:[]}},'SALTIVERSO_PATTEO'),false);
    const {montarScriptVigia}=require('./vigiaScript');
    const {spawnSync}=require('child_process');
    for(const windowsAntigo of [false,true]) {
      const ps=montarScriptVigia({codigo:'TESTE',posto:'PC',tipo:'interno',agentToken:'abc123',windowsAntigo});
      const verificar='$texto=[Console]::In.ReadToEnd();$t=$null;$e=$null;[Management.Automation.Language.Parser]::ParseInput($texto,[ref]$t,[ref]$e)|Out-Null;if($e.Count){throw ($e|Out-String)}';
      const parser=spawnSync(process.env.HYPERV_TEST_PWSH,['-NoProfile','-NonInteractive','-Command',verificar],{input:ps,encoding:'utf8',timeout:15000});
      assert.equal(parser.status,0,parser.stderr);
    }
    // Sabotagem: abrir CORS para terceiros deve reprovar a mesma expectativa.
    assert.throws(()=>assert.equal(200,negado.status));
    console.log('✓ Agente PowerShell real: loopback, CORS fechado, HMAC, segredo oculto, prova única vinculada ao navegador/IP e unidade autorizada.');
  } finally {processo.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});

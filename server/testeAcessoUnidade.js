'use strict';
// Teste isolado dos serviços reais. --sabotagem retira o consumo único:
// deve reprovar. --navegador também testa tela, atividade e retorno no Edge.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const sabotagem=process.argv.includes('--sabotagem');
async function testarServico() {
  let fonte=fs.readFileSync(path.join(__dirname,'acessoUnidade.js'),'utf8');
  if(sabotagem) fonte=fonte.replace('vinculos.delete(chave); // consumo único','// consumo único');
  const mod=new Module(path.join(__dirname,'acessoUnidade.js'),module);mod.filename=path.join(__dirname,'acessoUnidade.js');mod.paths=module.paths;mod._compile(fonte,mod.filename);
  let maquina={agentToken:'a'.repeat(64),acessoChatUnidade:true,chatUnidadeVersao:1,nome:'PC Tirol'};
  const svc=mod.exports.criarServico({lerComputador:async(c,p)=>c==='TIROL'&&p==='PC'?maquina:null,nomeUnidade:()=>"Dominos Tirol",segredo:'teste-local'});
  await assert.rejects(svc.emitirVinculo('TIROL','PC','errado'));
  await assert.rejects(svc.emitirVinculo('OUTRA','PC','a'.repeat(64)));
  const grant=await svc.emitirVinculo('TIROL','PC','a'.repeat(64));
  const jwt=await svc.consumirVinculo(grant);
  assert(!grant.includes(maquina.agentToken));
  await assert.rejects(svc.consumirVinculo(grant),'Vínculo precisa ser de uso único');
  const req={headers:{cookie:'nopulsoUnidade='+jwt}};
  assert.equal((await svc.contextoDoPedido(req)).codigo,'TIROL');
  assert.equal(await svc.contextoDoPedido({headers:{cookie:'nopulsoUnidade='+jwt+'alterado'}}),null);
  maquina.acessoChatUnidade=false;assert.equal(await svc.contextoDoPedido(req),null);
  maquina.acessoChatUnidade=true;maquina.chatUnidadeVersao++;assert.equal(await svc.contextoDoPedido(req),null);
  const pendente=await svc.emitirVinculo('TIROL','PC',maquina.agentToken);
  maquina.agentToken='b'.repeat(64);await assert.rejects(svc.consumirVinculo(pendente));
  console.log('✓ Vínculo autenticado, uso único, cookie inviolável, tag e segredo revogam acesso');

  // Firestore mínimo sem rede; todas as regras e caches são os de produção.
  const docs=new Map(),doc=id=>({id,get:async()=>({exists:docs.has(id),data:()=>structuredClone(docs.get(id))}),set:async r=>docs.set(id,structuredClone(r)),update:async r=>docs.set(id,{...docs.get(id),...r}),delete:async()=>docs.delete(id)});
  require.cache[require.resolve('./firestore')]={exports:{collection:()=>({doc,where:()=>({get:async()=>({docs:[]})}),get:async()=>({docs:[]})})}};
  const sessoes=require('./sessions');
  const nativo=Date.now;let agora=nativo();Date.now=()=>agora;
  try {
    const pessoal=await sessoes.criar({userId:'u',terminalUnidade:{inatividadeMinutos:5}}),normal=await sessoes.criar({userId:'n'});
    agora+=240000;sessoes.tocar(pessoal.id);await Promise.resolve();assert(await sessoes.existeEValida(pessoal.id));
    agora+=60001;assert.equal(await sessoes.existeEValida(pessoal.id),false,'Polling não pode adiar saída');assert(await sessoes.existeEValida(normal.id));
    assert.equal(await sessoes.atividadeHumana(pessoal.id),false,'Sessão vencida não ressuscita');
    const ativa=await sessoes.criar({userId:'a',terminalUnidade:{inatividadeMinutos:5}});
    agora+=240000;assert(await sessoes.atividadeHumana(ativa.id));agora+=240000;assert(await sessoes.existeEValida(ativa.id));
    await sessoes.encerrar(ativa.id);assert.equal(await sessoes.existeEValida(ativa.id),false);
  } finally {Date.now=nativo;}
  console.log('✓ Inatividade humana vence, polling não renova, atividade renova, logout revoga, sessão comum preservada');
  const vigia=require('./vigiaScript'),{spawnSync}=require('node:child_process');
  for(const antigo of [false,true]) {
    const script=vigia.montarScriptVigia({codigo:"TIROL teste' $x",posto:'PC',tipo:'interno',agentToken:'a'.repeat(64),acessoChatUnidade:true,windowsAntigo:antigo});
    const codificado=/FromBase64String\("([A-Za-z0-9+/=]+)"\)/.exec(script);
    assert(codificado,'Launcher deve ser entregue ao agente');
    const launcher=Buffer.from(codificado[1],'base64').toString('utf8');
    assert(launcher.includes('/api/acesso-unidade/vinculo') && !/--app=.*X-NOC-Token/.test(launcher));
    for(const fonte of [script,launcher]) {
      const comando="[Console]::InputEncoding=[Text.Encoding]::UTF8; $texto=[Console]::In.ReadToEnd(); $e=$null; [System.Management.Automation.Language.Parser]::ParseInput($texto,[ref]$null,[ref]$e)|Out-Null; if($e){$e|ForEach-Object{$_.Message};exit 1}";
      const parse=spawnSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(comando,'utf16le').toString('base64')],{input:fonte,encoding:'utf8',windowsHide:true});
      if(parse.error) throw parse.error;
      assert.equal(parse.status,0,'PowerShell inválido: '+parse.stdout+parse.stderr);
    }
  }
  console.log('✓ Agente e launcher fazem parse no PowerShell, inclusive versão Windows antigo');
}
async function testarNavegador() {
  const {chromium}=require('playwright'),browser=await chromium.launch({headless:true,channel:'msedge'});
  const contexto=await browser.newContext(),pagina=await contexto.newPage(),u={codigo:'TIROL',nome:'Dominos Tirol',posto:'PC',nomeComputador:'PC Tirol',inatividadeMinutos:5};
  let saidas=0,atividades=0;
  await contexto.route('http://teste.local/**',async rota=>{
    const url=new URL(rota.request().url());
    if(url.pathname==='/api/acesso-unidade/sessao') return rota.fulfill({json:u});
    if(url.pathname==='/api/acesso-unidade/registrar') return rota.fulfill({json:{ok:true}});
    if(url.pathname==='/api/auth/sair'){saidas++;return rota.fulfill({json:{ok:true}});}
    if(url.pathname==='/api/auth/atividade'){atividades++;return rota.fulfill({json:{ok:true}});}
    if(url.pathname.startsWith('/api/')) return rota.fulfill({json:{}});
    const arquivo=url.pathname==='/unidade'?'/unidade.html':url.pathname==='/pessoal'?'/teste-pessoal':url.pathname;
    if(arquivo==='/teste-pessoal') return rota.fulfill({contentType:'text/html',body:'<html><head><script src="/tema.js"></script></head><body><h1>Pessoal</h1><input id="campo"></body></html>'});
    const arq=path.join(__dirname,'public',arquivo);
    if(fs.existsSync(arq)&&fs.statSync(arq).isFile()) return rota.fulfill({contentType:arquivo.endsWith('.js')?'application/javascript':'text/html',body:fs.readFileSync(arq)});
    return rota.fulfill({body:''});
  });
  try {
    await pagina.goto('http://teste.local/unidade#vinculo=descartavel');await pagina.waitForFunction(()=>!!window.__zenithUnidadeChat);
    assert.equal(await pagina.locator('#nome').innerText(),'Dominos Tirol');assert.equal(new URL(pagina.url()).hash,'');
    await pagina.locator('#szc-nome').waitFor();assert((await pagina.locator('#szc-nome').inputValue()).includes('Colaborador'));
    assert.equal(await pagina.evaluate(()=>localStorage.getItem('authToken')),null);
    const t='e30.'+Buffer.from(JSON.stringify({sub:'gerente',sid:'sid-pessoal'})).toString('base64url')+'.teste';
    await pagina.evaluate(t=>{localStorage.setItem('authToken',t);window.NoPulsoUnidade.login(t);},t);
    await pagina.clock.install();await pagina.goto('http://teste.local/pessoal');await pagina.locator('#campo').waitFor();
    await pagina.waitForFunction(()=>!!window.NoPulsoUnidade);
    await pagina.locator('#campo').click();await pagina.locator('#campo').pressSequentially('atividade');
    await pagina.waitForFunction(()=>true);assert(atividades>0);
    await pagina.clock.fastForward(4*60000);assert.equal(new URL(pagina.url()).pathname,'/pessoal');
    await pagina.locator('#campo').pressSequentially(' nova atividade');
    await pagina.clock.fastForward(4*60000);assert.equal(new URL(pagina.url()).pathname,'/pessoal','Atividade real deve adiar a saída');
    await pagina.reload();await pagina.clock.fastForward(61000);await pagina.waitForURL('**/unidade');
    assert.equal(await pagina.evaluate(()=>localStorage.getItem('authToken')),null);assert(saidas>0);
    // O token e o relógio também são conferidos antes de abrir outra página.
    await pagina.evaluate(t=>{localStorage.setItem('authToken',t);localStorage.setItem('nopulso.unidade.atividade',JSON.stringify({sid:'sid-pessoal',em:Date.now()-6*60000}));},t);
    await pagina.goto('http://teste.local/pessoal').catch(e=>{if(!e.message.includes('ERR_ABORTED')) throw e;});await pagina.waitForURL('**/unidade');
    await pagina.screenshot({path:path.join(__dirname,'../docs/varredura/chat-unidade-desktop.png'),fullPage:true});
    await pagina.setViewportSize({width:390,height:844});
    await pagina.screenshot({path:path.join(__dirname,'../docs/varredura/chat-unidade-celular.png'),fullPage:true});
    assert(await pagina.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Chat não pode estourar a tela do celular');
    console.log('✓ Edge: unidade reconhecida, chat sem senha, login separado, atividade real, reload não renova, retorno após inatividade');
  } finally {await browser.close();}
}
(async()=>{await testarServico();if(process.argv.includes('--navegador')) await testarNavegador();})().catch(e=>{console.error('✗ '+e.stack);process.exitCode=1;});

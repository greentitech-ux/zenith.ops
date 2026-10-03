// Tela real, APIs e VM falsas. Nenhum comando sai para um host real.
const http=require('http'),fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {chromium}=require('playwright');
const raiz=path.join(__dirname,'public');let qa=false;const pedidos=[];
const host={codigo:'CG',posto:'host',nome:'HOST TESTE',tipo:'interno',ultimoHeartbeatEm:Date.now(),agentToken:'teste',
  vms:[{nome:'PULSEBOS19940',estado:'Executando'},{nome:'VM DESLIGADA',estado:'Desligada'}],vmsEm:Date.now(),eventos:[]};
const srv=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://local');
  const json=o=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(o))};
  if(u.pathname.startsWith('/api/')){
    if(u.pathname.endsWith('/vms/acao')){let corpo='';req.on('data',b=>corpo+=b);req.on('end',()=>{pedidos.push(JSON.parse(corpo));json({ok:true,comandoId:'fake',mensagem:'Pedido na fila; estado não confirmado.'})});return;}
    if(u.pathname==='/api/me')return json({id:'teste',role:'master',qaMaster:qa,ehTimeSuporte:true,permissions:{sections:[],unidades:['CG']}});
    if(u.pathname==='/api/meta/unidades-publico')return json([{codigo:'CG',nome:'Campina Grande'}]);
    if(u.pathname==='/api/loja-status')return json([host]);
    if(u.pathname.endsWith('/detalhe'))return json(host);
    if(u.pathname==='/api/stream'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end();return;}
    return json(/\/(config|contexto|resumo|status)$/.test(u.pathname)?{}:[]);
  }
  let arquivo=path.resolve(raiz,'.'+u.pathname);if(!path.extname(arquivo))arquivo+='.html';
  if(!arquivo.startsWith(raiz+path.sep)||!fs.existsSync(arquivo)||fs.statSync(arquivo).isDirectory()){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':arquivo.endsWith('.html')?'text/html':arquivo.endsWith('.js')?'text/javascript':'application/octet-stream'});res.end(fs.readFileSync(arquivo));
});
(async()=>{
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({headless:true,channel:'chrome'});
  try{
    for(const width of [1366,390]){
      const ctx=await browser.newContext({viewport:{width,height:950}});
      await ctx.addInitScript(()=>localStorage.setItem('authToken','fake'));
      const page=await ctx.newPage(),erros=[];page.on('pageerror',e=>erros.push(e.message));
      await page.goto('http://127.0.0.1:'+srv.address().port+'/loja-status.html');
      await page.waitForFunction(()=>typeof COMPUTADORES!=='undefined'&&COMPUTADORES.length===1);
      await page.evaluate(()=>abrirDetalheComputador('CG','host'));
      await page.waitForSelector('[data-vm="PULSEBOS19940"]');
      assert.equal(await page.locator('[data-vm]').count(),6);
      assert.equal(await page.locator('[data-vm="PULSEBOS19940"][data-acao="ligar"]').isEnabled(),false);
      assert.equal(await page.locator('[data-vm="VM DESLIGADA"][data-acao="ligar"]').isEnabled(),true);
      const geometric=await page.locator('[data-vm]').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth}));
      assert.ok(geometric.every(Boolean),'Botões não podem escapar da tela');
      fs.mkdirSync(path.join(__dirname,'../docs/varredura'),{recursive:true});
      await page.screenshot({path:path.join(__dirname,'../docs/varredura/hyperv-'+width+'.png')});
      page.on('dialog',d=>d.accept());
      await page.locator('[data-vm="PULSEBOS19940"][data-acao="reiniciar"]').click();
      await page.locator('#senha-input').fill('senha-de-teste');
      await page.locator('#senha-ok').click();
      await page.waitForFunction(()=>document.querySelector('#senha-overlay').classList.contains('hidden'));
      // Aguarda somente a requisição local de teste, nunca Hyper-V.
      await page.waitForFunction(()=>document.querySelector('[data-vm="PULSEBOS19940"][data-acao="reiniciar"]').disabled===false);
      assert.deepEqual(pedidos.at(-1),{nome:'PULSEBOS19940',acao:'reiniciar',password:'senha-de-teste'});
      await page.evaluate(()=>{IS_MASTER_VM=false;atualizarDetalheSeAberto()});
      assert.equal(await page.locator('[data-vm]').count(),0,'Não mostrar controles sem permissão');
      assert.deepEqual(erros,[]);
      await ctx.close();
    }
    console.log('Hyper-V visual: desktop/celular, estados, senha, envio simulado e permissão aprovados.');
  }finally{await browser.close();srv.close();}
})().catch(e=>{console.error(e);srv.close();process.exitCode=1});

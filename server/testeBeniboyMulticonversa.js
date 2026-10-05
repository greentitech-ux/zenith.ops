'use strict';
// Navegador local, sem APIs/banco de produção. Exercita o HTML real da Central.
const fs=require('fs'),path=require('path'),http=require('http'),assert=require('assert/strict'),vm=require('vm');
const {chromium}=require('playwright');
const raiz=path.join(__dirname,'public'),saida=path.join(__dirname,'../docs/varredura/multiconversa');
const original=fs.readFileSync(path.join(raiz,'beniboy.html'),'utf8');
for(const m of original.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(m[1]);
async function testar(sabotar=false){
  const envios=[],dialogs=[],erros=[];
  const itens=['a','b','c','d'].map((id,i)=>({id,nome:['Maria Silva','José Ferreira','Fernanda Lima','André Souza'][i],contato:id+'@teste.local',assunto:'Financeiro/Estorno',lojaContexto:'Loja de teste',numeroTicket:12000+i,statusAtendimento:'EM_ATENDIMENTO',nivel:2,responsavel:{nome:'Suporte',email:'suporte@teste'},atualizadoEm:'2026-10-05T14:00:00Z',digitacaoToken:'somente-teste-'+id,mensagens:[{de:'visitante',texto:'Preciso acompanhar a minha solicitação.',em:'2026-10-05T14:00:00Z'},{de:'suporte',texto:'Estamos acompanhando. Você pode falar por aqui.',em:'2026-10-05T14:01:00Z'}]}));
  let html=original.replace(/<script[^>]*src="(?!\/tema\.js)[^"]+"[^>]*><\/script>/g,'').replace('\nboot();','\n/* boot controlado pelo teste */');
  if(sabotar) html=html.replace("!PAINEIS_VISIVEIS.includes(p.dataset.painelId)","p.dataset.painelId!==CONVERSA_ATIVA");
  const servidor=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/api/suporte-chats') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify(itens));return;}
    if(/\/api\/suporte-chats\/[^/]+\/responder/.test(url.pathname)){
      let corpo='';req.on('data',c=>corpo+=c);req.on('end',()=>{envios.push({url:url.pathname,corpo});res.setHeader('Content-Type','application/json');res.end('{}');});return;
    }
    if(url.pathname.startsWith('/api/')){res.setHeader('Content-Type','application/json');res.end('{}');return;}
    if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}
    const arquivo=path.resolve(raiz,'.'+decodeURIComponent(url.pathname));
    if(!arquivo.startsWith(raiz+path.sep)||!fs.existsSync(arquivo)||!fs.statSync(arquivo).isFile()){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',arquivo.endsWith('.js')?'application/javascript':arquivo.endsWith('.css')?'text/css':arquivo.endsWith('.woff2')?'font/woff2':'application/octet-stream');res.end(fs.readFileSync(arquivo));
  });
  await new Promise(r=>servidor.listen(0,'127.0.0.1',r));
  let browser;
  try{
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    page.on('pageerror',e=>erros.push(e.message));page.on('dialog',d=>{dialogs.push(d.message());d.dismiss();});
    await page.addInitScript(()=>{
      localStorage.setItem('authToken','somente-teste-local');
      window.__digitacao=new Map();
      window.nopulsoDigitando={conectar:c=>window.__digitacao.set(c.chave,c.id),parar:k=>window.__digitacao.delete(k),enviado:k=>{window.__ultimoEnviado=k;}};
    });
    await page.goto('http://127.0.0.1:'+servidor.address().port);
    await page.evaluate(lista=>{ME={email:'suporte@teste',username:'Suporte',role:'master'};IS_MASTER=true;ITENS=lista;document.getElementById('root').classList.remove('hidden');renderKanban();abrirDetalhePorId('a');abrirDetalhePorId('b');abrirDetalhePorId('c');},itens);
    const visiveis=()=>page.locator('.painel-conversa:not(.hidden)');
    assert.equal(await visiveis().count(),1);
    await page.locator('#central-colunas-2').click();assert.equal(await visiveis().count(),2,'duas conversas simultâneas');
    await page.locator('#d-texto-a').fill('Resposta só para Maria');
    await page.locator('#d-texto-c').fill('Resposta só para Fernanda');
    await page.locator('#d-anexo-a').setInputFiles({name:'maria.txt',mimeType:'text/plain',buffer:Buffer.from('anexo Maria')});
    fs.mkdirSync(saida,{recursive:true});
    await page.screenshot({path:path.join(saida,'duas-desktop.png')});
    await page.locator('#central-colunas-3').click();assert.equal(await visiveis().count(),3,'três conversas simultâneas');
    assert.equal(await page.locator('#d-texto-a').inputValue(),'Resposta só para Maria');
    assert.equal(await page.locator('#d-texto-c').inputValue(),'Resposta só para Fernanda');
    assert.equal(await page.evaluate(()=>RASCUNHOS_PAINEL_CHAT.get('a').arquivo.name),'maria.txt');
    const caixas=await visiveis().evaluateAll(es=>es.map(e=>({x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,w:e.getBoundingClientRect().width})));
    assert.equal(caixas[0].y,caixas[1].y);assert.equal(caixas[1].y,caixas[2].y);
    assert.ok(caixas[1].x>=caixas[0].x+caixas[0].w-1 && caixas[2].x>=caixas[1].x+caixas[1].w-1,'lado a lado, sem sobreposição');
    assert.equal(await page.evaluate(()=>__digitacao.size),3,'digitando separado por conversa visível');
    await page.locator('#d-texto-b').fill('Resposta só para José');
    assert.match(await page.locator('#contexto-corpo').innerText(),/José Ferreira/);
    await page.screenshot({path:path.join(saida,'tres-desktop.png')});
    await page.evaluate(()=>enviarResposta('b'));
    assert.equal(envios.length,1);assert.equal(envios[0].url,'/api/suporte-chats/b/responder');assert.equal(JSON.parse(envios[0].corpo).texto,'Resposta só para José');
    assert.equal(await page.locator('#d-texto-a').inputValue(),'Resposta só para Maria');
    assert.equal(await page.locator('#d-texto-c').inputValue(),'Resposta só para Fernanda');
    await page.evaluate(()=>abrirDetalhePorId('d'));assert.equal(await visiveis().count(),3);
    assert.equal(await page.locator('.painel-conversa[data-painel-id="d"]').isVisible(),true);
    await page.locator('#central-colunas-3').click();assert.equal(await visiveis().count(),1);
    assert.equal(await page.evaluate(()=>__digitacao.size),1);
    await page.locator('#central-colunas-3').click();await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:path.join(saida,'tres-celular.png')});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'sem rolagem horizontal na página');
    assert.equal(await page.evaluate(()=>{const e=document.querySelector('.paineis-wrap');return e.scrollWidth>e.clientWidth;}),true,'rolagem lateral só nos painéis');
    assert.equal(await page.evaluate(()=>localStorage.getItem('beniboyColunasCentral')),'3');
    assert.deepEqual(erros,[],'sem erro de JavaScript');assert.deepEqual(dialogs,[]);
  }finally{if(browser)await browser.close();await new Promise(r=>servidor.close(r));}
}
(async()=>{await testar();await assert.rejects(()=>testar(true),/duas conversas simultâneas/);console.log('OK: 2/3 lado a lado, uma conversa, rascunhos/anexos, envio isolado, contexto, digitando, responsividade e sabotagem. Fotos: docs/varredura/multiconversa');})().catch(e=>{console.error(e);process.exitCode=1;});

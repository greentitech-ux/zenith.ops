'use strict';
// HTML real, rede isolada, dados fictícios. Não envia formulários a produção.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
  const raiz=path.join(__dirname,'public');
  try{for(const width of [390,1366]){
    const ctx=await browser.newContext({viewport:{width,height:900},locale:'pt-BR'});
    let enviado=null;
    await ctx.route('**/*',route=>{
      const u=new URL(route.request().url());
      if(u.pathname==='/api/formularios-publico/preencher/teste'){
        if(route.request().method()==='POST'){enviado=route.request().postDataJSON();return route.fulfill({json:{ok:true,id:'teste'}});}
        return route.fulfill({json:{rotulo:'Pagamento avulso',unidade:'Loja Teste',numeroTicket:12511,razaoSocial:'Loja Teste',cnpj:'11.222.333/0001-81',complementoSomente:true,
          cabecalho:[{key:'favorecido',label:'Favorecido'},{key:'banco',label:'Banco'},{key:'chavePix',label:'Chave Pix'}],
          colunas:[{key:'data',label:'Data',data:true},{key:'descricao',label:'Descrição'},{key:'valor',label:'Valor',valor:true}],
          campos:{favorecido:'PAULO ROBERTO'},linhas:[{data:'12/10/2026',descricao:'Reembolso já aprovado',valor:1127.1}],anexosExistentes:[{nome:'Comprovante.pdf'}]}});
      }
      if(u.pathname.startsWith('/api/'))return route.fulfill({json:{}});
      const file=path.resolve(raiz,'.'+u.pathname);
      if(!file.startsWith(raiz+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return route.fulfill({status:404,body:''});
      let body=fs.readFileSync(file);
      if(process.argv.includes('--sabotagem')&&u.pathname==='/preencher.html')body=body.toString().replace('LINHAS = d.linhas?.length ? d.linhas.map(l=>({...l})) : [{}];','LINHAS = [{}];');
      return route.fulfill({body,contentType:file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':'application/octet-stream'});
    });
    const pg=await ctx.newPage(),erros=[];pg.on('pageerror',e=>erros.push(e.message));
    await pg.goto('https://formulario.test/preencher.html?token=teste');
    await pg.locator('#form-area').waitFor({state:'visible'});
    assert.equal(await pg.locator('#cab-favorecido').inputValue(),'PAULO ROBERTO');
    assert(await pg.locator('#cab-favorecido').evaluate(e=>e.readOnly));
    assert.equal(await pg.locator('[data-col="valor"]').inputValue(),'1127.1');
    assert.equal(await pg.locator('[data-col="data"]').inputValue(),'2026-10-12');
    assert.equal(await pg.locator('#total').textContent(),'R$ 1.127,10');
    assert.equal(await pg.locator('#btn-add').isVisible(),false);
    await pg.locator('#cab-banco').fill('BANCO TESTE');await pg.locator('#cab-chavePix').fill('teste@local');
    assert.equal(await pg.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await pg.screenshot({path:path.join(__dirname,`../docs/varredura/formulario-complemento-${width}.png`),fullPage:true});
    await pg.locator('#btn-enviar').click();await pg.locator('#fim').waitFor({state:'visible'});
    assert.equal(enviado.campos.favorecido,'PAULO ROBERTO');assert.equal(enviado.linhas[0].valor,1127.1);assert.equal(enviado.campos.banco,'BANCO TESTE');
    assert.deepEqual(erros,[]);await ctx.close();console.log(`✓ Formulário ${width}px: dados preservados, complemento, envio e sem transbordamento.`);
  }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

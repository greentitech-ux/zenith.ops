'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH}),raiz=path.join(__dirname,'public');
  try{for(const width of [390,1366]){
    const ctx=await browser.newContext({viewport:{width,height:900},locale:'pt-BR'});let enviado;
    const unidades=[{unidade:'Spoleto Shopping Recife',razaoSocial:'Empresa anterior',cnpj:'11.222.333/0001-81'},{unidade:'Empresa correta',razaoSocial:'Razão Social Correta',cnpj:'50.625.368/0001-13'}];
    const modelo={tipo:'avulso',rotulo:'Pagamento avulso',cabecalho:[{key:'favorecido',label:'Favorecido'},{key:'banco',label:'Banco'}],colunas:[{key:'data',label:'Data',data:true},{key:'descricao',label:'Descrição'},{key:'valor',label:'Valor',valor:true}]};
    const form={id:'teste',tipo:'avulso',unidade:unidades[0].unidade,numeroTicket:12517,status:'RASCUNHO',campos:{favorecido:'PESSOA TESTE'},linhas:[{data:'12/10/2026',descricao:'SERVIÇO',valor:180}],valorTotal:180,assinaturas:[],criadoEm:new Date().toISOString()};
    await ctx.addInitScript(()=>localStorage.setItem('authToken','teste'));
    await ctx.route('**/*',route=>{
      const u=new URL(route.request().url());
      if(u.pathname==='/api/me')return route.fulfill({json:{id:'master',role:'master'}});
      if(u.pathname==='/api/formularios/tipos')return route.fulfill({json:[modelo]});
      if(u.pathname==='/api/formularios/unidades')return route.fulfill({json:unidades});
      if(u.pathname==='/api/formularios')return route.fulfill({json:[form]});
      if(u.pathname==='/api/formularios/teste'&&route.request().method()==='PUT'){enviado=route.request().postDataJSON();return route.fulfill({json:{ok:true}});}
      if(u.pathname.startsWith('/api/'))return route.fulfill({json:[]});
      const file=path.resolve(raiz,'.'+u.pathname);
      if(!file.startsWith(raiz+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return route.fulfill({status:404,body:''});
      let body=fs.readFileSync(file);
      if(process.argv.includes('--sabotagem')&&u.pathname==='/formularios.html')body=body.toString().replace('JSON.stringify({ campos, linhas, unidade, motivoEmpresa })','JSON.stringify({ campos, linhas })');
      return route.fulfill({body,contentType:file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':'application/octet-stream'});
    });
    const pg=await ctx.newPage(),erros=[];pg.on('pageerror',e=>erros.push(e.message));pg.on('dialog',d=>d.accept());
    await pg.goto('https://formulario.test/formularios.html');await pg.waitForFunction(()=>SOU_MASTER&&LISTA.length);
    await pg.evaluate(()=>abrirEdicao('teste'));
    await pg.locator('#ed-unidade').selectOption('Empresa correta');
    assert((await pg.locator('#ed-empresa-info').textContent()).includes('50.625.368/0001-13'));
    await pg.locator('#ed-salvar').click();assert.equal(enviado,undefined);assert(await pg.locator('#ed-erro').isVisible());
    await pg.locator('#ed-motivo-empresa').fill('LANÇAMENTO NA EMPRESA ERRADA');
    assert.equal(await pg.locator('#ed-overlay').evaluate(e=>e.scrollWidth>e.clientWidth+1),false);
    await pg.locator('#ed-overlay').screenshot({path:path.join(__dirname,`../docs/varredura/formulario-empresa-${width}.png`)});
    await pg.locator('#ed-salvar').click();await pg.waitForFunction(()=>document.getElementById('ed-overlay').classList.contains('hidden'));
    assert.equal(enviado.unidade,'Empresa correta');assert.equal(enviado.motivoEmpresa,'LANÇAMENTO NA EMPRESA ERRADA');assert.equal(enviado.campos.favorecido,'PESSOA TESTE');assert.equal(enviado.linhas[0].valor,'180,00');
    assert.deepEqual(erros,[]);await ctx.close();console.log(`✓ Empresa ${width}px: seletor fiscal, motivo obrigatório, dados preservados e envio ao servidor.`);
  }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

'use strict';
// Página real e APIs fictícias: nunca acessa dados de produção.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
  const navegador=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
  const raiz=path.join(__dirname,'public'),saida=path.join(__dirname,'../docs/varredura');
  try {for(const [width,tema] of [[1366,'escuro'],[390,'escuro'],[390,'claro']]){
    const ctx=await navegador.newContext({viewport:{width,height:900},locale:'pt-BR'});
    await ctx.addInitScript(tema=>{localStorage.setItem('authToken','teste');localStorage.setItem('zenithTema',tema);},tema);
    await ctx.route('**/*',route=>{
      const u=new URL(route.request().url());
      if(u.pathname==='/api/me')return route.fulfill({json:{id:'master',role:'master',permissions:{sections:[],unidades:['Saltiverso Patteo']}}});
      if(u.pathname.startsWith('/api/'))return route.fulfill({json:[]});
      const alvo=path.resolve(raiz,'.'+u.pathname);
      if(!alvo.startsWith(raiz+path.sep)||!fs.existsSync(alvo)||!fs.statSync(alvo).isFile())return route.fulfill({status:404,body:''});
      let body=fs.readFileSync(alvo);
      if(process.argv.includes('--sabotagem')&&u.pathname==='/moeda-br.js')body=body.toString().replace('useGrouping: true','useGrouping: false');
      return route.fulfill({body,contentType:alvo.endsWith('.html')?'text/html':alvo.endsWith('.js')?'text/javascript':'application/octet-stream'});
    });
    const pg=await ctx.newPage(),erros=[];pg.setDefaultTimeout(10000);pg.on('pageerror',e=>erros.push(e.message));
    await pg.goto('https://moeda.test/parque.html');await pg.waitForFunction(()=>typeof renderFinanceiro==='function');
    const dados=await pg.evaluate(()=>{
      ME={role:'master'};IS_MASTER=true;
      const lista=[[4090,'credito'],[2920,'pix'],[2295,'debito'],[1625,'dinheiro'],[2850,null]].map(([valor,metodoPagamento],i)=>({id:'teste-'+i,valor,metodoPagamento,tempoMinutos:60,criancas:[{nome:'Teste',gratuita:false}],dataUtilizacao:'2026-10-12'}));
      const entrada=document.querySelector('input[type=number]');if(entrada)entrada.value='1000.10';
      renderFinanceiro(lista);
      return {entrada:entrada?.value,esperado:'1000.10',total:lista.reduce((s,c)=>s+c.valor,0),valores:[...document.querySelectorAll('#fin-kpis .val')].map(e=>e.textContent),centavos:fmtReal(1000.1),milhao:fmtReal(1000000.01)};
    });
    assert.deepEqual(dados.valores,['R$ 13.780','R$ 4.090','R$ 2.920','R$ 2.850','R$ 2.295','R$ 1.625']);
    assert.equal(dados.centavos,'R$ 1.000,10');assert.equal(dados.milhao,'R$ 1.000.000,01');assert.equal(dados.total,13780);
    if(dados.entrada!==undefined)assert.equal(dados.entrada,dados.esperado,'input mantém número sem máscara de exibição');
    assert.equal(await pg.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await pg.locator('#painel-financeiro').screenshot({path:path.join(saida,`moeda-parque-${width}-${tema}.png`)});
    assert.deepEqual(erros,[]);await ctx.close();console.log(`✓ Financeiro real ${width}px ${tema}: milhares, centavos, total original e campo de edição preservados.`);
  }}finally{await navegador.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

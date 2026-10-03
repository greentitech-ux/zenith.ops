// Navegador local com APIs falsas: nenhum acesso aos dados de produção.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const raiz=path.join(__dirname,'public'),saida=path.join(__dirname,'../docs/varredura');
const a=require('./public/entregas-analise');
const rows=Array.from({length:40},(_,i)=>({id:'teste'+i,data:a.deslocar('2026-10-03',-i),unidade:'CG',entregador:'Luan da Silva',entrega:10,quantTotal:10,valor:100,valorEntregas:100,garantido:0,itensManuais:[{campo:'retorno',quantidade:1,valor:10},{campo:'extra',quantidade:2,valor:12}]}));
rows.push({...rows[0],id:'anterior',data:'2025-10-02'});
const srv=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://local');
  if(u.pathname.startsWith('/api/')){
    if(u.pathname==='/api/stream'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end();return;}
    const valor=u.pathname==='/api/me'?{id:'teste',role:'master',nome:'Master teste',permissions:{sections:[],unidades:['CG']}}:u.pathname==='/api/entregas'?rows:u.pathname==='/api/meta/unidades'?[{codigo:'CG',nome:'Dom Campina Grande'}]:u.pathname==='/api/entregas/sincronizacao'?{}:[];
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(valor));return;
  }
  const nome=decodeURIComponent(u.pathname==='/'?'/entregas.html':u.pathname),arquivo=path.resolve(raiz,'.'+nome);
  if(!arquivo.startsWith(raiz+path.sep)||!fs.existsSync(arquivo)||fs.statSync(arquivo).isDirectory()){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':arquivo.endsWith('.js')?'text/javascript':arquivo.endsWith('.html')?'text/html':arquivo.endsWith('.css')?'text/css':'application/octet-stream'});res.end(fs.readFileSync(arquivo));
});
(async()=>{
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  const navegador=await chromium.launch({headless:true,...(process.env.ENTREGAS_BROWSER_CHANNEL?{channel:process.env.ENTREGAS_BROWSER_CHANNEL}:{})});
  try{
    fs.mkdirSync(saida,{recursive:true});
    for(const [nome,largura]of [['desktop',1366],['celular',390]]){
      const ctx=await navegador.newContext({viewport:{width:largura,height:950},locale:'pt-BR',timezoneId:'America/Sao_Paulo'});
      await ctx.addInitScript(()=>{localStorage.setItem('authToken','fake');const Original=Date;globalThis.Date=class extends Original{constructor(...args){super(...(args.length?args:['2026-10-03T15:00:00Z']));}static now(){return new Original('2026-10-03T15:00:00Z').getTime();}};});
      const pg=await ctx.newPage(),erros=[];pg.on('pageerror',e=>erros.push(e.message));
      await pg.goto('http://127.0.0.1:'+srv.address().port+'/entregas.html');
      await pg.waitForSelector('#grafico-entregas svg');
      assert.equal(await pg.locator('#kpis .kpi').count(),8);
      assert.equal(await pg.locator('#filtros-grafico [data-filtro=inicio]').inputValue(),'2026-09-04');
      assert.ok((await pg.locator('#ontem-grid').innerText()).includes('TM R$ 10,00'));
      await pg.locator('#filtros-entregadores [data-filtro=inicio]').fill('2025-01-01');
      assert.equal(await pg.locator('#filtros-unidades [data-filtro=inicio]').inputValue(),'2026-10-02');
      await pg.locator('#f-date-start').fill('2026-09-01');
      for(const secao of ['entregadores','unidades','lancamentos','grafico']) assert.equal(await pg.locator('#filtros-'+secao+' [data-filtro=inicio]').inputValue(),'2026-09-01');
      await pg.locator('#filtros-lancamentos [data-filtro=fim]').fill('2026-12-31');
      assert.equal(await pg.locator('#f-date-end').inputValue(),'2026-10-02');
      await pg.locator('#f-nome').fill('Ninguém');assert.equal(await pg.locator('#grafico-entregas svg').count(),0);
      await pg.locator('#f-nome').fill('Luan');
      await pg.locator('#grafico-comparar').selectOption('ano');assert.ok((await pg.locator('#grafico-periodo').innerText()).includes('2025'));
      await pg.locator('#f-dia-semana').selectOption('5');assert.ok(await pg.locator('#grafico-entregas svg').count());
      // Atualização ao vivo não pode resetar os filtros locais.
      await pg.locator('#filtros-entregadores [data-filtro=inicio]').fill('2024-01-01');
      await pg.evaluate(()=>carregar());
      assert.equal(await pg.locator('#filtros-entregadores [data-filtro=inicio]').inputValue(),'2024-01-01');
      const exportUrl=await pg.evaluate(()=>{let url;window.verRelatorio=u=>{url=u;};baixarRelatorioEntregas('entregadores','csv');return url;});
      assert.ok(exportUrl.includes('inicio=2024-01-01'));assert.ok(exportUrl.includes('nome=Luan'));assert.ok(exportUrl.includes('diaSemana=5'));
      await pg.locator('#filtros-entregadores [data-limpar]').click();
      assert.equal(await pg.locator('#filtros-entregadores [data-filtro=inicio]').inputValue(),'2026-10-02');
      assert.equal(await pg.locator('#f-date-start').inputValue(),'2026-09-01');
      assert.equal(await pg.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'rolagem horizontal '+nome);
      assert.deepEqual(erros,[]);
      await pg.evaluate(()=>scrollTo(0,0));
      await pg.screenshot({path:path.join(saida,'entregas-novo-'+nome+'.png'),fullPage:true});
      await ctx.close();
    }
    console.log('OK visual: desktop/celular, gráfico, KPIs, filtros independentes/sincronizados, dias e atualização ao vivo.');
  }finally{await navegador.close();srv.close();}
})().catch(e=>{console.error(e);srv.close();process.exitCode=1;});

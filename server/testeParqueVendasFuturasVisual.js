'use strict';
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
  const raiz=path.join(__dirname,'public'),saida=path.join(__dirname,'../docs/varredura');fs.mkdirSync(saida,{recursive:true});
  const hoje=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const futuro=new Date(hoje+'T12:00:00Z');futuro.setUTCDate(futuro.getUTCDate()+7);const uso=futuro.toISOString().slice(0,10);
  try{for(const [width,tema] of [[1366,'escuro'],[390,'escuro'],[320,'claro']]){
    const ctx=await browser.newContext({viewport:{width,height:900},locale:'pt-BR'}),escritas=[],erros=[];let perfil='gerente',vendas=[],checkins=[];
    await ctx.addInitScript(t=>{localStorage.setItem('authToken','teste');localStorage.setItem('zenithTema',t);},tema);
    await ctx.route('**/*',async route=>{
      const req=route.request(),url=new URL(req.url());
      if(url.pathname.startsWith('/api/')){
        if(url.pathname==='/api/me')return route.fulfill({json:{id:'gerente',role:'user',cargo:perfil,permissions:{sections:['parque-checkin','parque-loja'],unidades:['Saltiverso Patteo']}}});
        if(url.pathname==='/api/parque/tabela')return route.fulfill({json:{tempos:[{minutos:30,preco:40,label:'30 min'},{minutos:60,preco:50,label:'60 min'}],pcd:[]}});
        if(url.pathname==='/api/parque/checkins')return route.fulfill({json:checkins});
        if(url.pathname.endsWith('/previa'))return route.fulfill({json:{valor:50,valorMeias:0}});
        if(req.method()==='POST'){const body=req.postDataJSON();escritas.push(body);vendas=[{...body,id:'vf_teste',criadoPorEmail:'gerente@teste.local',criadoEm:new Date().toISOString(),atualizadoEm:new Date().toISOString(),dataVenda:hoje,valor:50,status:'AGENDADO',historico:[]}];return route.fulfill({json:vendas[0]});}
        return route.fulfill({json:vendas});
      }
      const arquivo=path.resolve(raiz,'.'+url.pathname);
      if(!arquivo.startsWith(raiz+path.sep)||!fs.existsSync(arquivo))return route.fulfill({status:404,body:''});
      let body=fs.readFileSync(arquivo);
      if(process.argv.includes('--sabotagem-pagamento')&&url.pathname==='/parque-vendas-futuras.html'){
        const fonte=body.toString(),alvo="pagamentoConfirmado:$('confirmado').checked";assert(fonte.includes(alvo));body=fonte.replace(alvo,'pagamentoConfirmado:false');
      }
      return route.fulfill({body,contentType:arquivo.endsWith('.html')?'text/html':arquivo.endsWith('.js')?'text/javascript':'application/octet-stream'});
    });
    const pg=await ctx.newPage();pg.setDefaultTimeout(10000);pg.on('pageerror',e=>erros.push(e.message));await pg.goto('https://vf.test/parque-vendas-futuras.html');await pg.waitForSelector('[data-nome]');
    await pg.locator('#data').fill(uso);await pg.locator('#nome').fill('Responsável <img src=x>');await pg.locator('#contato').fill('81900000000');await pg.locator('[data-nome]').fill('Criança teste');await pg.locator('[data-plano]').selectOption('normal:60');
    await pg.locator('#calcular').click();await pg.waitForFunction(()=>document.getElementById('previa').textContent.includes('50,00'));
    await pg.locator('#valor').fill('50');await pg.locator('#referencia').fill('PROVEDOR PIX 12345');await pg.locator('#forma').selectOption('linkPix');await pg.locator('#confirmado').check();
    await pg.locator('#registrar').click();await pg.waitForFunction(()=>document.getElementById('resultado').textContent.includes('Venda registrada'));
    assert.equal(escritas.length,1);assert.equal(escritas[0].dataUtilizacao,uso);assert.equal(escritas[0].forma,'linkPix');assert.equal(escritas[0].dataVenda,undefined,'data financeira definida pelo servidor');assert.equal(escritas[0].pagamentoConfirmado,true);
    assert.equal(await pg.locator('#lista img').count(),0);assert.match(await pg.locator('#lista').innerText(),/Pago — aguardando chegada/);
    assert.equal(await pg.getByRole('button',{name:'Cancelar utilização'}).count(),0,'gerente não cancela recebimento');
    await pg.getByRole('button',{name:'Reagendar',exact:true}).click();assert.equal(await pg.locator('#editar').isVisible(),true);await pg.keyboard.press('Escape');
    await pg.locator('#f-uso').fill(hoje);assert.equal(await pg.locator('#lista article').count(),0);await pg.locator('#f-uso').fill(uso);assert.equal(await pg.locator('#lista article').count(),1);
    assert.equal(await pg.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`overflow ${width}`);
    await pg.screenshot({path:path.join(saida,`vendas-futuras-${width}.png`),fullPage:true});
    perfil='operador';await pg.reload();await pg.waitForFunction(()=>document.getElementById('acesso').textContent.includes('exclusivo'));assert.equal(await pg.locator('#conteudo').isVisible(),false);assert.deepEqual(erros,[]);
    const base={unidade:'Saltiverso Patteo',responsavel:{nome:'Venda comum'},criancas:[{nome:'Criança',tempoMinutos:60,meia:false}],planosIndividuais:true,valor:50,pulseiras:1,iniciado:false,termoAssinado:true,dataUtilizacao:hoje,criadoEm:hoje+'T12:00:00Z'};
    checkins=Array.from({length:35},(_,i)=>({...base,id:'comum-'+i}));
    checkins.push({...base,id:'antecipado',vendaFuturaId:'antecipado',dataVenda:'2026-01-01',criadoEm:'2026-01-01T12:00:00Z',metodoPagamento:'linkPix',responsavel:{nome:'Reserva antecipada antiga'}});
    checkins.push({...base,id:'amanha',vendaFuturaId:'amanha',dataVenda:hoje,dataUtilizacao:uso,responsavel:{nome:'Reserva de outra data'}});
    checkins.push({...base,id:'cancelado',vendaFuturaId:'cancelado',vendaFuturaCancelada:true,responsavel:{nome:'Reserva cancelada'}});
    await pg.goto('https://vf.test/parque-checkin.html');await pg.waitForFunction(()=>document.getElementById('lista-checkins').textContent.includes('Reserva antecipada antiga'));
    assert.equal(await pg.locator('#vendas-futuras-link').isVisible(),false);
    const conteudo=await pg.locator('#lista-checkins').innerText();assert.match(conteudo,/Pago antecipadamente/);assert.match(conteudo,/Link Pix/);assert(!conteudo.includes('Reserva cancelada'));assert(!conteudo.includes('Reserva de outra data'));
    assert.equal(await pg.locator('[onclick="fazerCheckin(\'antecipado\')"]').count(),1,'reserva antiga não desaparece com o limite de 30 recentes');
    await pg.locator('#agenda-futura').fill(uso);assert.match(await pg.locator('#lista-checkins').innerText(),/Reserva de outra data/);assert.equal(await pg.locator('[onclick="fazerCheckin(\'amanha\')"]').count(),0,'não oferece entrada antes do dia');
    assert.deepEqual(erros,[]);
    await ctx.close();console.log(`✓ Vendas futuras ${width}px ${tema}: cadastro, pagamento confirmado, filtros, escape e bloqueio do operador.`);
  }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

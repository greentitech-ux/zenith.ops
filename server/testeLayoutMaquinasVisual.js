// Tela e estilos reais; somente dados e APIs locais, sem comandos em máquinas.
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {chromium}=require('playwright');
const raiz=path.join(__dirname,'public');
const plano=[{prioridade:'definitivo',titulo:'Ampliar RAM para pelo menos 8 GB',detalhe:'3.7 GB instalados limitam o Windows; limpeza e reinício só aliviam temporariamente.'},{prioridade:'agora',titulo:'Identificar consumo de memória',detalhe:'Gestor de Pedidos está entre os maiores consumos; diagnostique antes de fechar aplicações.'},{prioridade:'agora',titulo:'Programar reinício assistido',detalhe:'Sete dias ou mais sem reiniciar acumulam atualizações e memória fragmentada.'}];
function computador(i){return {codigo:'TESTE',posto:'pc'+i,nome:i===0?'NOT-ADMINISTRATIVO':'DOM-SM-CALLCENTER.0'+i,unidadeNome:'DOMINOS SAO MIGUEL',tipo:'interno',online:i!==0,nivel:i===0?'critico':'atencao',temMedicao:true,precisaReiniciar:i===1,uptimeDias:i===1?15:2,temperatura:28,aparelhosRede:9,ultimoHeartbeatEm:Date.now()-8*3600000,volumeCritico:{letra:'C:',livrePct:54,livreGb:60.1,totalGb:111.1},disco:{em:Date.now(),discos:[{tipo:'SATA SSD',horasLigado:36000,saude:'boa'}]},motivos:i===0?['RAM: só 0.2 GB livres de 3.7 GB (5.4%)']:['SATA SSD: 4 anos ligado'],planoOtimizar:i===0?plano.slice(0,2):i===1?plano:[],politica:i===1?{estacao:{ativa:true}}:{}};}
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
  try{
    for(const width of [360,390,768,1024,1440]){
      const page=await browser.newPage({viewport:{width,height:1000}}),erros=[];
      page.on('pageerror',e=>erros.push(e.message));
      await page.addInitScript(()=>localStorage.setItem('authToken','teste-local'));
      await page.route('**/*',async route=>{
        const u=new URL(route.request().url());
        if(u.pathname.startsWith('/api/')){
          let data=[];
          if(u.pathname==='/api/me')data={id:'teste',role:'master',permissions:{sections:[]}};
          if(u.pathname==='/api/loja-status/maquinas')data={computadores:[0,1,2,3,4,5].map(computador)};
          if(u.pathname==='/api/stream')return route.fulfill({contentType:'text/event-stream',body:''});
          return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
        }
        let arquivo=path.resolve(raiz,'.'+u.pathname);if(!path.extname(arquivo))arquivo+='.html';
        if(!arquivo.startsWith(raiz+path.sep)||!fs.existsSync(arquivo)||fs.statSync(arquivo).isDirectory())return route.fulfill({status:404,body:''});
        return route.fulfill({contentType:arquivo.endsWith('.html')?'text/html':arquivo.endsWith('.js')?'text/javascript':'application/octet-stream',body:fs.readFileSync(arquivo)});
      });
      await page.goto('http://teste.local/noc-maquinas');
      await page.waitForSelector('.card-acoes');await page.evaluate(()=>document.fonts.ready);
      if(process.argv.includes('--sabotar'))await page.addStyleTag({content:'.card-acoes{display:flex!important;flex-wrap:nowrap!important}.card-acoes>button{font-family:var(--mono)!important;white-space:nowrap!important;min-width:0!important}'});
      const falhas=await page.locator('.card').evaluateAll(cards=>cards.flatMap(card=>{
        const c=card.getBoundingClientRect(),falhas=[];
        for(const b of card.querySelectorAll('.card-acoes>button')){
          const r=b.getBoundingClientRect();
          if(r.left<c.left||r.right>c.right+1||b.scrollWidth>b.clientWidth+1)falhas.push('Botão cortado ou fora do card');
          if(r.height<40)falhas.push('Alvo de toque pequeno');
        }
        return falhas;
      }));
      assert.deepEqual(falhas,[],width+'px: botões devem caber no card');
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      assert.equal(await page.locator('.card').count(),6);assert.deepEqual(erros,[]);
      await page.locator('.card .detalhe summary').first().click();
      assert(await page.locator('.card .detalhe').first().evaluate(e=>e.open));
      await page.locator('.card .detalhe summary').first().click();
      await page.locator('.card-acoes button').filter({hasText:'Perfil estação'}).first().click();
      assert(await page.locator('#modal-estacao').isVisible());
      await page.evaluate(()=>fecharEstacao());
      fs.mkdirSync(path.join(__dirname,'../docs/varredura'),{recursive:true});
      await page.screenshot({path:path.join(__dirname,'../docs/varredura/maquinas-layout-'+width+'.png'),fullPage:true});
      await page.close();
    }
    console.log('✓ Saúde das máquinas: 5 larguras, botões completos, toque, ficha e perfil preservados, sem erros JS');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

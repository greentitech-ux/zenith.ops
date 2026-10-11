'use strict';
// Página real, API interceptada: interação e layout sem alterar produção.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const raiz=path.join(__dirname,'public'),saida=path.join(__dirname,'../docs/varredura');
const html=process.argv.includes('--antes')?execFileSync('git',['show','HEAD:server/public/saltiverso-fechamento.html'],{cwd:__dirname}):fs.readFileSync(path.join(raiz,'saltiverso-fechamento.html'));
const unidade='Saltiverso Patteo', formas=require('./public/saltiverso-caixa-formas');
const novo={credito:90,debito:40,voucher:20,pix:30,linkCredito:10,linkDebito:10,linkPix:70,dinheiro:40,outros:0};
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
  try{
    fs.mkdirSync(saida,{recursive:true});
    for(const [width,height,tema] of [[1366,900,'escuro'],[390,844,'escuro'],[320,740,'claro'],[768,1024,'claro']]){
      const ctx=await browser.newContext({viewport:{width,height},locale:'pt-BR'});
      await ctx.addInitScript(tema=>{localStorage.setItem('authToken','fixture');localStorage.setItem('zenithTema',tema);},tema);
      let perfil='master', diaFechado=true;const escritas=[];
      const caixa={id:'caixa-novo',unidade,data:'2026-10-11',operadorId:'operador',operadorNome:'Operador <img src=x onerror=alert(1)>',operadorEmail:'operador@teste.local',origem:'balcao',declarado:{...novo},somaDeclarado:310,faturadoOperador:310,faturadoOperadorPorForma:{...novo,pix:100,pixcnpj:0},diferencaOperador:0,resultado:'ok',lancadoEm:'2026-10-11T15:00:00Z',atualizadoEm:'2026-10-11T15:00:00Z',observacao:'Recibos conferidos',historico:[]};
      const antigo={...caixa,id:'caixa-antigo',operadorId:'outro',operadorNome:'Junius',declarado:{maquininha:500,dinheiro:20,pix:40,outros:0},faturadoOperadorPorForma:{maquininha:1000,dinheiro:100,pix:60,outros:0},somaDeclarado:560,faturadoOperador:1160,diferencaOperador:-600,resultado:'faltando'};
      await ctx.route('**/*',async route=>{
        const req=route.request(),u=new URL(req.url());
        if(u.pathname.startsWith('/api/')){
          if(req.method()!=='GET'){
            const body=req.postDataJSON();escritas.push({path:u.pathname,method:req.method(),body});
            if(req.method()==='PUT'){
              assert.equal(perfil,'master');
              caixa.historico.push({antes:{...caixa.declarado},depois:body.declarado,motivo:body.motivo,porEmail:'master@teste.local',em:'2026-10-11T16:00:00Z'});
              caixa.declarado=body.declarado;caixa.somaDeclarado=formas.somar(body.declarado);caixa.diferencaOperador=caixa.somaDeclarado-caixa.faturadoOperador;caixa.atualizadoEm='2026-10-11T16:00:00Z';
            }
            return route.fulfill({json:{ok:true,id:'pedido-teste'}});
          }
          if(u.pathname==='/api/me') return route.fulfill({json:{id:perfil==='operador'?'operador':'master',role:perfil==='master'?'master':'user',cargo:perfil==='gerente'?'gerente':null,permissions:{sections:['parque-loja'],unidades:[unidade]}}});
          if(u.pathname==='/api/saltiverso/fechamento') return route.fulfill({json:perfil==='operador'?{meuCaixa:caixa,diaFechado,temFesta:false}:{caixas:[caixa,antigo],pendentes:diaFechado?[]:[{operadorId:'pendente',operadorEmail:'pendente@teste.local',faturado:200}],faturado:1470,faturadoPorForma:{...novo},somaCaixas:caixa.somaDeclarado+560,diferencaPrevia:-600,fechamento:diaFechado?{somaTotalDeclarado:caixa.somaDeclarado+560,faturado:1470,diferenca:-600,criadoPorEmail:'master@teste.local'}:null}});
          return route.fulfill({json:[]});
        }
        if(['/notif-central.js','/alarme-sync.js','/suporte-chat.js','/nav-menu.js'].includes(u.pathname)) return route.fulfill({body:'',contentType:'text/javascript'});
        const arquivo=path.resolve(raiz,'.'+u.pathname);
        if(!arquivo.startsWith(raiz+path.sep)||!fs.existsSync(arquivo)||!fs.statSync(arquivo).isFile()) return route.fulfill({status:404,body:''});
        let body=u.pathname==='/saltiverso-fechamento.html'?html:fs.readFileSync(arquivo);
        // Mutação só em memória: o teste deve falhar se Online deixar de somar.
        if(process.argv.includes('--sabotagem-online') && u.pathname==='/saltiverso-caixa-formas.js'){
          const fonte=body.toString();assert(fonte.includes('resultado.online+='));body=fonte.replace('resultado.online+=','resultado.online+=0*');
        }
        return route.fulfill({body,contentType:{'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(arquivo)]||'application/octet-stream'});
      });
      const pg=await ctx.newPage(),erros=[];pg.on('pageerror',err=>erros.push(err.message));
      await pg.goto('http://caixas.test/saltiverso-fechamento.html');
      await pg.waitForFunction(()=>document.querySelector('#lista-caixas .card'));
      assert.equal(await pg.locator('[data-caixa-detalhe]').count(),2,'Master abre caixas pelo nome');
      await pg.locator('[data-caixa-detalhe="caixa-novo"]').click();
      assert.equal(await pg.locator('#caixa-correcao-form input').count(),9);
      assert.deepEqual(await pg.locator('#caixa-correcao-form legend').allTextContents(),['Maquininha','Online','Dinheiro','Outros']);
      assert.equal(await pg.locator('#caixa-detalhe img').count(),0,'nome deve ser escapado');
      assert.equal(escritas.length,0,'abrir detalhe não altera nada');
      assert.match(await pg.locator('#caixa-detalhe-corpo').innerText(),/comparação é conjunta/);
      await pg.screenshot({path:path.join(saida,`saltiverso-caixa-detalhe-${width}.png`)});
      await pg.getByText('Corrigir este caixa · Master',{exact:true}).click();
      await pg.locator('#correcao-credito').fill('105');
      await pg.locator('#caixa-correcao-motivo').fill('Crédito conferido no recibo');
      await pg.getByRole('button',{name:'Salvar correção',exact:true}).click();
      await pg.waitForFunction(()=>document.querySelector('#caixa-correcao-msg')?.textContent.includes('Correção salva'));
      assert.equal(escritas[0].body.declarado.credito,105);assert.equal(escritas[0].body.declarado.linkPix,70);
      assert.equal(escritas[0].body.versaoEsperada,'2026-10-11T15:00:00Z');
      await pg.getByText('Histórico de correções (1)',{exact:true}).click();
      assert.match(await pg.locator('.auditoria').innerText(),/Antes:.*Crédito: R\$ 90,00/);
      for(const zoom of [1,1.25]){
        await pg.evaluate(z=>document.documentElement.style.zoom=z,zoom);
        const overflow=await pg.evaluate(()=>{const d=document.querySelector('#caixa-detalhe');return d.scrollWidth>d.clientWidth+1;});
        assert.equal(overflow,false,`modal cabe em ${width}px zoom${zoom}`);
      }
      await pg.evaluate(()=>document.documentElement.style.zoom='1');
      await pg.keyboard.press('Escape');assert.equal(await pg.locator('#caixa-detalhe').isVisible(),false);
      await pg.locator('[data-caixa-detalhe="caixa-antigo"]').click();
      assert.equal(await pg.locator('#caixa-correcao-form input').count(),4,'legado mantém quatro campos');
      assert.equal(await pg.locator('#correcao-maquininha').inputValue(),'500');
      await pg.keyboard.press('Escape');
      // Novo lançamento: nove campos detalhados e quatro subtotais.
      diaFechado=false;await pg.reload();await pg.waitForSelector('#td-credito');
      assert.equal(await pg.locator('#meu-caixa-corpo input').count(),9);
      assert.equal(await pg.locator('#td-pixcnpj').count(),0);
      for(const [campo,valor] of Object.entries(novo)) await pg.locator('#td-'+campo).fill(String(valor));
      const resumo=pg.locator('[data-consolidado-prefixo="td"]');
      for(const [grupo,valor] of Object.entries({maquininha:'180,00',online:'90,00',dinheiro:'40,00',outros:'0,00',total:'310,00'})) assert.equal(await resumo.locator(`[data-consolidado-grupo="${grupo}"]`).innerText(),'R$ '+valor);
      assert.equal(await pg.locator('[data-prefixo="td"]').evaluateAll(els=>els.every(el=>el.getBoundingClientRect().width>0)),true);
      assert.equal(await pg.locator('[data-caixa-detalhe]').count(),2,'pendente não abre ficha inexistente');
      await pg.screenshot({path:path.join(saida,`saltiverso-caixa-novo-${width}.png`),fullPage:true});
      // Gerente mantém acesso à lista, mas não ganha correção direta.
      perfil='gerente';await pg.reload();await pg.waitForFunction(()=>document.querySelector('#lista-caixas .card'));
      assert.equal(await pg.locator('[data-caixa-detalhe]').count(),0);
      perfil='operador';diaFechado=true;await pg.reload();await pg.waitForFunction(()=>document.querySelector('#meu-caixa-corpo .resumo'));
      assert.equal(await pg.locator('#painel-caixas').isVisible(),false);
      await pg.getByRole('button',{name:'Pedir correção'}).click();
      assert.equal(await pg.locator('#form-alteracao input').count(),9);
      await pg.locator('#alt-linkPix').fill('75');await pg.locator('#alt-motivo').fill('Comprovante do link Pix');
      await pg.getByRole('button',{name:'Enviar pedido ao Master'}).click();
      await pg.waitForFunction(()=>document.querySelector('#msg-alt')?.textContent==='Pedido enviado ao Master.');
      assert.equal(escritas.length,2);assert.equal(escritas[1].body.declarado.linkPix,75);
      assert.equal(escritas[1].method,'POST');assert.match(escritas[1].path,/solicitar-alteracao$/);
      assert.deepEqual(erros,[]);
      await ctx.close();console.log(`✓ ${width}px ${tema}: nove formas, quatro subtotais ao digitar, Master, legado, zoom e correções.`);
    }
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

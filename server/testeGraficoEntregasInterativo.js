'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),vm=require('vm');
const {chromium}=require('playwright');
const ler=nome=>fs.readFileSync(path.join(__dirname,'public',nome),'utf8');
const fonte=ler('entregas-painel.js'),html=ler('entregas.html');new vm.Script(fonte);
function estrutura(codigo){assert.match(codigo,/addEventListener\(evento/);assert.match(codigo,/data-ponto=/);assert.match(codigo,/requestAnimationFrame\(renderGraficoEntregas\)/);}
estrutura(fonte);assert.throws(()=>estrutura(fonte.replaceAll('data-ponto=','data-nenhum=')));
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  try{
    for(const width of [320,390,768,1280,1920]){
      const page=await browser.newPage({viewport:{width,height:900}});
      const erros=[];page.on('pageerror',e=>erros.push(e.message));
      await page.setContent(`<style>${html.match(/<style>([\s\S]*?)<\/style>/)[1]} body{margin:0;padding:0}</style><div id="grafico-periodo" class="sub"></div><select id="grafico-metrica"><option value="entrega">Entregas</option><option value="valor">Valor</option><option value="tm">TM</option></select><select id="grafico-comparar"><option value="anterior">Anterior</option></select><div id="comparativo-entregas" class="comparativo-grid"></div><div id="grafico-entregas"></div><div id="grafico-inspecao" class="grafico-inspecao"></div><div id="grafico-detalhes" class="tablewrap"></div>`);
      await page.addScriptTag({content:ler('entregas-analise.js')});
      await page.addScriptTag({content:`const DATA=Array.from({length:60},(_,i)=>({data:EntregasAnalise.deslocar('2026-09-01',i),entrega:i%4+1,valor:(i%4+1)*10}));const fmtData=d=>d.split('-').reverse().join('/');const fmtMoney=v=>'R$ '+Number(v).toFixed(2);const escapeHtml=v=>String(v).replaceAll('<','&lt;');${fonte};FILTROS_SECOES.grafico={inicio:'2026-10-01',fim:'2026-10-30',unidades:[],nome:'',dia:''};renderGraficoEntregas();`});
      await page.waitForSelector('[data-ponto]');
      const n=await page.locator('[data-ponto]').count();assert.ok(n<=60);
      await page.locator('[data-ponto]').first().click();
      assert.match(await page.locator('#grafico-inspecao').innerText(),/Atual.*01\/10\/2026/);
      await page.locator('[data-ponto]').first().focus();await page.keyboard.press('ArrowRight');
      assert.equal(await page.evaluate(()=>document.activeElement.dataset.ponto),'1');
      await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement.dataset.ponto),String(n-1));
      for(const metrica of ['valor','tm']){
        await page.selectOption('#grafico-metrica',metrica);await page.evaluate(()=>renderGraficoEntregas());
        assert.match(await page.locator('#grafico-inspecao').innerText(),/R\$ /);
      }
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`Largura ${width}`);
      assert.equal(Math.round((await page.locator('svg').boundingBox()).height),300);
      // A agregação responsiva mantém o consolidado (não tira média de médias).
      const soma=await page.evaluate(()=>PONTOS_GRAFICO.reduce((s,p)=>s+p.atual.entrega,0));
      assert.equal(soma,77);
      assert.deepEqual(erros,[]);
      await page.close();
    }
    console.log('OK: toque/clique, teclado, indicadores, comparação, totais preservados, altura 300px, 320–1920px e sabotagem.');
  }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});

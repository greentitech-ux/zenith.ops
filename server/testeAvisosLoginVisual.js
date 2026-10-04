'use strict';
const assert=require('assert/strict');
const fs=require('fs');
const path=require('path');
const {chromium}=require('playwright');
(async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
  try {
    for(const largura of [390,1366]) {
      const page=await browser.newPage({viewport:{width:largura,height:900}});
      await page.setContent('<html lang="pt-BR"><head><style>:root{--panel:#12161b;--text:#e7ecf1;--line:#232a33;--accent:#b8ff3c;--muted:#7d8896;--sans:Arial}body{margin:0;background:#0b0d10;color:var(--text);font-family:Arial;padding:16px}h1{font-size:22px}</style></head><body><h1>NoPulso · Master</h1><input aria-label="Campo em edição" value="Não interromper a digitação"></body></html>');
      await page.evaluate(()=>{window.zenithAoVivo=(eventos,fn,opcoes)=>{if(eventos[0]!=='usuario-entrou'||!opcoes.imediato)throw Error('Assinatura incorreta');window.avisoTeste=fn;};});
      await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'public/login-avisos.js'),'utf8')});
      await page.locator('input').focus();
      await page.evaluate(()=>{
        window.avisoTeste({id:'1',nome:'Junius',unidade:'Saltiverso Patteo',computador:'CAIXA 1',em:Date.now()});
        window.avisoTeste({id:'1',nome:'Duplicado',em:Date.now()});
      });
      assert.equal(await page.locator('[role=status]').count(),1);
      assert.equal(await page.locator('input').evaluate(e=>document.activeElement===e),true,'Não roubar foco');
      assert.ok((await page.locator('[role=status]').innerText()).includes('Saltiverso Patteo'));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      const arquivo=path.join(__dirname,'..','docs/varredura','aviso-login-'+largura+'.png');
      fs.mkdirSync(path.dirname(arquivo),{recursive:true});await page.screenshot({path:arquivo});
      await page.evaluate(()=>window.avisoTeste({id:'2',nome:'<img src=x onerror=alert(1)>',em:Date.now()}));
      assert.equal(await page.locator('#nopulso-entradas img').count(),0,'Nome não vira HTML');
      await page.getByLabel('Fechar aviso de entrada').first().click();
      assert.equal(await page.locator('[role=status]').count(),1);
      await page.close();
    }
    console.log('✓ Aviso visual: desktop/celular, sem overflow, sem roubar foco, duplicata recusada, nome seguro e fechar funcional.');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

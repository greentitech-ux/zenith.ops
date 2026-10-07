'use strict';
const assert=require('assert/strict');
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const {chromium}=require('playwright');
(async()=>{
  const html=fs.readFileSync(path.join(__dirname,'public/loja-status.html'),'utf8');
  for(const s of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(s[1]);
  const pintar=html.slice(html.indexOf('function pintarManutencaoProgramas('),html.indexOf('function pintarProgramas('));
  const inscrever=html.slice(html.indexOf('async function inscreverEsteTablet('),html.indexOf('async function baixarVigia('));
  const navegador=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
  try {
    for(const largura of [390,1280]) {
      const page=await navegador.newPage({viewport:{width:largura,height:900}});
      await page.setContent('<html><head>'+[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(s=>s[0]).join('')+'</head><body><main style="padding:16px"><div id="prog-corpo"></div></main></body></html>');
      await page.addScriptTag({content:`let PROG_ATUAL={nome:'Tablet da unidade',codigo:'TESTE',posto:'TABLET',tipo:'atendimento'}; let PODE_BAIXAR_ANDROID=true;let ANDROID_DISPONIVEL=true;function escapeHtml(s){return s}function escapeJs(s){return s}\n${pintar}\n${inscrever}`});
      await page.evaluate(()=>pintarManutencaoProgramas(document.getElementById('prog-corpo')));
      assert.equal(await page.getByRole('button',{name:'Baixar agente Android (APK)',exact:true}).count(),1);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:path.join(__dirname,'../docs/varredura','android-instalador-'+largura+'.png'),fullPage:true});
      await page.evaluate(()=>{window.fetch=async()=>({ok:true,json:async()=>({linkAndroid:'nopulso://inscrever?u=TESTE&p=TABLET&t=credencial-teste'})});});
      await page.getByRole('button',{name:'Inscrever este tablet',exact:true}).click();
      const abrir=page.getByRole('link',{name:'Abrir NoPulso Agente e configurar'});
      assert.equal(await abrir.getAttribute('href'),'nopulso://inscrever?u=TESTE&p=TABLET&t=credencial-teste');
      assert.equal(await abrir.evaluate(el=>!!el.closest('.prog-manut-android')),true);
      await page.evaluate(()=>{ANDROID_DISPONIVEL=false;pintarManutencaoProgramas(document.getElementById('prog-corpo'));});
      assert.equal(await page.getByRole('button',{name:'Baixar agente Android (APK)',exact:true}).isDisabled(),true);
      await page.evaluate(()=>{PODE_BAIXAR_ANDROID=false;pintarManutencaoProgramas(document.getElementById('prog-corpo'));});
      assert.equal(await page.getByRole('button',{name:'Baixar agente Android (APK)',exact:true}).count(),0);
      await page.close();
    }
    console.log('✓ Android visual: tablet/celular, sem overflow, botão oculto/restrito, publicação ausente e inscrição por toque real.');
  } finally {await navegador.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

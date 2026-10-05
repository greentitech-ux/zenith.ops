'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path');
const {chromium}=require('playwright');
const {podeAtender}=require('./centralBeniboy');
const casos=[
  [{role:'master'},true],[{role:'admin'},false],
  [{role:'user',cargo:'suporte'},true],[{role:'user',cargos:['tecnico']},true],
  [{role:'user',permissions:{sections:['suporte']}},false],
  [{role:'master',active:false},false],[null,false],
];
for(const [u,permitido] of casos) assert.equal(podeAtender(u),permitido);
assert.throws(()=>assert.equal(true,podeAtender({role:'admin'})),'sabotagem detecta Admin sem cargo');
const pasta=path.join(__dirname,'public');
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
  try{
    for(const largura of [390,1024,1440]){
      const page=await browser.newPage({viewport:{width:largura,height:900}});
      let permitido=false;
      const erros=[];page.on('pageerror',e=>erros.push(e.message));
      await page.route('**/*',async route=>{
        const u=new URL(route.request().url());
        if(u.pathname==='/api/auth/login') return route.fulfill({json:{token:'token-equipe',user:{precisaTrocarSenha:false,temPalavraRecuperacao:true}}});
        if(u.pathname==='/api/beniboy/acesso') return route.fulfill({json:{permitido}});
        if(u.pathname.startsWith('/api/')) return route.fulfill({json:[]});
        if(u.pathname==='/atendimento/central') return route.fulfill({body:'Central autorizada'});
        const arquivo=path.resolve(pasta,u.pathname==='/atendimento/entrar'?'atendimento.html':u.pathname.slice(1));
        if(!arquivo.startsWith(pasta+path.sep)||!fs.existsSync(arquivo)||!fs.statSync(arquivo).isFile()) return route.fulfill({status:404,body:''});
        return route.fulfill({path:arquivo});
      });
      await page.goto('https://nopulso.teste/atendimento/entrar');
      await page.locator('#portal-marca svg').waitFor();
      assert.equal(await page.locator('#portal-marca .bb-traco').evaluate(e=>getComputedStyle(e).stroke),'rgb(11, 13, 16)','marca preta não é sobrescrita pelo tema');
      assert.equal(await page.locator('#portal-marca .bb-fundo').evaluate(e=>getComputedStyle(e).fill),'rgb(255, 212, 59)','fundo amarelo');
      await page.locator('#portal-usuario').fill('operador');
      await page.locator('#portal-senha').fill('senha-teste');
      await page.locator('#portal-entrar').click();
      await page.locator('#portal-erro').waitFor({state:'visible'});
      assert.equal(await page.evaluate(()=>localStorage.getItem('authToken')),null,'recusa não troca a sessão do NoPulso');
      assert.equal(await page.locator('#portal-senha').inputValue(),'');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:path.join(__dirname,'../docs/varredura','portal-beniboy-'+largura+'.png'),fullPage:true});
      await page.locator('#portal-anonimo').click();
      await page.locator('#szc-nome').waitFor({state:'visible'});
      assert.equal(await page.locator('#szc-contato').isVisible(),true,'anônimo continua pedindo contato');
      await page.goto('https://nopulso.teste/atendimento/entrar');
      permitido=true;
      await page.locator('#portal-usuario').fill('suporte');
      await page.locator('#portal-senha').fill('senha-teste');
      await page.locator('#portal-entrar').click();
      await page.waitForURL('**/atendimento/central');
      assert.equal(await page.evaluate(()=>localStorage.getItem('authToken')),'token-equipe');
      assert.deepEqual(erros,[]);
      await page.close();
    }
    console.log('✓ Portal Beniboy: cargos, recusa sem trocar sessão, nome/contato, login autorizado e três tamanhos.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

'use strict';
const assert = require('assert/strict'), path = require('path');
const { chromium } = require('playwright');
(async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
  try {
    const page=await browser.newPage({viewport:{width:390,height:780}});
    const erros=[];page.on('pageerror',e=>erros.push(e.message));
    await page.setContent('<section id="a"><div><input id="campo-a"></div></section><section id="b"><div><input id="campo-b"></div></section>');
    await page.evaluate(()=>{
      window.sinais=[];window.canais=[];
      window.fetch=async (url,o)=>{sinais.push({url,body:JSON.parse(o.body)});return {ok:true};};
      window.EventSource=class {
        constructor(url){this.url=url;this.handlers={};canais.push(this);}
        addEventListener(nome,fn){this.handlers[nome]=fn;}
        close(){this.fechado=true;}
        emitir(dados){this.handlers.digitando?.({data:JSON.stringify(dados)});}
      };
    });
    await page.addScriptTag({path:path.join(__dirname,'public/chat-digitando.js')});
    await page.evaluate(()=>{
      nopulsoDigitando.conectar({chave:'a',input:document.getElementById('campo-a'),id:'chat-a',token:'a'.repeat(48),lado:'suporte'});
      nopulsoDigitando.conectar({chave:'b',input:document.getElementById('campo-b'),id:'chat-b',token:'b'.repeat(48),lado:'visitante'});
    });
    await page.locator('#campo-a').fill('rascunho confidencial');
    await page.evaluate(()=>{for(let i=0;i<200;i++)document.getElementById('campo-a').dispatchEvent(new Event('input'));});
    assert.equal(await page.evaluate(()=>sinais.filter(s=>s.body.ativo).length),1,'uma rajada não envia por tecla');
    assert.equal(await page.evaluate(()=>JSON.stringify(sinais).includes('rascunho')),false,'texto nunca é transmitido');
    assert.deepEqual(await page.evaluate(()=>Object.keys(sinais[0].body).sort()),['ativo','token']);
    await page.evaluate(()=>canais[0].emitir({ativo:true,prazoMs:100}));
    assert.match(await page.locator('#a .chat-digitando').innerText(),/Solicitante está digitando/);
    assert.equal(await page.locator('#b .chat-digitando').isVisible(),false,'outra conversa não mostra o aviso');
    await page.waitForFunction(()=>document.querySelector('#a .chat-digitando').hidden);
    await page.evaluate(()=>canais[1].emitir({ativo:true,prazoMs:8000}));
    assert.match(await page.locator('#b .chat-digitando').innerText(),/Suporte está digitando/);
    await page.locator('#campo-b').focus();
    assert.equal(await page.evaluate(()=>sinais.at(-1).body.ativo),false,'sair do campo informa parada');
    await page.evaluate(()=>{document.getElementById('b').style.display='none';});
    await page.waitForFunction(()=>canais[1].fechado);
    await page.evaluate(()=>{nopulsoDigitando.parar('a');nopulsoDigitando.parar('b');});
    assert.equal(await page.locator('.chat-digitando').count(),0,'encerrar remove o indicador');
    // Sabotagem do transporte: texto no pacote reprova a mesma regra.
    await page.evaluate(()=>sinais[0].body.texto='rascunho confidencial');
    const vazou=await page.evaluate(()=>JSON.stringify(sinais).includes('rascunho'));
    assert.throws(()=>assert.equal(vazou,false));
    assert.deepEqual(erros,[]);
    console.log('✓ Digitando no navegador: ambos os lados, isolamento, rajada, sigilo, expiração, blur, ocultação e sabotagem.');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

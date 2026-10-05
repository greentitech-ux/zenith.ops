'use strict';
// Interface real, APIs simuladas: não cria conversas nem envia dados a produção.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { chromium } = require('playwright');
const raiz = path.join(__dirname, 'public');
const html = fs.readFileSync(path.join(raiz, 'beniboy.html'), 'utf8');
for (const s of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(s[1]);
new vm.Script(fs.readFileSync(path.join(raiz,'beniboy-app.js'),'utf8'));
const manifesto=JSON.parse(fs.readFileSync(path.join(raiz,'manifest-beniboy.json'),'utf8'));
assert.equal(manifesto.start_url,'/atendimento/central');
assert.equal(manifesto.scope,'/atendimento/');
assert.notEqual(manifesto.id,JSON.parse(fs.readFileSync(path.join(raiz,'manifest.json'),'utf8')).id);
assert.equal(JSON.parse(fs.readFileSync(path.join(raiz,'manifest.json'),'utf8')).start_url,'/','app principal mantém sua entrada');
const agora = new Date().toISOString();
const me = { id:'suporte-teste', nome:'Suporte teste', username:'Suporte teste', email:'suporte@teste.invalid', role:'master', permissions:{sections:['suporte','network-private']} };
function conversas() {
  return [
    { id:'chat-a', nome:'Ana Atendimento', contato:'ana@teste.invalid', assunto:'Computador/Sistema', lojaContexto:'Unidade Norte', numeroTicket:101, status:'ABERTO', statusAtendimento:'PENDENTE', atualizadoEm:agora, mensagens:[{de:'visitante',texto:'Preciso de ajuda com o computador.',em:agora}], notasInternas:[{situacao:'PENDENTE',resumo:'Conferir impressora',em:agora}], ticketsVinculados:[] },
    { id:'chat-b', nome:'Bruno Operação', contato:'bruno@teste.invalid', assunto:'Acesso/Senha', lojaContexto:'Unidade Sul', numeroTicket:102, status:'ABERTO', statusAtendimento:'EM_ATENDIMENTO', responsavel:{id:me.id,email:me.email,nome:me.nome}, atualizadoEm:agora, mensagens:[{de:'visitante',texto:'Meu acesso não entrou.',em:agora}] },
    { id:'chat-c', nome:'Carlos Histórico', contato:'carlos@teste.invalid', assunto:'Suporte geral', lojaContexto:'Unidade Norte', numeroTicket:103, status:'FINALIZADO', statusAtendimento:'RESOLVIDO', atualizadoEm:agora, mensagens:[{de:'suporte',texto:'Resolvido.',em:agora}] },
  ];
}
(async()=>{
  const navegador=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
  const destino=path.join(__dirname,'../docs/varredura');
  fs.mkdirSync(destino,{recursive:true});
  try {
    for(const [largura,tema] of [[1440,'escuro'],[1024,'claro'],[390,'escuro']]) {
      const page=await navegador.newPage({viewport:{width:largura,height:900}});
      const erros=[];page.on('pageerror',e=>erros.push(e.message));
      let itens=conversas(), envios=0, negar=false, liberarBeniboy=true;
      itens[1].mensagens.push({de:'suporte',texto:'',em:agora,anexo:{nome:'audio-teste.wav',tipo:'audio/wav',path:'teste-audio'}});
      // WAV válido em memória: o teste realmente toca, sem arquivo de produção.
      const wav=Buffer.alloc(44+8000*2*10);
      wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);
      wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);
      wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
      await page.addInitScript(({tema})=>{ localStorage.setItem('authToken','teste');localStorage.setItem('zenithTema',tema); },{tema});
      await page.route('**/*',async route=>{
        const u=new URL(route.request().url());
        if(u.pathname.startsWith('/api/')) {
          let dados=[];
          if(u.pathname==='/api/suporte-chats/chat-b/anexo/1') return route.fulfill({contentType:'audio/wav',body:wav});
          if(u.pathname==='/api/me') dados=me;
          if(u.pathname==='/api/beniboy/acesso') dados={permitido:liberarBeniboy};
          if(u.pathname==='/api/stream') return route.fulfill({contentType:'text/event-stream',body:': teste\n\n'});
          if(u.pathname==='/api/suporte-chats') return route.fulfill({status:negar?503:200,json:negar?{error:'teste'}:itens});
          if(u.pathname.endsWith('/status')) {
            const c=itens.find(c=>c.id===u.pathname.split('/')[3]);
            c.statusAtendimento=route.request().postDataJSON().statusAtendimento;
            return route.fulfill({json:c});
          }
          if(u.pathname.endsWith('/responder')) {
            envios++;
            const id=u.pathname.split('/')[3],texto=route.request().postDataJSON().texto;
            itens.find(c=>c.id===id).mensagens.push({de:'suporte',texto,em:agora});dados={ok:true};
          }
          return route.fulfill({json:dados});
        }
        const relativo=u.pathname==='/beniboy'?'beniboy.html':u.pathname.slice(1);
        const arquivo=path.resolve(raiz,relativo);
        if(!arquivo.startsWith(raiz+path.sep)||!fs.existsSync(arquivo)||!fs.statSync(arquivo).isFile()) return route.fulfill({status:404,body:''});
        return route.fulfill({path:arquivo});
      });
      await page.goto('https://nopulso.teste/beniboy');
      await page.locator('.fila-card').first().waitFor();
      assert.equal(await page.locator('.fila-card').count(),2,'padrão não mistura encerradas à fila');
      assert.equal(await page.locator('.fila-protocolo').count(),2,'protocolo visível na fila');
      await page.getByRole('button',{name:'App / Atalho',exact:true}).click();
      const baixar=page.waitForEvent('download');
      await page.getByRole('button',{name:'Baixar atalho Windows',exact:true}).click();
      const atalho=await baixar;
      assert.equal(atalho.suggestedFilename(),'Central Beniboy.zip');
      const zipAtalho=fs.readFileSync(await atalho.path());
      assert.equal(zipAtalho.readUInt32LE(0),0x04034b50);
      const inicioAtalho=30+zipAtalho.readUInt16LE(26);
      assert.equal(zipAtalho.subarray(30,inicioAtalho).toString(),'Central Beniboy.url');
      const conteudoAtalho=zipAtalho.subarray(inicioAtalho,inicioAtalho+zipAtalho.readUInt32LE(18)).toString();
      assert.equal(conteudoAtalho,'[InternetShortcut]\r\nURL=https://nopulso.teste/atendimento/central\r\n','atalho não transporta sessão');
      await page.evaluate(()=>fecharAppBeniboy());
      await page.getByRole('button',{name:'Claro / Escuro',exact:true}).click();
      assert.equal(await page.locator('html').getAttribute('data-tema'),tema==='claro'?'escuro':'claro');
      await page.getByRole('button',{name:'Claro / Escuro',exact:true}).click();
      await page.getByRole('button',{name:'Aumentar fonte',exact:true}).click();
      assert.ok(await page.evaluate(()=>Number(localStorage.getItem('zenithFonte'))>100));
      await page.getByRole('button',{name:'Diminuir fonte',exact:true}).click();
      await page.locator('[data-id="chat-a"].fila-card').click();
      await page.getByRole('button',{name:'Responder a esta mensagem',exact:true}).first().click();
      assert.equal(await page.locator('#d-citacao-chat-a').isVisible(),true);
      await page.locator('#d-texto-chat-a').fill('Linha 1');
      await page.locator('#d-texto-chat-a').press('Shift+Enter');
      await page.locator('#d-texto-chat-a').press('2');
      assert.equal(await page.locator('#d-texto-chat-a').inputValue(),'Linha 1\n2');
      assert.equal(envios,0,'Shift+Enter não envia');
      await page.locator('#d-texto-chat-a').fill('Rascunho da Ana');
      if(largura<=760) await page.getByRole('button',{name:'← Fila',exact:true}).click();
      await page.locator('[data-id="chat-b"].fila-card').click();
      const player=page.locator('.painel-conversa:visible audio.chat-anexo-audio');
      assert.equal(await player.count(),1,'áudio aparece como player, não link');
      assert.equal(await player.getAttribute('controls'),'');
      assert.equal(await player.getAttribute('preload'),'none','não baixa antes do play');
      assert.match(await player.getAttribute('src'),/anexo\/1\?token=teste$/,'mantém autenticação');
      await player.evaluate(a=>a.play());
      await page.waitForFunction(()=>document.querySelector('.painel-conversa:not(.hidden) audio')?.currentTime>0.05);
      const tocando=await player.evaluate(a=>{window.audioTesteOriginal=a;return a.currentTime;});
      await page.evaluate(()=>carregarLista());
      await page.waitForFunction(()=>{const a=document.querySelector('.painel-conversa:not(.hidden) audio');return a===window.audioTesteOriginal&&!a.paused;});
      assert.ok(await player.evaluate(a=>a.currentTime)>=tocando,'atualização não reinicia áudio');
      await page.screenshot({path:path.join(destino,`central-beniboy-audio-${largura}.png`),fullPage:true});
      await player.evaluate(a=>a.pause());
      const legado=await page.evaluate(()=>anexoHtml('chat-b',{indice:2,anexo:{nome:'audio-antigo.webm',tipo:'application/octet-stream'}}));
      assert.match(legado,/<audio /,'áudio antigo com MIME genérico também recebe player');
      const falso=await page.evaluate(()=>anexoHtml('chat-b',{indice:2,anexo:{nome:'comprovante.pdf',tipo:'application/pdf'}}));
      assert.doesNotMatch(falso,/<audio /,'PDF continua arquivo');
      assert.throws(()=>assert.match('<a>audio-teste.wav</a>',/<audio /),'sabotagem detecta retorno do link');
      await page.getByRole('button',{name:'Ana Atendimento',exact:true}).click();
      assert.equal(await page.locator('#d-texto-chat-a').inputValue(),'Rascunho da Ana','trocar de conversa preserva texto');
      await page.evaluate(()=>carregarLista());
      assert.equal(await page.locator('#d-texto-chat-a').inputValue(),'Rascunho da Ana','atualização preserva texto');
      assert.ok(await page.locator('#d-citacao-chat-a').innerText().then(s=>s.includes('Preciso de ajuda')),'citação acompanha rascunho e atualização');
      assert.equal(await page.locator('.painel-conversa:visible').count(),1,'somente conversa ativa visível');
      await page.screenshot({path:path.join(destino,`central-beniboy-citacao-${largura}-${tema}.png`),fullPage:true});
      await page.getByRole('button',{name:'Dados da conversa',exact:true}).click();
      assert.equal(await page.locator('#contexto-corpo').innerText().then(s=>s.includes('ana@teste.invalid')),true);
      assert.equal(await page.locator('#contexto-corpo').innerText().then(s=>s.includes('nota(s) do Beniboy')),true);
      await page.getByRole('button',{name:'Dados da conversa',exact:true}).click();
      await page.getByRole('button',{name:'Enviar',exact:true}).click();
      await page.waitForFunction(()=>document.getElementById('d-texto-chat-a')?.value==='');
      assert.equal(envios,1);
      assert.match(itens[0].mensagens.at(-1).texto,/Respondendo a Ana Atendimento:\n> Preciso de ajuda/,'citação chega ao servidor como texto');
      assert.equal(await page.locator('#d-citacao-chat-a').isVisible(),false,'envio limpa citação');
      assert.equal(await page.locator('.painel-conversa:visible').innerText().then(s=>s.includes('Rascunho da Ana')),true);
      // O arquivo selecionado também acompanha a aba, não só o texto.
      await page.locator('#d-anexo-chat-a').setInputFiles({name:'print-teste.png',mimeType:'image/png',buffer:Buffer.from('print-de-teste')});
      await page.getByRole('button',{name:'Bruno Operação',exact:true}).click();
      await page.getByRole('button',{name:'Ana Atendimento',exact:true}).click();
      assert.equal(await page.evaluate(()=>RASCUNHOS_PAINEL_CHAT.get('chat-a')?.arquivo?.name),'print-teste.png');
      await page.evaluate(()=>limparRascunhoResposta('chat-a'));
      if(largura<=760) await page.getByRole('button',{name:'← Fila',exact:true}).click();
      await page.getByRole('button',{name:'Meus atendimentos',exact:true}).click();
      assert.equal(await page.locator('.fila-card').count(),1);
      assert.equal(await page.locator('.fila-card').getAttribute('data-id'),'chat-b');
      await page.getByRole('button',{name:'Meus atendimentos',exact:true}).click();
      await page.getByLabel('Status das conversas').selectOption('TODAS');
      assert.equal(await page.locator('.fila-card').count(),3);
      await page.getByLabel('Unidade das conversas').selectOption('Unidade Norte');
      assert.equal(await page.locator('.fila-card').count(),2);
      await page.getByLabel('Buscar conversas').fill('103');
      assert.equal(await page.locator('.fila-card').getAttribute('data-id'),'chat-c');
      await page.getByLabel('Buscar conversas').fill('');
      await page.getByLabel('Unidade das conversas').selectOption('');
      await page.getByLabel('Status das conversas').selectOption('ABERTAS');
      await page.locator('[data-id="chat-a"].fila-card').click();
      // Sabotagem: retirar o estado de rascunhos precisa reprovar a mesma regra.
      await page.locator('#d-texto-chat-a').fill('Resposta protegida');
      await page.evaluate(()=>{
        guardarEstadoPaineis();
        document.getElementById('d-texto-chat-a').value='';
        RASCUNHOS_PAINEL_CHAT.clear();restaurarEstadoPaineis();
      });
      const sabotado=await page.locator('#d-texto-chat-a').inputValue();
      assert.throws(()=>assert.equal(sabotado,'Resposta protegida'),'teste detecta perda de rascunho');
      negar=true;await page.evaluate(()=>carregarLista());
      assert.equal(await page.locator('#central-erro').isVisible(),true);
      assert.equal(await page.locator('.fila-card').count(),2,'erro não apaga fila');
      negar=false;await page.evaluate(()=>carregarLista());
      assert.equal(await page.locator('#central-erro').isVisible(),false);
      await page.getByRole('button',{name:'Deixar em aguardo',exact:true}).click();
      await page.getByRole('button',{name:'Retomar atendimento',exact:true}).waitFor();
      assert.equal(itens[0].status,'ABERTO');
      assert.equal(await page.locator('#d-texto-chat-a').isVisible(),true,'aguardo mantém envio');
      await page.getByRole('button',{name:'Dados da conversa',exact:true}).click();
      await page.locator('#contexto-corpo .resumo-atendimento summary').click();
      assert.match(await page.locator('#contexto-corpo .resumo-atendimento').innerText(),/Rascunho da Ana/,'resumo mostra resposta humana anterior');
      await page.screenshot({path:path.join(destino,`central-beniboy-aguardo-${largura}.png`),fullPage:true});
      await page.getByRole('button',{name:'Dados da conversa',exact:true}).click();
      if(largura<=760) await page.getByRole('button',{name:'← Fila',exact:true}).click();
      await page.getByLabel('Status das conversas').selectOption('EM_AGUARDO');
      assert.equal(await page.locator('.fila-card').count(),1,'aguardo fica no radar');
      await page.getByLabel('Status das conversas').selectOption('ABERTAS');
      await page.locator('[data-id="chat-a"].fila-card').click();
      await page.getByRole('button',{name:'Retomar atendimento',exact:true}).click();
      await page.getByRole('button',{name:'Deixar em aguardo',exact:true}).waitFor();
      await page.getByRole('button',{name:'Responder a esta mensagem',exact:true}).first().click();
      await page.getByRole('button',{name:'Cancelar resposta citada',exact:true}).click();
      assert.equal(await page.locator('#d-citacao-chat-a').isVisible(),false);
      // Sabotagem: o teste da citação deve detectar sua perda numa atualização.
      await page.evaluate(()=>{citarMensagem('chat-a',0);CITACOES_PAINEL_CHAT.clear();mostrarCitacao('chat-a');});
      const citacaoSabotada=await page.locator('#d-citacao-chat-a').isVisible();
      assert.throws(()=>assert.equal(citacaoSabotada,true),'teste detecta perda de citação');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'sem rolagem horizontal');
      const enviar=await page.getByRole('button',{name:'Enviar',exact:true}).boundingBox();
      assert.ok(enviar && enviar.y+enviar.height<=900,'resposta sempre dentro da tela');
      await page.evaluate(()=>{for(let i=0;i<5;i++) aparenciaCentral('mais');});
      await page.waitForFunction(()=>Number(localStorage.getItem('zenithFonte'))===150);
      const ampliado=await page.getByRole('button',{name:'Enviar',exact:true}).boundingBox();
      await page.screenshot({path:path.join(destino,`central-beniboy-ampliado-${largura}.png`),fullPage:true});
      assert.ok(ampliado && ampliado.y+ampliado.height<=901,`fonte ampliada mantém Enviar acessível (${largura}: ${JSON.stringify(ampliado)})`);
      await page.evaluate(()=>{for(let i=0;i<5;i++) aparenciaCentral('menos');});
      await page.waitForFunction(()=>Number(localStorage.getItem('zenithFonte'))===100);
      assert.deepEqual(erros,[]);
      await page.screenshot({path:path.join(destino,`central-beniboy-${largura}-${tema}.png`),fullPage:true});
      // A mesma página não pode mostrar conversas para quem não tem a seção.
      await page.route('**/api/me',route=>route.fulfill({json:{id:'sem-acesso',role:'user',permissions:{sections:[]}}}));
      liberarBeniboy=false;
      await page.reload();
      await page.locator('#sem-acesso').waitFor({state:'visible'});
      assert.equal(await page.locator('#root').isVisible(),false);
      await page.close();
    }
    console.log('✓ Central Beniboy: desktop/tablet/celular, filtros, abas, rascunhos, envio, contexto, rede e sabotagem.');
  } finally {await navegador.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

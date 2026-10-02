// Navegador real, API simulada: não usa dados nem executa ações de produção.
const {chromium}=require('playwright');const http=require('http');const fs=require('fs');const path=require('path');const assert=require('assert/strict');
let perfil={role:'master',qaMaster:false};let enviada=null;
const pedido={id:'teste',origem:'cowork',tipo:'cowork.executar',status:'pendente',resumo:'Ajustar permissões · Colaborador',revisao:'revisao-teste',criadoEm:new Date().toISOString(),detalhes:[{rotulo:'Acesso',valor:'colaborador@teste.local'},{rotulo:'Depois',valor:JSON.stringify({permissions:{sections:['tarefas'],unidades:['Loja A']},cargos:['operador']})}]};
const raiz=path.join(__dirname,'public');
const srv=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://teste');
  const json=(x,st=200)=>{res.writeHead(st,{'content-type':'application/json'});res.end(JSON.stringify(x));};
  if(u.pathname==='/api/me')return json({id:'m',nome:'Master',username:'master',permissions:{sections:[]},...perfil});
  if(u.pathname==='/api/stream'){res.writeHead(200,{'content-type':'text/event-stream'});return;}
  if(u.pathname.startsWith('/api/qa-aprovacoes')){
    if(perfil.role!=='master'||perfil.qaMaster)return json({},403);
    if(u.pathname.endsWith('/aprovar')){let b='';req.on('data',x=>b+=x);req.on('end',()=>{enviada=JSON.parse(b);json({...pedido,status:'aprovado'})});return;}
    return json(u.pathname.endsWith('/resumo')?{pendentes:1}:[pedido]);
  }
  if(u.pathname.startsWith('/api/'))return json(/\/(config|contexto|status|resumo|disponivel)$/.test(u.pathname)?{}:[]);
  let f=path.join(raiz,u.pathname);if(!path.extname(f))f+='.html';
  if(!f.startsWith(raiz+path.sep)||!fs.existsSync(f)){res.writeHead(404);res.end();return;}
  res.setHeader('content-type',f.endsWith('.js')?'text/javascript':f.endsWith('.html')?'text/html':f.endsWith('.css')?'text/css':'application/octet-stream');
  if(process.env.SABOTAR_AUTORIZACOES==='1'&&u.pathname==='/nav-menu.js')return res.end(fs.readFileSync(f,'utf8').replace('if (it.masterDeVerdade) return isMaster && !me.qaMaster;','if (it.masterDeVerdade) return true;'));
  fs.createReadStream(f).pipe(res);
});
(async()=>{
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH});
  try{
    for(const width of [390,1280]){
      const ctx=await browser.newContext({viewport:{width,height:900}});await ctx.addInitScript(()=>localStorage.setItem('authToken','teste'));
      const pg=await ctx.newPage();const erros=[];pg.on('pageerror',e=>erros.push(e.message));
      const url='http://127.0.0.1:'+srv.address().port;
      perfil={role:'master',qaMaster:false};
      await pg.goto(url+'/painel');await pg.locator('#atalho-autorizacoes').waitFor();
      await pg.waitForFunction(()=>document.querySelector('#atalho-autorizacoes')?.textContent.includes('1 pendente'));
      assert((await pg.locator('#nav-autorizacoes').getAttribute('class')).includes('hidden')===false);
      assert.equal(await pg.locator('#nmz-aut-conta').textContent(),'(1)');
      assert(await pg.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      for(const p of [{role:'master',qaMaster:true},{role:'user',qaMaster:false}]){
        perfil=p;await pg.goto(url+'/painel');await pg.waitForFunction(()=>document.getElementById('nav-autorizacoes'));
        assert.equal(await pg.locator('#atalho-autorizacoes').count(),0);
        assert((await pg.locator('#nav-autorizacoes').getAttribute('class')).includes('hidden'));
      }
      perfil={role:'master',qaMaster:false};await pg.goto(url+'/autorizacoes');await pg.locator('#inp-teste').waitFor();
      assert.equal(await pg.locator('.detalhes details[open]').count(),0);
      assert((await pg.locator('.detalhes').innerText()).includes('Unidades: Loja A'));
      await pg.locator('#inp-teste').fill('senha-simulada');await pg.getByRole('button',{name:'Autorizar com a senha',exact:true}).click();
      await pg.locator('.feito.ok').waitFor();assert.equal(enviada.revisao,pedido.revisao);
      assert.deepEqual(erros,[]);await ctx.close();
    }
    console.log('✓ Interface celular/desktop: Master vê menu/contador/atalho, QA e usuário não; JSON recolhido e confirmação envia a revisão exibida');
  }finally{await browser.close();await new Promise(r=>srv.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;srv.close();});

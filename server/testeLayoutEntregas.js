// Navegador real, somente respostas locais de teste: nunca acessa produção.
const assert=require('assert/strict');
const fs=require('fs'); const path=require('path');
const {chromium}=require('playwright');
(async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
  try{
    for(const width of [390,1366]){
      const page=await browser.newPage({viewport:{width,height:900}});
      await page.addInitScript(()=>localStorage.setItem('authToken','teste'));
      const regra={unidade:'Teste',modo:'fixo',entregadoresFixos:['Pedro Silva'],empresas:[],regraCoop:{ativo:false},regraKm:{ativo:false},camposValor:[{campo:'entrega',label:'ENTREGA',base:'entrega',destino:'valor',valorPadrao:8}]};
      await page.route('**/*',async route=>{
        const u=new URL(route.request().url());
        if(u.pathname.startsWith('/api/')){
          let body=[];
          if(u.pathname==='/api/me')body={id:'master',role:'master',email:'master@teste',permissions:{sections:[]}};
          if(u.pathname==='/api/meta/unidades')body=[{codigo:'Teste',nome:'Unidade teste'}];
          if(u.pathname==='/api/entregas/regras')body=[regra];
          return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
        }
        let arquivo=path.join(__dirname,'public',u.pathname);
        if(!path.extname(arquivo))arquivo+='.html';
        if(!arquivo.startsWith(path.join(__dirname,'public'))||!fs.existsSync(arquivo))return route.fulfill({status:404,body:''});
        return route.fulfill({contentType:arquivo.endsWith('.html')?'text/html':arquivo.endsWith('.js')?'application/javascript':'application/octet-stream',body:fs.readFileSync(arquivo)});
      });
      await page.goto('http://teste.local/entrega-lancamento');
      await page.locator('#f-entregador-fixo').selectOption('Pedro Silva');
      await page.locator('#f-entrega').fill('10');
      await page.locator('#f-extra').fill('3');
      await page.locator('#f-retorno').fill('2');
      if(process.argv.includes('--sabotar')) await page.locator('#wrap-total-receber').evaluate(e=>e.style.order='-1');
      const r=await page.evaluate(()=>{
        const q=document.getElementById('wrap-quantidade-total').getBoundingClientRect(),v=document.getElementById('wrap-total-receber').getBoundingClientRect();
        return {lado:q.right<=v.left+1,mesmaLinha:Math.abs(q.bottom-v.bottom)<2,total:document.getElementById('f-quantTotal').value,
          extra:document.getElementById('f-obsExtra').checkValidity(),retorno:document.getElementById('f-obsRetorno').checkValidity(),
          scroll:document.documentElement.scrollWidth>innerWidth+1,texto:document.getElementById('secao-valores-detalhados').textContent};
      });
      assert(r.lado&&r.mesmaLinha,'Quantidade deve ficar à esquerda do valor, na mesma linha');
      assert.equal(r.total,'15'); assert(!r.extra&&!r.retorno,'Observações obrigatórias'); assert(!r.scroll,'Não pode haver rolagem horizontal');
      assert(!r.texto.includes('(calculado)')&&!r.texto.includes('Entregas + Extra + Retorno'));
      await page.locator('#f-obsExtra').fill('Bairro distante'); await page.locator('#f-obsRetorno').fill('Cliente ausente');
      assert(await page.locator('#f-obsExtra').evaluate(e=>e.checkValidity()));
      await page.screenshot({path:path.join(__dirname,'../docs/varredura/atual/entrega-layout.'+(width===390?'celular':'desktop')+'.png'),fullPage:true});
      await page.close();
    }
    console.log('✓ Navegador: totais lado a lado, quantidade 15, observações condicionais, sem textos excedentes e sem rolagem horizontal');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const {chromium}=require('playwright');
const raiz=__dirname;
const html=fs.readFileSync(path.join(raiz,'public/entrega-lancamento.html'),'utf8');
const dashboard=fs.readFileSync(path.join(raiz,'public/entregas.html'),'utf8');
for(const h of [html,dashboard])for(const s of h.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(s[1]);
const codigo=html.slice(html.indexOf('function resumoUltimoDia('),html.indexOf('function detalhesLancamentos('));
const analise=require('./public/entregas-analise');
const exemplo=[
  {id:'antigo',data:'2026-10-07',criadoEm:'2026-10-08T18:00:00Z',unidade:'A',entregador:'Diego',entrega:99,valor:999},
  ...Array.from({length:35},(_,i)=>({id:'dia'+i,data:'2026-10-08',criadoEm:'2026-10-08T19:00:00Z',unidade:'A',unidadeNome:'DOMINOS BESSA',entregador:'Diego',entrega:1,retorno:1,extra:1,quantTotal:3,valor:10})),
  {id:'manual',data:'2026-10-08',criadoEm:'2026-10-08T20:00:00Z',unidade:'B',unidadeNome:'DOMINOS CARUARU',entregador:'Nome muito longo para conferir a quebra de linha',entrega:10,retorno:8,extra:9,valorEntregas:100,valor:120},
  {id:'cancelado',data:'2026-10-08',criadoEm:'2026-10-08T19:30:00Z',unidade:'A',entregador:'Diego',entrega:500,valor:500,situacao:'CANCELADO'},
];
function conferir(fonte){
  const ctx=vm.createContext({EntregasAnalise:analise});vm.runInContext(fonte,ctx);
  const resumo=ctx.resumoUltimoDia(exemplo);
  assert.equal(resumo.data,'2026-10-08');assert.equal(resumo.linhas.length,2);
  assert.equal(resumo.quantidade,115);assert.equal(resumo.valor,470);
  assert.equal(resumo.linhas[0].registros.length,36);
  assert.equal(ctx.resumoUltimoDia([]).linhas.length,0);
  const retroativo=ctx.resumoUltimoDia([...exemplo,{data:'2026-10-06',criadoEm:'2026-10-08T21:00:00Z',unidade:'A',entregador:'Robert',entrega:2,valor:20}]);
  assert.equal(retroativo.data,'2026-10-06');assert.equal(retroativo.quantidade,2);
}
conferir(codigo);
for(const sabotada of [codigo.replace('r.data===ultimo?.data','true'),codigo.replace("if(['CANCELADO','EXCLUIDO'].includes(f.situacao))continue;",''),codigo.replace('normalizado.entrega','Number(f.entrega)')])assert.throws(()=>conferir(sabotada));
assert.doesNotMatch(html,/\.slice\(0,30\)/);
assert.doesNotMatch(dashboard,/<th>Bônus<\/th>|<th>Valor Gami<\/th>/);
const servidor=fs.readFileSync(path.join(raiz,'index.js'),'utf8');
const relatorios=servidor.slice(servidor.indexOf('function prepararEntregasPorEntregador('),servidor.indexOf('async function todasEntregasPermitidas('));
assert.doesNotMatch(relatorios,/key: 'bonus', label:/);
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  try{
    const render=html.slice(html.indexOf('function renderLista('),html.indexOf('function resumoUltimoDia('));
    for(const width of [320,390,768,1280,1920]){
      const page=await browser.newPage({viewport:{width,height:900}});
      await page.setContent(`<style>${html.match(/<style>([\s\S]*?)<\/style>/)[1]}</style><section class="panel"><h2>Resumo do último dia lançado</h2><div id="lista-lancamentos"></div></section>`);
      await page.addScriptTag({content:fs.readFileSync(path.join(raiz,'public/entregas-analise.js'),'utf8')});
      await page.addScriptTag({content:`const MEUS=${JSON.stringify(exemplo)};const escapeHtml=v=>String(v||'').replaceAll('<','&lt;');const fmtData=v=>v;const fmtMoney=v=>'R$ '+Number(v).toFixed(2);const detalhesLancamentos=()=>'<button type="button">Editar lançamento</button>';${codigo}${render};renderLista();`});
      assert.equal(await page.locator('thead th').count(),4);
      assert.equal(await page.locator('tbody tr').count(),2);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`Sem estouro: ${width}`);
      await page.locator('summary').first().click();
      assert.equal(await page.locator('details').first().evaluate(e=>e.open),true);
      await page.close();
    }
  }finally{await browser.close()}
  console.log('OK: último dia, agrupamento, >30 registros, totais normalizados, cancelados, retroativo, 4 colunas, sem bônus, 320–1920px e sabotagens.');
})().catch(e=>{console.error(e);process.exitCode=1});

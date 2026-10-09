'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const ler=nome=>fs.readFileSync(path.join(__dirname,nome),'utf8');
const fonte=ler('entregasRegras.js');
const saneamento=fonte.slice(fonte.indexOf('function sanitizarMeta('),fonte.indexOf('function sanitizarEntregadoresFixos('));
const calculo=fonte.slice(fonte.indexOf('function diaSemanaDe('),fonte.indexOf('module.exports ='));
function testar(codigo){
  const ctx=vm.createContext({DIAS_SEMANA:['dom','seg','ter','qua','qui','sex','sab'],num:v=>Number(v)||0,calcularCoop:()=>0,configuracaoCoop:()=>({ativo:false})});
  vm.runInContext(saneamento+codigo,ctx);
  const meta=ctx.sanitizarMeta({ativo:true,baseContagem:'entrega',minimo:10,valorParcial:15,diasSemMinimo:['sab','dom','sab','invalido']});
  assert.equal(JSON.stringify(meta.diasSemMinimo),'["dom","sab"]');
  const regra={camposValor:[{campo:'ajudaCusto',label:'Ajuda de custo',base:'flat',valorPadrao:30,meta}]};
  const valor=(data,entrega=2)=>ctx.calcular(regra,{data,entrega}).ajudaCusto;
  assert.equal(valor('2026-10-10'),30);assert.equal(valor('2026-10-11'),30);
  assert.equal(valor('2026-10-09'),15);assert.equal(valor('2026-10-09',10),30);
  assert.equal(valor('2026-10-10',0),30);
  regra.camposValor[0].valoresPorDiaSemana={sab:40};assert.equal(valor('2026-10-10'),40);
  regra.camposValor[0].meta={baseContagem:'entrega',minimo:10,valorParcial:15};assert.equal(valor('2026-10-10'),15,'Regra antiga permanece igual');
  assert.equal(ctx.calcular(regra,{data:'2026-10-10',entrega:2,camposRemovidos:['ajudaCusto']}).valor,0);
  assert.equal(ctx.sanitizarMeta({ativo:true,diasSemMinimo:'sab'}).diasSemMinimo.length,0);
}
testar(calculo);assert.throws(()=>testar(calculo.replace("c.meta && !(c.meta.diasSemMinimo || []).includes(dia)",'c.meta')));
const pagina=ler('public/entrega-lancamento.html'),regras=ler('public/entregas-regras.html');
for(const h of [pagina,regras])for(const s of h.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(s[1]);
assert.match(pagina,/if\(c.meta && !\(c.meta.diasSemMinimo \|\| \[\]\).includes\(dia\)\)/);
assert.match(regras,/diasSemMinimo:.*data-meta-dia.*checked/);
assert.match(regras,/c.meta\?\.diasSemMinimo/);
console.log('OK: sábado/domingo fixos, dias úteis com mínimo, valor por dia, zero entregas, regras antigas, campos removidos, saneamento e sabotagem.');

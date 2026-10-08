'use strict';
const fs=require('fs');
const vm=require('vm');
const assert=require('assert/strict');
const html=fs.readFileSync(require('path').join(__dirname,'public/beniboy.html'),'utf8');
for(const bloco of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(bloco[1]);
const trecho=html.slice(html.indexOf('function chaveComputador('),html.indexOf('function computadorSelecionado('));
async function verificar(fonte){
  const elementos=new Map();
  const document={getElementById(id){
    if(!elementos.has(id)) elementos.set(id,{value:'',innerHTML:'',classList:{toggle(){}}});
    return elementos.get(id);
  }};
  const contexto=vm.createContext({document,escapeHtml:v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),trocarUnidadeComputador(){},carregarConversaComputador:async()=>{}});
  vm.runInContext(`let COMPUTADORES_CENTRAL=[{codigo:'A',posto:'PDV',nome:'Caixa <1>',unidadeNome:'Loja A'},{codigo:'B',posto:'PDV',nome:'Caixa B',unidadeNome:'Loja B'}];let COMPUTADORES_NOVOS=new Set(['A::PDV','B::PDV','C::Servidor']);let COMPUTADOR_ATIVO=null,COMPUTADOR_DETALHE=null;${fonte}`,contexto);
  vm.runInContext('renderPendentesComputadores()',contexto);
  const cards=document.getElementById('computadores-pendentes').innerHTML;
  assert.equal((cards.match(/class="computador-pendente"/g)||[]).length,3);
  assert.ok(cards.includes('Caixa &lt;1&gt;')&&cards.includes('Loja A')&&cards.includes('Loja B')&&cards.includes('Servidor'));
  assert.ok(cards.includes('data-codigo="B" data-posto="PDV"'));
  await vm.runInContext("abrirPendenteComputador('B','PDV')",contexto);
  assert.equal(vm.runInContext('COMPUTADOR_ATIVO.codigo',contexto),'B');
  assert.equal(document.getElementById('computador-unidade').value,'B');
  assert.equal(document.getElementById('computador-posto').value,'PDV');
  // Abrir não apaga o aviso antes de o GET da conversa ter sucesso.
  assert.equal(vm.runInContext('COMPUTADORES_NOVOS.size',contexto),3);
}
(async()=>{
  await verificar(trecho);
  for(const quebrado of [trecho.replace('[...COMPUTADORES_NOVOS]','[]'),trecho.replace('COMPUTADOR_ATIVO={codigo,posto}','COMPUTADOR_ATIVO={codigo:"A",posto}')]){
    await assert.rejects(()=>verificar(quebrado));
  }
  assert.match(html,/COMPUTADOR_DETALHE=dados;\s*COMPUTADORES_NOVOS.delete/);
  console.log('OK: cards pendentes, identificação por unidade/máquina, abertura direta, aviso até sucesso, sintaxe e duas sabotagens.');
})().catch(e=>{console.error(e);process.exitCode=1;});

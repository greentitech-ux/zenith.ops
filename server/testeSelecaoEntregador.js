// Executa a lógica real da tela sem Firestore ou dados de produção.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
let html = fs.readFileSync(__dirname+'/public/entrega-lancamento.html','utf8');
if(process.argv.includes('--sabotagem')) html=html.replace("campos.classList.toggle('hidden', !selecionado)","campos.classList.toggle('hidden', false)");
const elementos = new Map();
function elemento(id){
  if(!elementos.has(id)){
    const classes=new Set();
    elementos.set(id,{value:'',disabled:false,handlers:{},classList:{contains:c=>classes.has(c),add:c=>classes.add(c),toggle:(c,ativo)=>ativo?classes.add(c):classes.delete(c)},setCustomValidity(){},addEventListener(nome,fn){this.handlers[nome]=fn;}});
  }
  return elementos.get(id);
}
let total=false, selecionadoTotal=null;
const ctx={document:{getElementById:elemento},ehModeloTotal:()=>total,entregadorSelecionado:()=>selecionadoTotal,
  textoParaBusca:s=>String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(),abrirOpcoesRecebedor(){}};
vm.createContext(ctx);
vm.runInContext(html.slice(html.indexOf('function temRecebedorSelecionado(){'),html.indexOf('function atualizarSugestao(){')),ctx);
ctx.atualizarModoRecebedor=()=>ctx.atualizarCamposAposSelecao();
const selecionador=elemento('f-entregador-fixo'),busca=elemento('f-entregador-filtro'),livre=elemento('f-entregador'),campos=elemento('campos-apos-entregador');
livre.classList.add('hidden');
function conferir(visivel){assert.equal(ctx.atualizarCamposAposSelecao(),visivel);assert.equal(campos.classList.contains('hidden'),!visivel);assert.equal(campos.disabled,!visivel);}
conferir(false); // nasce recolhido e controles fora da validação do formulário
busca.value='Luan';conferir(false); // digitar não é selecionar
selecionador.value='Luan';conferir(true);
selecionador.value='MOOVERY JANTA';busca.value='MOOVERY JANTA';conferir(true);
const inicio=html.indexOf("document.getElementById('f-entregador-filtro').addEventListener('input',");
const fim=html.indexOf("document.getElementById('f-entregador-filtro').addEventListener('blur',",inicio);
vm.runInContext(html.slice(inicio,fim),ctx);
busca.value='';busca.handlers.input();assert.equal(selecionador.value,'');conferir(false);
selecionador.value='Luís';busca.value='luis';conferir(true);
busca.value='Outro';busca.handlers.input();conferir(false);
total=true;conferir(false);selecionadoTotal={nome:'Luan'};conferir(true);
selecionadoTotal=null;elemento('f-entregador-campina').handlers.change();conferir(false);
total=false;livre.classList.toggle('hidden',false);livre.value='  ';conferir(false);
livre.value='Entregador legado';livre.handlers.input();conferir(true);
livre.value='';livre.handlers.input();conferir(false);
assert.match(html,/<fieldset id="campos-apos-entregador" class="hidden" disabled/);
const bloco=html.slice(html.indexOf('<fieldset id="campos-apos-entregador"'),html.indexOf('</fieldset>'));
for(const id of ['campos-detalhados-entrega','campos-total-campina','secao-valores-detalhados','f-etiqueta','f-observacao','btn-enviar']) assert.ok(bloco.includes('id="'+id+'"'));
assert.match(html,/if\(!atualizarCamposAposSelecao\(\)\) return;/);
console.log('OK: campos recolhidos até selecionar, empresa, pesquisa sem seleção, limpar, modelo total e legado.');

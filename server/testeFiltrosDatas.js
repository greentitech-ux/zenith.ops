// Regressão no navegador dos seletores de período com o tema.js real.
// Não acessa produção: as páginas de teste e APIs são interceptadas localmente.
// NODE_PATH pode apontar para a instalação de Playwright; usa Edge no Windows.
// --sabotagem remove a proteção para provar que o defeito é detectado.
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { chromium } = require('playwright');
const raiz = path.join(__dirname, 'public');
const sabotagem = process.argv.includes('--sabotagem');
const casos = [
  {tela:'tarefas', de:'F-DE', ate:'F-ATE', painel:'PRESETS', funcs:['calcularPreset','montarPresets','aplicarPreset','aoMudarData'], iniciar:'montarPresets()', mes:"aplicarPreset('mes')"},
  {tela:'central-historico', de:'filtro-data-de', ate:'filtro-data-ate', painel:'presets-periodo-central', funcs:['calcularPresetPeriodoCentral','aplicarPresetPeriodoCentral','aoMudarPeriodoCentral','montarPresetsPeriodoCentral'], iniciar:'montarPresetsPeriodoCentral()', mes:"aplicarPresetPeriodoCentral('mes')"},
  {tela:'formularios', de:'filtro-data-de-lista', ate:'filtro-data-ate-lista', painel:'presets-periodo-lista', funcs:['calcularPresetPeriodoLista','aplicarPresetPeriodoLista','aoMudarPeriodoLista','montarPresetsPeriodoLista'], iniciar:'montarPresetsPeriodoLista()', mes:"aplicarPresetPeriodoLista('mes')"},
  {tela:'tecnico', de:'filtro-data-de-tecnico', ate:'filtro-data-ate-tecnico', painel:'presets-periodo-tecnico', funcs:['calcularPresetPeriodoTecnico','aplicarPresetPeriodoTecnico','aoMudarPeriodoTecnico','montarPresetsPeriodoTecnico'], iniciar:'montarPresetsPeriodoTecnico()', mes:"aplicarPresetPeriodoTecnico('mes')"},
  {tela:'entregas', de:'f-date-start', ate:'f-date-end', painel:'presets', funcs:['calcularPreset','setupPresets'], iniciar:'setupPresets()'},
  {tela:'ifood', de:'f-date-start', ate:'f-date-end', painel:'presets', funcs:['calcularPreset','setupPresets'], iniciar:"setupPresets('2026-10-01')", bloco:true},
  {tela:'fechamentos', de:'f-date-start', ate:'f-date-end', painel:'presets', funcs:['calcularPreset','setupPresets'], iniciar:'setupPresets()', bloco:true},
  {tela:'fechamentos', de:'fech-date-inicio', ate:'fech-date-fim', painel:'fech-presets', funcs:['calcularPreset','setupPresetsFech'], iniciar:'setupPresetsFech()', bloco:true},
  {tela:'estoque', de:'d-inicio', ate:'d-fim', painel:'d-presets', funcs:['calcularPreset','renderPresetsDif','aplicarPresetDif','limparPresetAtivo'], iniciar:'renderPresetsDif()', mes:"aplicarPresetDif('mes')"},
  {tela:'estoque', de:'h-inicio', ate:'h-fim', painel:'h-presets', funcs:['calcularPreset','renderPresetsHist','aplicarPresetHist','limparPresetHist'], iniciar:'renderPresetsHist()', mes:"aplicarPresetHist('mes')"},
  {tela:'saidas', de:'f-data-de', ate:'f-data-ate', painel:'presets', funcs:['calcularPreset','setupPresets','presetCorrespondenteAsDatas','sincronizarPresetComDatas','aplicarPreset','aoMudarFiltroData'], iniciar:'setupPresets()', mes:"aplicarPreset('mes')"},
  {tela:'kpis-operacionais', de:'f-inicio', ate:'f-fim', painel:null, funcs:['sincronizarPeriodo','marcarPresetManual','aplicarPreset'], iniciar:'', mes:"aplicarPreset('mes')"},
];
function funcao(html, nome) {
  // As funções de filtro do projeto têm corpo numa linha ou fecham na coluna 0.
  const linha = html.match(new RegExp('^function '+nome+'\\([^\\n]*\\}\\r?$', 'm'));
  if(linha) return linha[0];
  const bloco = html.match(new RegExp('^function '+nome+'\\([\\s\\S]*?^\\}', 'm'));
  if(!bloco) throw new Error('Função ausente: '+nome);
  return bloco[0];
}
function fixture(caso) {
  const html = fs.readFileSync(path.join(raiz, caso.tela+'.html'), 'utf8');
  const tag = id => {
    const match = html.match(new RegExp('<[^>]+\\bid="'+id+'"[^>]*>'));
    if(!match) throw new Error('Controle ausente: '+id);
    return match[0];
  };
  const painel = caso.painel ? tag(caso.painel)+'</div>' : '<div class="filtros" data-zenith-sem-mes="1"><button data-preset="mes" onclick="aplicarPreset(\'mes\')">Mês</button></div>';
  const nomes = caso.tela==='estoque' ? [...caso.funcs,'recuarMeses'] : caso.funcs;
  let fonte = nomes.map(nome=>funcao(html,nome)).join('\n');
  if(sabotagem) fonte = fonte.replace(/if\((presetAtivo|aceso) && evento\.type === 'input'\) return;/g,'');
  const suporte = `
    const $=id=>document.getElementById(id);
    const FUSO_BR='America/Sao_Paulo', FUSO_BR_LISTA=FUSO_BR;
    const pad2=n=>String(n).padStart(2,'0');
    const isoLocal=d=>d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate());
    const agoraBrasilia=()=>new Date('2026-10-02T12:00:00');
    const hoje=()=>isoLocal(agoraBrasilia()), hojeBrasilia=hoje;
    const isoDe=isoLocal, iso=isoLocal;
    let presetAtivo=null, filtroDataAtivo=false, PRESET_ATIVO=null, HIST_PRESET=null, PRESET=null;
    let FILTRO_DATA_DE_TECNICO='', FILTRO_DATA_ATE_TECNICO='';
    const PRESETS=[['tudo','Tudo'],['hoje','Hoje'],['ontem','Ontem'],['semana','Semana'],['mes','Mês']];
    const ROTULOS_PRESET={ontem:'Ontem',semana:'Semana',mes:'Mês',trimestre:'Trimestre'};
    const render=()=>{},renderLista=render,renderEspelhando=render,renderTabela=render,renderTudo=render,carregar=render;
    const aplicarFiltrosExtra=render,aplicarFiltrosLista=render,carregarDiferencas=render,carregarHistorico=render;
    const soltarFocoDeData=()=>document.activeElement?.blur();
    ${fonte}
    ${caso.iniciar};
  `;
  const conteudo = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><script src="/tema.js"></script></head><body>
    <main><label>De ${tag(caso.de)}</label><label>Até ${tag(caso.ate)}</label>${painel}</main>
    <script>${suporte}</script></body></html>`;
  return sabotagem ? conteudo.replace(/ data-zenith-sem-mes="1"/g,'') : conteudo;
}
async function testar(browser, caso) {
  const contexto = await browser.newContext({timezoneId:'America/Sao_Paulo'});
  const pagina = await contexto.newPage();
  await pagina.route('http://filtros.local/**', route=>{
    const url = new URL(route.request().url());
    if(url.pathname==='/teste') return route.fulfill({contentType:'text/html',body:fixture(caso)});
    if(url.pathname==='/tema.js') return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.join(raiz,'tema.js'))});
    return route.fulfill({contentType:'application/json',body:'{}'});
  });
  const erros=[];
  pagina.on('pageerror', e=>erros.push(e.message));
  try {
    await pagina.goto('http://filtros.local/teste');
    if(caso.mes) await pagina.evaluate(codigo=>eval(codigo),caso.mes);
    else await pagina.locator('#'+caso.painel+' [data-tipo="mes"]').click();
    // Usa o botão real: o listener em captura do tema recebe o mesmo clique.
    const mes = caso.painel ? pagina.locator('#'+caso.painel+' button').filter({hasText:/^Mês$/}) : pagina.locator('[data-preset="mes"]');
    await mes.click();
    if(!caso.bloco && caso.tela==='estoque') await mes.click();
    // Antes de confirmar: input não pode reescrever nenhum lado nem tirar foco.
    const inicio = await pagina.locator('#'+caso.de).inputValue();
    await pagina.evaluate(id=>{
      const campo=document.getElementById(id); campo.focus(); campo.value='2026-09-22';
      campo.dispatchEvent(new Event('input',{bubbles:true}));
    },caso.ate);
    assert.equal(await pagina.locator('#'+caso.ate).inputValue(),'2026-09-22','Até foi reescrito durante a seleção');
    assert.equal(await pagina.locator('#'+caso.de).inputValue(),inicio,'De mudou durante a edição de Até');
    // Confirma a seleção pelo navegador, exercitando os handlers reais.
    await pagina.locator('#'+caso.ate).dispatchEvent('change');
    await pagina.waitForTimeout(50);
    const esperado=caso.bloco?'2026-09-30':'2026-09-22';
    assert.equal(await pagina.locator('#'+caso.ate).inputValue(),esperado,'Até não preservou o dia/período confirmado');
    if(!caso.bloco){
      await pagina.locator('#'+caso.de).fill('2026-09-01');
      await pagina.locator('#'+caso.de).dispatchEvent('change');
      await pagina.waitForTimeout(50);
      assert.equal(await pagina.locator('#'+caso.ate).inputValue(),esperado,'Editar De alterou Até');
      if(caso.painel) assert.equal(await pagina.locator('#'+caso.painel+' .active').count(),0,'Mês voltou a acender sozinho');
    }
    assert.deepEqual(erros,[],'Erro de JavaScript no filtro');
    console.log('✓ '+caso.tela+' · '+caso.de+'/'+caso.ate);
  } finally { await contexto.close(); }
}
(async()=>{
  const browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})});
  let falhas=0;
  try {
    for(const caso of casos){
      try{await testar(browser,caso);}catch(e){falhas++;console.error('✗ '+caso.tela+' · '+caso.ate+': '+e.message);}
    }
  } finally {await browser.close();}
  console.log(`${casos.length-falhas}/${casos.length} filtros aprovados`);
  process.exitCode=falhas?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});

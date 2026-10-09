// Filtros locais são livres. Só uma ação no Resumo volta a sincronizá-los.
const ANALISE=EntregasAnalise;
let FILTROS_INICIADOS=false;
let atualizarOpcoesResumo=()=>{};
const FILTROS_SECOES={entregadores:null,unidades:null,lancamentos:null,grafico:null};
const DIAS_ENTREGAS=['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'];
const PRESETS_ENTREGAS=[['hoje','Hoje'],['ontem','Ontem'],['30dias','30 dias'],['semana','Semana'],['mes','Mês'],['trimestre','Trimestre'],['ano','Ano']];
function filtroResumo(){return {inicio:document.getElementById('f-date-start').value,fim:document.getElementById('f-date-end').value,unidades:[...SEL_UNIDADE],nome:document.getElementById('f-nome').value.trim(),dia:document.getElementById('f-dia-semana').value};}
function aplicarFiltroResumo(){
  ANALISE.sincronizar(filtroResumo(),FILTROS_SECOES);
  for(const chave of Object.keys(FILTROS_SECOES)) desenharFiltroSecao(chave);
  render();
}
function opcoesDias(){return '<option value="">Todos os dias da semana</option>'+DIAS_ENTREGAS.map((d,i)=>`<option value="${i}">${d}</option>`).join('');}
function iniciarFiltrosSecoes(){
  const resumo=filtroResumo();
  ANALISE.sincronizar(resumo,FILTROS_SECOES);
  FILTROS_SECOES.grafico={...resumo,...ANALISE.periodo('30dias',isoLocal(agoraBrasilia()))};
  document.getElementById('f-dia-semana').innerHTML=opcoesDias();
  for(const id of ['f-nome','f-dia-semana'])document.getElementById(id).addEventListener('input',aplicarFiltroResumo);
  for(const chave of Object.keys(FILTROS_SECOES)){
    const cont=document.getElementById('filtros-'+chave);
    cont.addEventListener('input',e=>{
      const f=FILTROS_SECOES[chave];
      if(e.target.dataset.filtro){f[e.target.dataset.filtro]=e.target.value;}
      if(e.target.dataset.unidade){f.unidades=[...cont.querySelectorAll('[data-unidade]:checked')].map(c=>c.value);}
      cont.querySelector('.filtro-vinculo').textContent='Filtro próprio · livre do Resumo';
      atualizarTituloUnidades(cont,f);
      render();
    });
    cont.addEventListener('click',e=>{
      const preset=e.target.closest('[data-periodo]');
      if(preset){Object.assign(FILTROS_SECOES[chave],ANALISE.periodo(preset.dataset.periodo,isoLocal(agoraBrasilia())));desenharFiltroSecao(chave,true);render();}
      if(e.target.closest('[data-resumo]')){FILTROS_SECOES[chave]=ANALISE.copiar(filtroResumo());desenharFiltroSecao(chave);render();}
      if(e.target.closest('[data-todas]')){FILTROS_SECOES[chave].unidades=[];desenharFiltroSecao(chave,true);render();}
      if(e.target.closest('[data-limpar]')){FILTROS_SECOES[chave]={...ANALISE.periodo(chave==='grafico'?'30dias':'ontem',isoLocal(agoraBrasilia())),unidades:[],nome:'',dia:''};desenharFiltroSecao(chave,true);render();}
    });
    desenharFiltroSecao(chave,chave==='grafico');
  }
  for(const id of ['grafico-metrica','grafico-comparar'])document.getElementById(id).addEventListener('change',renderGraficoEntregas);
}
function atualizarTituloUnidades(cont,f){cont.querySelector('summary').textContent=f.unidades.length?`${f.unidades.length} unidade(s)`:'Todas as unidades';}
function desenharFiltroSecao(chave,livre=false){
  const f=FILTROS_SECOES[chave],cont=document.getElementById('filtros-'+chave);
  cont.innerHTML=`<div class="presets">${PRESETS_ENTREGAS.map(([tipo,lbl])=>`<button type="button" class="preset-btn" data-periodo="${tipo}">${lbl}</button>`).join('')}</div>
    <label>De<input type="date" data-filtro="inicio" value="${escapeHtml(f.inicio)}"></label>
    <label>Até<input type="date" data-filtro="fim" value="${escapeHtml(f.fim)}"></label>
    <details class="filtro-unidades"><summary>Todas as unidades</summary><div><button type="button" class="preset-btn" data-todas>Todas as unidades</button>${codigosDisponiveis().map(c=>`<label><span>${escapeHtml(UNIDADES_NOMES[c]||c)}</span><input type="checkbox" data-unidade="1" value="${escapeHtml(c)}" ${f.unidades.includes(c)?'checked':''}></label>`).join('')}</div></details>
    <label>Nome<input type="search" data-filtro="nome" value="${escapeHtml(f.nome)}" placeholder="Pesquisar entregador ou empresa"></label>
    <label>Dia da semana<select data-filtro="dia">${opcoesDias()}</select></label>
    <button type="button" class="preset-btn" data-resumo>Usar filtro do Resumo</button><button type="button" class="preset-btn" data-limpar>Limpar filtros</button><span class="filtro-vinculo">${livre?'Filtro próprio · livre do Resumo':'Sincronizado com o Resumo'}</span>`;
  cont.querySelector('[data-filtro=dia]').value=f.dia;
  atualizarTituloUnidades(cont,f);
}
function linhasSecao(chave){return ANALISE.filtrar(DATA,FILTROS_SECOES[chave]||filtroResumo());}
let PONTOS_GRAFICO=[];
function inspecionarPontoGrafico(indice){
  const ponto=PONTOS_GRAFICO[indice];if(!ponto)return;
  const intervalo=p=>fmtData(p.data)+(p.fim!==p.data?' → '+fmtData(p.fim):'');
  const descrever=p=>!p?.temDados?'Sem lançamentos':`${p.entrega} entregas · ${fmtMoney(p.valor)} · TM ${p.tm==null?'—':fmtMoney(p.tm)}`;
  document.getElementById('grafico-inspecao').innerHTML=`<b>Atual · ${escapeHtml(intervalo(ponto.atual))}</b><br>${escapeHtml(descrever(ponto.atual))}<br><span class="sub">Anterior${ponto.anterior?' · '+escapeHtml(intervalo(ponto.anterior)):''}: ${escapeHtml(descrever(ponto.anterior))}</span>`;
  document.querySelectorAll('.grafico-alvo').forEach(el=>el.classList.toggle('selecionado',Number(el.dataset.ponto)===indice));
}
const graficoInterativo=document.getElementById('grafico-entregas');
for(const evento of ['pointerover','click','focusin'])graficoInterativo.addEventListener(evento,e=>{const alvo=e.target.closest('[data-ponto]');if(alvo)inspecionarPontoGrafico(Number(alvo.dataset.ponto));});
graficoInterativo.addEventListener('keydown',e=>{
  const alvo=e.target.closest('[data-ponto]');if(!alvo)return;
  if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){
    e.preventDefault();const i=Number(alvo.dataset.ponto),ultimo=PONTOS_GRAFICO.length-1;
    const proximo=e.key==='Home'?0:e.key==='End'?ultimo:Math.max(0,Math.min(ultimo,i+(e.key==='ArrowRight'?1:-1)));
    graficoInterativo.querySelector(`[data-ponto="${proximo}"]`)?.focus();
  }
});
let larguraGraficoAnterior=0;
if(typeof ResizeObserver!=='undefined')new ResizeObserver(entries=>{
  const largura=Math.round(entries[0].contentRect.width);
  if(largura===larguraGraficoAnterior)return;larguraGraficoAnterior=largura;
  requestAnimationFrame(renderGraficoEntregas);
}).observe(graficoInterativo);
function renderGraficoEntregas(){
  const filtro=FILTROS_SECOES.grafico;if(!filtro)return;
  const datas=DATA.map(r=>r.data).filter(Boolean).sort();
  const f={...filtro,inicio:filtro.inicio||datas[0]||ANALISE.periodo('30dias',isoLocal(agoraBrasilia())).inicio,fim:filtro.fim||datas.at(-1)||isoLocal(agoraBrasilia())};
  const grafico=document.getElementById('grafico-entregas'),comparativo=document.getElementById('comparativo-entregas');
  PONTOS_GRAFICO=[];
  document.getElementById('grafico-inspecao').textContent='Passe o mouse, toque ou use as setas do teclado para consultar um ponto.';
  if(!f.inicio||!f.fim||f.inicio>f.fim||(new Date(f.fim)-new Date(f.inicio))/86400000>3660){grafico.innerHTML='<div class="empty">Selecione um intervalo válido de até 10 anos.</div>';comparativo.innerHTML='';document.getElementById('grafico-detalhes').innerHTML='';return;}
  const anterior=ANALISE.comparar(f,document.getElementById('grafico-comparar').value);
  const atualRows=ANALISE.filtrar(DATA,f),antesRows=ANALISE.filtrar(DATA,anterior);
  const atual=ANALISE.somar(atualRows),antes=ANALISE.somar(antesRows);
  document.getElementById('grafico-periodo').textContent=`${fmtData(f.inicio)} → ${fmtData(f.fim)} · comparação ${fmtData(anterior.inicio)} → ${fmtData(anterior.fim)}`;
  comparativo.innerHTML=[['Entregas','entrega',v=>String(v)],['Valor pago','valor',fmtMoney],['Ticket médio','tm',fmtMoney]].map(([label,campo,fmt])=>{
    const delta=atual.registros&&antes.registros?ANALISE.variacao(atual[campo],antes[campo]):null;
    return `<div class="comparativo-card"><div class="lbl">${label}</div><strong>${atual.registros&&atual[campo]!=null?fmt(atual[campo]):'Sem dados'}</strong><div class="sub">Anterior: ${antes.registros&&antes[campo]!=null?fmt(antes[campo]):'sem dados'}</div><div class="variacao">${delta==null?'Sem base para comparar':`${delta>0?'+':''}${delta.toLocaleString('pt-BR',{maximumFractionDigits:1})}%`}</div></div>`;
  }).join('');
  if(!atualRows.length&&!antesRows.length){grafico.innerHTML='<div class="empty">Sem lançamentos nos dois períodos selecionados.</div>';document.getElementById('grafico-detalhes').innerHTML='';return;}
  const metrica=document.getElementById('grafico-metrica').value;
  let serie=ANALISE.serie(DATA,f),antesSerie=ANALISE.serie(DATA,anterior);
  // Agrupa períodos longos sem perder quantidades/valores ou fazer média de médias.
  const largura=Math.max(280,grafico.clientWidth-32);
  const limitePontos=Math.max(7,Math.min(60,Math.floor((largura-95)/32)));
  const passo=Math.max(1,Math.ceil(Math.max(serie.length,antesSerie.length)/limitePontos));
  function agrupar(s){const out=[];for(let i=0;i<s.length;i+=passo){const grupo=s.slice(i,i+passo);out.push({data:grupo[0].data,fim:grupo.at(-1).data,temDados:grupo.some(p=>p.temDados),...ANALISE.somar(grupo)});}return out;}
  serie=agrupar(serie);antesSerie=agrupar(antesSerie);
  const quantidade=Math.max(serie.length,antesSerie.length),max=Math.max(1,...serie.map(p=>p[metrica]||0),...antesSerie.map(p=>p[metrica]||0));
  const altura=300,margem=metrica==='entrega'?48:95,base=250,alto=210,espaco=(largura-margem-20)/Math.max(1,quantidade);
  const x=i=>margem+espaco*(i+.5),y=v=>base-(v||0)/max*alto;
  const formatar=metrica==='entrega'?v=>String(Math.round(v)):fmtMoney;
  let svg=`<svg viewBox="0 0 ${largura} ${altura}" role="group" aria-label="Evolução de ${metrica==='entrega'?'entregas':metrica==='valor'?'valor pago':'ticket médio'}; barras do período atual e linha tracejada do anterior"><title>Atual: ${fmtData(f.inicio)} a ${fmtData(f.fim)}. Anterior: ${fmtData(anterior.inicio)} a ${fmtData(anterior.fim)}.</title>`;
  for(let i=0;i<=4;i++){const valor=max*i/4,py=y(valor);svg+=`<line x1="${margem}" x2="${largura-20}" y1="${py}" y2="${py}" class="grafico-grade"/><text x="${margem-8}" y="${py+4}" text-anchor="end" class="grafico-eixo">${escapeHtml(formatar(valor))}</text>`;}
  serie.forEach((p,i)=>{if(p.temDados)svg+=`<rect x="${x(i)-espaco*.28}" y="${y(p[metrica])}" width="${espaco*.56}" height="${Math.max(1,base-y(p[metrica]))}" rx="2" class="grafico-barra"><title>${fmtData(p.data)}${passo>1?' a '+fmtData(p.fim):''}: ${escapeHtml(formatar(p[metrica]))}</title></rect>`;
    if(i%Math.max(1,Math.ceil(quantidade/(largura<500?4:7)))===0)svg+=`<text x="${x(i)}" y="275" text-anchor="middle" class="grafico-eixo">${fmtData(p.data).slice(0,5)}</text>`;});
  let ultimo=null;
  antesSerie.forEach((p,i)=>{if(!p.temDados){ultimo=null;return;}const ponto={x:x(i),y:y(p[metrica])};if(ultimo)svg+=`<line x1="${ultimo.x}" y1="${ultimo.y}" x2="${ponto.x}" y2="${ponto.y}" class="grafico-anterior"/>`;svg+=`<circle cx="${ponto.x}" cy="${ponto.y}" r="3" class="grafico-ponto"><title>Anterior · ${fmtData(p.data)}: ${escapeHtml(formatar(p[metrica]))}</title></circle>`;ultimo=ponto;});
  PONTOS_GRAFICO=serie.map((p,i)=>({atual:p,anterior:antesSerie[i]}));
  serie.forEach((p,i)=>{svg+=`<rect class="grafico-alvo" data-ponto="${i}" tabindex="0" role="button" aria-label="Consultar ${fmtData(p.data)}${passo>1?' a '+fmtData(p.fim):''}" x="${x(i)-espaco/2}" y="35" width="${espaco}" height="${base-35}"/>`;});
  grafico.innerHTML=svg+'</svg>';
  inspecionarPontoGrafico(serie.length-1);
  document.getElementById('grafico-detalhes').innerHTML=`<table><thead><tr><th>Período atual</th><th>Entregas</th><th>Valor pago</th><th>TM</th></tr></thead><tbody>${serie.map(p=>`<tr><td>${fmtData(p.data)}${passo>1?' → '+fmtData(p.fim):''}</td><td>${p.temDados?p.entrega:'—'}</td><td>${p.temDados?fmtMoney(p.valor):'—'}</td><td>${p.tm!=null?fmtMoney(p.tm):'—'}</td></tr>`).join('')}</tbody></table>`;
}

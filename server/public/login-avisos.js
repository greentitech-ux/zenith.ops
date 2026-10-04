(function(){
  'use strict';
  if(window.__nopulsoAvisosLogin || !window.zenithAoVivo) return;
  window.__nopulsoAvisosLogin=true;
  var vistos=new Set();
  function mostrar(d){
    if(!d || !d.id || vistos.has(d.id)) return;
    vistos.add(d.id);if(vistos.size>100) vistos.delete(vistos.values().next().value);
    var area=document.getElementById('nopulso-entradas');
    if(!area){
      area=document.createElement('div');area.id='nopulso-entradas';
      area.setAttribute('aria-live','polite');area.setAttribute('aria-label','Entradas no sistema');
      area.style.cssText='position:fixed;right:12px;top:76px;width:330px;max-width:calc(100vw - 24px);z-index:9500;display:grid;gap:8px;';
      document.body.appendChild(area);
    }
    while(area.children.length>=3) area.firstElementChild.remove();
    var card=document.createElement('div');card.setAttribute('role','status');
    card.style.cssText='background:var(--panel,#12161b);color:var(--text,#e7ecf1);border:1px solid var(--line,#232a33);border-left:3px solid var(--accent,#b8ff3c);border-radius:12px;padding:12px;box-shadow:0 8px 24px rgba(0,0,0,.25);font-family:var(--sans,sans-serif);overflow-wrap:anywhere;';
    var fechar=document.createElement('button');fechar.type='button';fechar.textContent='×';fechar.setAttribute('aria-label','Fechar aviso de entrada');
    fechar.style.cssText='float:right;margin-left:8px;border:0;background:transparent;color:var(--muted,#7d8896);font-size:20px;cursor:pointer;';
    fechar.onclick=function(){card.remove();};card.appendChild(fechar);
    var titulo=document.createElement('div');titulo.textContent='Usuário entrou no sistema';titulo.style.cssText='font-size:12px;color:var(--accent,#b8ff3c);margin-bottom:5px;';card.appendChild(titulo);
    var nome=document.createElement('div');nome.textContent=String(d.nome||'Usuário').slice(0,160);nome.style.cssText='font-size:14px;font-weight:700;';card.appendChild(nome);
    var detalhe=document.createElement('div');
    detalhe.textContent=[d.unidade,d.computador].filter(Boolean).join(' · ') || 'Dispositivo não identificado pelo NOC';
    detalhe.style.cssText='font-size:12px;color:var(--muted,#7d8896);margin-top:5px;';card.appendChild(detalhe);
    var hora=document.createElement('div');hora.textContent=new Date(d.em).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});hora.style.cssText='font-size:11px;color:var(--muted,#7d8896);margin-top:5px;';card.appendChild(hora);
    area.appendChild(card);setTimeout(function(){card.remove();},10000);
  }
  // O servidor entrega este evento exclusivamente ao Master principal.
  window.zenithAoVivo(['usuario-entrou'],mostrar,{imediato:true});
})();

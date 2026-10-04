(function(){
  'use strict';
  let emCurso;
  window.validarMaquinaNoc = function(){
    if (emCurso) return emCurso;
    emCurso=(async()=>{
      const controle=new AbortController();
      const timeout=window.setTimeout(()=>controle.abort(),12000);
      try {
        const r=await fetch('/api/noc-login/desafio',{method:'POST',signal:controle.signal});
        if(!r.ok) return false;
        const {desafio}=await r.json();
        const local=await fetch('http://127.0.0.1:17841/validar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({desafio}),signal:controle.signal,credentials:'omit',cache:'no-store'});
        if(!local.ok) return false;
        const prova=await local.json();
        const fim=await fetch('/api/noc-login/automatico',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...prova,desafio}),signal:controle.signal});
        return fim.ok;
      } catch(e) { return false; } finally {window.clearTimeout(timeout);}
    })().finally(()=>{emCurso=null;});
    return emCurso;
  };
})();

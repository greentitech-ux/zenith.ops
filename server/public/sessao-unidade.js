// A conta da unidade vive em cookie HttpOnly. Este arquivo só administra a
// alternância visual e o relógio humano da sessão pessoal neste terminal.
(function () {
  if(window.NoPulsoUnidade) return;
  const rawFetch=window.fetch.bind(window), CHAVE='nopulso.unidade', ATIVIDADE='nopulso.unidade.atividade';
  const ler=chave=>{try{return JSON.parse(localStorage.getItem(chave)||'null');}catch{return null;}};
  const token=()=>localStorage.getItem('authToken');
  const sid=t=>{try{return JSON.parse(atob(t.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).sid;}catch{return null;}};
  let saindo=false, ultimoEnvio=0;
  function login(t) {
    if(!ler(CHAVE) || !sid(t)) return;
    localStorage.setItem(ATIVIDADE,JSON.stringify({sid:sid(t),em:Date.now()}));
  }
  async function voltar() {
    if(saindo) return;
    saindo=true;
    const t=token();
    localStorage.removeItem('authToken');
    localStorage.removeItem(ATIVIDADE);
    // Rascunhos da conta pessoal não ficam visíveis para o próximo operador.
    sessionStorage.clear();
    if(t) rawFetch('/api/auth/sair',{method:'POST',headers:{Authorization:'Bearer '+t},keepalive:true}).catch(()=>{});
    location.replace('/unidade');
  }
  function venceu() {
    const u=ler(CHAVE), t=token(), a=ler(ATIVIDADE);
    if(!u || !t) return false;
    return !a || a.sid!==sid(t) || Date.now()-a.em >= (u.inatividadeMinutos||5)*60000;
  }
  function verificar() {
    if(venceu()) {voltar();return false;}
    if(ler(CHAVE) && !token() && !['/','/index','/index.html','/unidade','/unidade.html'].includes(location.pathname)) {voltar();return false;}
    return true;
  }
  function atividade(e) {
    if(!e.isTrusted || !verificar() || !ler(CHAVE) || !token()) return;
    const t=token();
    localStorage.setItem(ATIVIDADE,JSON.stringify({sid:sid(t),em:Date.now()}));
    if(Date.now()-ultimoEnvio<30000) return;
    ultimoEnvio=Date.now();
    rawFetch('/api/auth/atividade',{method:'POST',headers:{Authorization:'Bearer '+t}})
      .then(r=>{if(r.status===401) voltar();}).catch(()=>{});
  }
  window.NoPulsoUnidade={login,voltar,verificar};
  ['pointerdown','keydown','mousemove','scroll'].forEach(nome=>document.addEventListener(nome,atividade,{capture:true,passive:true}));
  window.addEventListener('focus',verificar);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden) verificar();});
  window.addEventListener('storage',()=>{if(!token() && ler(CHAVE) && !location.pathname.startsWith('/unidade')) voltar();else verificar();});
  setInterval(verificar,1000);
  if(!verificar()) return;
  async function iniciar() {
    // O marcador local não concede acesso; o servidor valida a tag e o cookie.
    if(!ler(CHAVE)) return;
    try {
      const r=await rawFetch('/api/acesso-unidade/sessao',{cache:'no-store'});
      if(r.status===401){localStorage.removeItem(CHAVE);if(token()) voltar();return;}
      if(!r.ok) return;
      const unidade=await r.json();
      localStorage.setItem(CHAVE,JSON.stringify(unidade));
      if(!token() && location.pathname==='/' && !new URLSearchParams(location.search).has('pessoal')) {location.replace('/unidade');return;}
      if(location.pathname.startsWith('/unidade')) return;
      const barra=document.createElement('div');
      barra.style.cssText='padding:8px 12px;background:var(--panel,#12161b);color:var(--text,#e7ecf1);border-bottom:1px solid var(--line,#232a33);font:12px Archivo,sans-serif;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap';
      const texto=document.createElement('span');
      texto.textContent=unidade.nome+' · Computador compartilhado'+(token()?' · Retorno ao chat após '+unidade.inatividadeMinutos+' min sem atividade':'');
      const botao=document.createElement('button');botao.type='button';botao.textContent='Voltar ao chat da unidade';botao.onclick=voltar;
      barra.append(texto,botao);document.body.prepend(barra);
    } catch {} // falha de rede não remove o vínculo salvo
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',iniciar);else iniciar();
})();

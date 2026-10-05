'use strict';
(function(){
  const form=document.getElementById('portal-login'), erro=document.getElementById('portal-erro');
  const avisar=t=>{erro.textContent=t;erro.hidden=false;};
  async function requisicaoComNoc(url,opcoes) {
    let r=await fetch(url,opcoes);
    if(r.status===403) {
      const d=await r.clone().json().catch(()=>({}));
      if(d.code==='COMPUTADOR_NOC_OBRIGATORIO' && window.validarMaquinaNoc && await window.validarMaquinaNoc()) r=await fetch(url,opcoes);
    }
    return r;
  }
  async function entrarCentral(token,salvar=false) {
    const headers={Authorization:'Bearer '+token};
    const r=await requisicaoComNoc('/api/beniboy/acesso',{headers});
    const d=await r.json();
    if(!r.ok) throw new Error(d.error || 'Não foi possível validar seu acesso. Entre novamente.');
    if(!d.permitido) throw new Error('A Central é exclusiva para Master e usuários com cargo Suporte ou Técnico. Você pode iniciar um atendimento sem login.');
    if(salvar) localStorage.setItem('authToken',token);
    location.href='/atendimento/central';
  }
  form.addEventListener('submit',async e=>{
    e.preventDefault();erro.hidden=true;
    const botao=document.getElementById('portal-entrar');botao.disabled=true;
    try {
      const salvo=localStorage.getItem('authToken');
      if(salvo && !form.elements.identifier.value && !form.elements.password.value){await entrarCentral(salvo);return;}
      const r=await requisicaoComNoc('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identifier:form.elements.identifier.value,password:form.elements.password.value})});
      const d=await r.json();
      if(!r.ok) throw new Error(d.error || 'Não foi possível entrar.');
      // Não pula a preparação obrigatória da conta nem a política de máquina NOC.
      if(d.user?.precisaTrocarSenha || !d.user?.temPalavraRecuperacao) throw new Error('Conclua a troca de senha/palavra de recuperação no acesso normal do NoPulso antes de entrar na Central.');
      await entrarCentral(d.token,true);
    } catch(e){avisar(e.message);} finally {botao.disabled=false;form.elements.password.value='';}
  });
  document.getElementById('portal-anonimo').addEventListener('click',()=>window.abrirChatPublicoBeniboy());
  const marca=document.getElementById('portal-marca');
  if(window.beniboySVG) marca.innerHTML=window.beniboySVG(64);
  if(localStorage.getItem('authToken')) document.getElementById('portal-entrar').textContent='Entrar na Central com meu acesso';
})();

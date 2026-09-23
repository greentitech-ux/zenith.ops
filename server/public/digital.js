// digital.js — CONFIRMAR COM A DIGITAL no lugar da senha.
//
// Master, 23/09/2026: "quando for preciso colocar a senha por algum motivo e
// estiver no mobile, dá a opção de digital".
//
// Todo campo de senha de CONFIRMAÇÃO (não o de login, não o de trocar senha)
// que tiver `data-digital` ganha, logo abaixo, o botão "👆 Usar a digital". O
// botão pede ao aparelho que assine um desafio com a credencial deste acesso
// (a mesma cadastrada no login, ver passkeys.js) e recebe do servidor um
// COMPROVANTE que vale como a senha por 3 minutos, só pra quem o tirou. O
// comprovante vai pro próprio campo de senha - a tela e a rota seguem iguais,
// e a senha digitada continua valendo sempre.
//
//   data-digital                    liga o botão neste campo
//   data-digital-enviar="id-botao"  depois da digital, clica nesse botão
//                                   (use quando o campo de senha é a última
//                                   coisa do modal; em formulário com outros
//                                   campos, deixe a pessoa enviar)
//
// O botão só aparece se o aparelho tiver biometria de plataforma E o acesso
// tiver credencial cadastrada neste mesmo sistema. A pergunta ao servidor é
// feita quando um campo de senha APARECE na tela, não quando a página carrega
// (CLAUDE.md §3: é uma consulta ao Firestore).
(function(){
  if(window.__nopulsoDigital) return;
  window.__nopulsoDigital = true;

  // base64url na mão, como no index.html: são quatro linhas, e é o formato
  // que o WebAuthn usa em tudo
  function b64urlParaBytes(txt){
    const b64 = String(txt||'').replace(/-/g,'+').replace(/_/g,'/');
    const bin = atob(b64 + '='.repeat((4 - b64.length % 4) % 4));
    const out = new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesParaB64url(buf){
    let bin = '';
    const bytes = new Uint8Array(buf);
    for(let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  function cabecalhos(){
    const h = { 'Content-Type':'application/json' };
    try{ const t = localStorage.getItem('authToken'); if(t) h.Authorization = 'Bearer ' + t; }catch(e){}
    return h;
  }

  // Uma resposta por página (e por aba, 10 min): abrir o modal de senha dez
  // vezes não custa dez consultas
  const CHAVE_CACHE = 'digitalDisponivel';
  let disponivelPromessa = null;
  function disponivel(){
    if(disponivelPromessa) return disponivelPromessa;
    disponivelPromessa = (async () => {
      if(!window.PublicKeyCredential || !window.isSecureContext || !navigator.credentials) return false;
      if(!(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())) return false;
      let token = '';
      try{ token = localStorage.getItem('authToken') || ''; }catch(e){}
      if(!token) return false;
      const dono = token.slice(-16); // outro login na mesma aba = outra resposta
      try{
        const c = JSON.parse(sessionStorage.getItem(CHAVE_CACHE) || 'null');
        if(c && c.dono === dono && c.ate > Date.now()) return !!c.valor;
      }catch(e){}
      const r = await fetch('/api/auth/passkey/confirmar/disponivel', { headers: cabecalhos() });
      if(!r.ok) return false;
      const valor = !!(await r.json()).disponivel;
      try{ sessionStorage.setItem(CHAVE_CACHE, JSON.stringify({ dono, valor, ate: Date.now() + 10*60*1000 })); }catch(e){}
      return valor;
    })().catch(() => false);
    return disponivelPromessa;
  }

  async function confirmarComDigital(){
    const r1 = await fetch('/api/auth/passkey/confirmar/inicio', { method:'POST', headers: cabecalhos(), body:'{}' });
    const d1 = await r1.json().catch(() => ({}));
    if(!r1.ok) throw new Error(d1.error || 'Não consegui começar. Use a senha.');
    const o = d1.opcoes;
    const publicKey = { ...o, challenge: b64urlParaBytes(o.challenge) };
    if(o.allowCredentials) publicKey.allowCredentials = o.allowCredentials.map(c => ({ ...c, id: b64urlParaBytes(c.id) }));
    const cred = await navigator.credentials.get({ publicKey });
    if(!cred) throw new Error('A digital não respondeu. Use a senha.');
    const r = cred.response;
    const resposta = {
      id: cred.id, rawId: bytesParaB64url(cred.rawId), type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
      response: {
        clientDataJSON: bytesParaB64url(r.clientDataJSON),
        authenticatorData: bytesParaB64url(r.authenticatorData),
        signature: bytesParaB64url(r.signature),
        userHandle: r.userHandle ? bytesParaB64url(r.userHandle) : null,
      },
    };
    const r2 = await fetch('/api/auth/passkey/confirmar/fim', {
      method:'POST', headers: cabecalhos(), body: JSON.stringify({ chave: d1.chave, resposta }),
    });
    const d2 = await r2.json().catch(() => ({}));
    if(!r2.ok || !d2.confirmacao) throw new Error(d2.error || 'Não consegui confirmar a digital. Use a senha.');
    return d2;
  }

  const ROTULO = '👆 Usar a digital';
  function montar(input){
    if(input.__digital) return;
    input.__digital = true;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nopulso-digital';
    btn.textContent = ROTULO;
    btn.title = 'Confirma com a digital ou o rosto deste aparelho, no lugar da senha';
    btn.style.cssText = 'display:none;margin:6px 0 4px;padding:8px 12px;border-radius:8px;border:1px solid var(--accent);'
      + 'background:transparent;color:var(--accent);font:inherit;font-size:13px;font-weight:600;cursor:pointer;max-width:100%;';
    const msg = document.createElement('div');
    msg.className = 'nopulso-digital-msg';
    msg.style.cssText = 'display:none;font-size:11.5px;color:var(--bad);margin:2px 0 4px;';
    input.insertAdjacentElement('afterend', btn);
    btn.insertAdjacentElement('afterend', msg);

    let comprovante = null, vence = null;
    const voltar = (texto) => {
      comprovante = null; clearTimeout(vence);
      btn.disabled = false; btn.textContent = ROTULO;
      if(texto){ msg.textContent = texto; msg.style.display = 'block'; } else msg.style.display = 'none';
    };
    // digitou por cima, ou o modal limpou o campo ao reabrir: o botão volta
    input.addEventListener('input', () => { if(comprovante && input.value !== comprovante) voltar(); });

    btn.addEventListener('click', async () => {
      msg.style.display = 'none';
      btn.disabled = true; btn.textContent = 'Toque no sensor…';
      try{
        const d = await confirmarComDigital();
        comprovante = d.confirmacao;
        input.value = comprovante;
        btn.textContent = '✓ Digital confirmada';
        // perto de vencer, some do campo: melhor pedir de novo do que a
        // rota responder "Senha incorreta" sem ninguém entender por quê
        clearTimeout(vence);
        vence = setTimeout(() => {
          if(input.value === comprovante) input.value = '';
          voltar('A confirmação pela digital venceu. Toque de novo ou digite a senha.');
        }, Math.max(10000, Number(d.validadeMs || 180000) - 10000));
        const alvo = input.dataset.digitalEnviar && document.getElementById(input.dataset.digitalEnviar);
        if(alvo) alvo.click();
      }catch(err){
        // cancelar o sensor não é erro: a pessoa só desistiu
        if(err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) return voltar();
        voltar(err && err.message ? err.message : 'Não consegui confirmar a digital. Use a senha.');
      }
    });

    // pergunta ao servidor só quando o campo aparece; e a cada vez que o
    // modal reabre, o botão volta ao normal se o campo foi limpo
    const mostrar = () => disponivel().then((ok) => {
      if(!ok) return;
      btn.style.display = 'inline-block';
      if(comprovante && input.value !== comprovante) voltar();
    });
    if('IntersectionObserver' in window){
      new IntersectionObserver((entradas) => {
        if(entradas.some(e => e.isIntersecting)) mostrar();
      }).observe(input);
    } else {
      input.addEventListener('focus', mostrar);
    }
  }

  function varrer(){
    document.querySelectorAll('input[type="password"][data-digital]').forEach(montar);
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', varrer);
  else varrer();
  window.nopulsoDigital = { varrer, disponivel, confirmarComDigital };
})();

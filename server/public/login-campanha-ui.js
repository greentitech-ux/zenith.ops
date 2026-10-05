(function(){
  'use strict';
  const tela = document.getElementById('auth-screen');
  if(!tela || !window.loginCampanha) return;
  const titulo = document.getElementById('login-bubble-titulo');
  const texto = document.getElementById('login-bubble-texto');
  const originais = [titulo.textContent, texto.textContent];
  let config = {}, timer, baseServidor = Date.now(), baseLocal = performance.now();
  function agora(){ return baseServidor + performance.now() - baseLocal; }
  function render(tempo = agora()){
    const c = window.loginCampanha.efetiva(config, tempo);
    tela.classList.toggle('outubro-rosa', c.rosaAtiva);
    tela.classList.toggle('login-ampliado', !c.campanhaExpirada && c.tamanhoLogin === 'ampliado');
    tela.style.backgroundPosition = c.fundoPosicao;
    titulo.textContent = c.ativo && c.bubbleTitulo ? c.bubbleTitulo : c.rosaAtiva ? 'Outubro Rosa: cuidado que acolhe 🎀' : originais[0];
    texto.textContent = c.ativo && c.bubbleTexto ? c.bubbleTexto : c.rosaAtiva ? 'Neste Outubro Rosa, o NoPulso se veste de carinho e esperança. Juntos na conscientização sobre o câncer de mama, acolhendo quem enfrenta essa jornada e quem caminha ao seu lado. 💗' : originais[1];
    tela.style.removeProperty('--login-fundo-desktop');
    tela.style.removeProperty('--login-fundo-mobile');
    const v = encodeURIComponent(c.atualizadoEm || '');
    if(c.temFundo) tela.style.setProperty('--login-fundo-desktop', `url(/api/login-custom/fundo?v=${v})`);
    else if(c.rosaAtiva) tela.style.setProperty('--login-fundo-desktop', 'url(/branding/outubro-rosa-login-2026-v1.png)');
    if(c.temFundoMobile) tela.style.setProperty('--login-fundo-mobile', `url(/api/login-custom/fundo?mobile=1&v=${v})`);
    else if(c.rosaAtiva) tela.style.setProperty('--login-fundo-mobile', 'url(/branding/outubro-rosa-login-mobile-2026-v1.png)');
    tela.classList.toggle('tem-fundo', !!(c.temFundo || c.temFundoMobile || c.rosaAtiva));
    clearTimeout(timer);
    const falta = Date.parse(c.campanhaFim) - tempo;
    // Só relógio local: nenhuma consulta ou escrita adicional no Firestore.
    if(c.campanhaRosa && falta > 0) timer = setTimeout(render, Math.min(falta, 86400000));
    return c;
  }
  window.aplicarLoginCampanha = function(nova){
    config = nova || {};
    const servidor = Date.parse(config.servidorAgora);
    baseServidor = Number.isFinite(servidor) ? servidor : Date.now();
    baseLocal = performance.now();
    render();
  };
  window.addEventListener('focus', () => render());
  document.addEventListener('visibilitychange', () => { if(!document.hidden) render(); });
  window.aplicarLoginCampanha({});
})();

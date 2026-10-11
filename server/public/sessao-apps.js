'use strict';
(function () {
  const habilitado = location.protocol === 'https:' && ['nopulso.com.br', 'www.nopulso.com.br', 'atendimento.nopulso.com.br'].includes(location.hostname);
  const requisitar = window.NoPulsoSessao?.requisitar || window.fetch.bind(window);
  const tokenAtual = () => localStorage.getItem('authToken');
  const entrada = () => location.hostname === 'atendimento.nopulso.com.br' ? '/atendimento/entrar' : '/';
  let saindo = false, consulta = null;
  async function restaurar() {
    if (!habilitado || saindo) return tokenAtual();
    if (consulta) return consulta;
    consulta = (async () => {
      const anterior = tokenAtual();
      try {
        const r = await requisitar('/api/auth/sessao-apps', {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'Content-Type': 'application/json', ...(anterior ? { Authorization: 'Bearer ' + anterior } : {}) },
          body: JSON.stringify({ migrar: localStorage.getItem('nopulso.sessaoAppsV1') !== '1' }),
          signal: AbortSignal.timeout(8000),
        });
        if (saindo || tokenAtual() !== anterior) return tokenAtual();
        if (r.status === 401) {
          localStorage.removeItem('authToken');
          return null;
        }
        if (!r.ok) return anterior; // falha de rede não encerra uma sessão válida
        const d = await r.json();
        if (!d.token || saindo || tokenAtual() !== anterior) return tokenAtual();
        localStorage.setItem('authToken', d.token);
        localStorage.setItem('nopulso.sessaoAppsV1', '1');
        return d.token;
      } catch (_) { return anterior; }
    })();
    try { return await consulta; } finally { consulta = null; }
  }
  async function sair(destino = entrada()) {
    if (saindo) return;
    saindo = true;
    try {
      if (habilitado) {
        const token = tokenAtual();
        const r = await requisitar('/api/auth/sair', {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: token ? { Authorization: 'Bearer ' + token } : {},
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) throw new Error('Não foi possível sair dos dois apps. Tente novamente.');
      }
      localStorage.removeItem('authToken');
      location.replace(destino);
    } catch (_) {
      saindo = false;
      alert('Não foi possível encerrar a sessão nos dois apps. Confira a conexão e tente Sair novamente.');
    }
  }
  // As telas legadas já chamam logout(). Centraliza a revogação sem mudar
  // dezenas de formulários, e sem interceptar Storage.prototype.
  function conectarSaida() {
    if (habilitado && typeof window.logout === 'function') window.logout = () => sair();
  }
  window.NoPulsoSessao = { habilitado, restaurar, sair };
  conectarSaida();
  document.addEventListener('DOMContentLoaded', conectarSaida, { once: true });
  const telaEntrada = ['/', '/index', '/index.html', '/atendimento', '/atendimento.html', '/atendimento/entrar'].includes(location.pathname);
  if (!telaEntrada && tokenAtual()) {
    const anterior = tokenAtual();
    restaurar().then(token => { if (!saindo && token !== anterior) location.replace(entrada()); });
  }
  document.addEventListener('visibilitychange', () => {
    if (telaEntrada || document.hidden || saindo || !tokenAtual()) return;
    const anterior = tokenAtual();
    restaurar().then(token => { if (!saindo && token !== anterior) location.replace(entrada()); });
  });
})();
